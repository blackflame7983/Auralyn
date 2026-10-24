import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { liveModesApi } from '../../api/liveModes';
import { presetApi, type ApplyProfileSummary, type PresetPlugin } from '../../api/presets';
import type { Plugin } from '../../components/features/PluginRack/PluginCard';
import { usePluginProfiles } from '../usePluginProfiles';
import { bundleApi, type BundleResult } from '../../api/bundles';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const saved: PresetPlugin = { path: 'new', name: 'New', vendor: '', version: '', enabled: false, muted: true, gain: 0.5, state: 'saved' };
const plugin = (id: string): Plugin => ({ ...saved, id, path: id, enabled: true, muted: false, gain: 1, hasEditor: true });
function useFixture(initial: Plugin[] = []) {
    const [plugins, setPlugins] = useState(initial);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    return { ...usePluginProfiles(plugins, setPlugins, setLoading, setError), plugins, loading, error };
}
beforeEach(() => {
    vi.spyOn(liveModesApi, 'preflight').mockResolvedValue(undefined);
    vi.spyOn(liveModesApi, 'beginChanges').mockResolvedValue('batch1');
    vi.spyOn(liveModesApi, 'endChanges').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'loadPlugin').mockImplementation(async path => path);
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setMute').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setPluginState').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('captured');
    vi.spyOn(presetApi, 'load').mockResolvedValue({ name: 'preset', plugins: [saved] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('配信状態はbackendの予約に任せ、空ラックの実結果へ同期しpartialを成功扱いにしない', async () => {
    const response: BundleResult = { id: 'bundle1', complete: false, undoPending: true, auralyn: 'partial', obs: [], summary: { appliedCategories: ['plugins'], skippedCategories: [], missingDevices: [], missingPlugins: [], needsEngineRestart: false, loadedPluginInstances: [] } };
    vi.spyOn(bundleApi, 'operation').mockResolvedValue(response);
    const { result } = renderHook(() => useFixture([plugin('original')]));
    await act(async () => { expect(await result.current.runBundle({ action: 'apply', id: 'bundle1' })).toEqual(response); });
    expect(result.current.plugins).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain('未完了');
    expect(liveModesApi.beginChanges).not.toHaveBeenCalled();
    expect(liveModesApi.endChanges).not.toHaveBeenCalled();
});
const bundleControls = (): ApplyProfileSummary => ({
    appliedCategories: ['plugins'], skippedCategories: [], missingDevices: [], missingPlugins: [], needsEngineRestart: false,
    loadedPluginInstances: [{...saved, id: 'actual-rack'}],
    appliedAudioConfig: {host: 'WASAPI', inputDevice: 'hypothetical-input', outputDevice: 'hypothetical-output', sampleRate: 48000, bufferSize: 512, inputChannels: [0,1], inputGainDb: -6, masterGainDb: -12},
    appliedNoiseControl: {enabled: true, mode: 'smart', strength: 0.9, voiceGuard: true},
    appliedBuiltinFx: {enabled: true, preset: 'bright', amount: 1},
});
function preserveRawAudioPrefs() {
    const audio = '{ "host" : "ASIO", "sampleRate":96000,"bufferSize":512, "custom": true }';
    localStorage.setItem('vst_host_audio_config', audio);
    localStorage.setItem('vst_host_input_gain', '83');
    localStorage.setItem('vst_host_output_gain', '71');
    return () => {
        expect(localStorage.getItem('vst_host_audio_config')).toBe(audio);
        expect(localStorage.getItem('vst_host_input_gain')).toBe('83');
        expect(localStorage.getItem('vst_host_output_gain')).toBe('71');
    };
}
it.each(['apply', 'undo'] as const)('NR-only complete %sは実ラックと確認済みNRだけ同期し、audio原文とgainを保持する', async action => {
    const unchanged = preserveRawAudioPrefs();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const summary = {...bundleControls(), appliedCategories: ['noiseControl'], appliedNoiseControl: {enabled: false, mode: 'smart', strength: 0.3, voiceGuard: true}};
    vi.spyOn(bundleApi, 'operation').mockResolvedValue({id: 'nr-only', complete: true, undoPending: true, auralyn: 'confirmed', obs: [], current: bundleControls(), summary});
    const {result} = renderHook(() => useFixture([plugin('original')]));
    await act(async () => { await result.current.runBundle({action, id: 'nr-only'}); });
    unchanged();
    expect(result.current.plugins).toEqual([expect.objectContaining({id: 'actual-rack', enabled: false, muted: true, gain: 0.5})]);
    const events = dispatch.mock.calls.map(([event]) => event);
    expect(events.filter(event => event.type === 'input-gain-sync' || event.type === 'profile-audio-applied')).toHaveLength(0);
    const fx = events.filter(event => event.type === 'profile-fx-applied') as CustomEvent[];
    expect(fx).toHaveLength(1);
    expect(fx[0].detail).toEqual({noiseControl: summary.appliedNoiseControl, builtinFx: undefined});
});
it('partial/currentの仮control値はprefsやFXへ保存せず、実ラック表示だけを同期する', async () => {
    const unchanged = preserveRawAudioPrefs();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    vi.spyOn(bundleApi, 'operation').mockResolvedValue({id: 'unknown', complete: false, undoPending: true, auralyn: 'unknown', obs: [], current: bundleControls(), summary: {...bundleControls(), appliedCategories: ['audioConfig', 'noiseControl', 'builtinFx']}});
    const {result} = renderHook(() => useFixture([plugin('original')]));
    await act(async () => { await result.current.runBundle({action: 'apply', id: 'unknown'}); });
    unchanged();
    expect(result.current.plugins[0].id).toBe('actual-rack');
    expect(dispatch.mock.calls.map(([event]) => event.type).filter(type => ['profile-audio-applied', 'input-gain-sync', 'profile-fx-applied'].includes(type))).toEqual([]);
    expect(result.current.error).toContain('未完了');
});
it('配信状態の古い世代応答はラックへ入れず、返却された所有IDを既存接続だけで回収する', async () => {
    let generation = 1;
    let finish!: (result: BundleResult) => void;
    vi.spyOn(bundleApi, 'operation').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => {
        const [plugins, setPlugins] = useState([plugin('original')]);
        const [, setLoading] = useState(false);
        const [, setError] = useState<string | null>(null);
        return { ...usePluginProfiles(plugins, setPlugins, setLoading, setError, () => generation), plugins };
    });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.runBundle({ action: 'apply', id: 'bundle1' }); });
    generation = 2;
    await act(async () => { finish({ id: 'bundle1', complete: true, undoPending: true, auralyn: 'done', obs: [], summary: { appliedCategories: ['plugins'], skippedCategories: [], missingDevices: [], missingPlugins: [], needsEngineRestart: false, loadedPluginInstances: [{ ...saved, id: 'late-owned' }] } }); await pending; });
    expect(result.current.plugins[0].id).toBe('original');
    expect(audioApi.removePlugin).toHaveBeenCalledWith('late-owned');
    expect(audioApi.loadPlugin).not.toHaveBeenCalled();
});
it('本番保護のpreflight拒否時は保存状態取得・preset読込・削除・復元を始めない', async () => {
    vi.mocked(liveModesApi.preflight).mockRejectedValue('本番保護中');
    const { result } = renderHook(() => useFixture([plugin('original')]));
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    await act(async () => { expect(await result.current.applyProfile('preset')).toBeNull(); });
    await act(async () => { expect(await result.current.restoreBackupProfile()).toBeNull(); });
    expect(presetApi.load).not.toHaveBeenCalled();
    expect(audioApi.getPluginState).not.toHaveBeenCalled();
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(audioApi.restorePlugin).not.toHaveBeenCalled();
    expect(result.current.plugins.map(value => value.id)).toEqual(['original']);
});
it('構成batch開始拒否では原本・ラックを変更せず、失敗した復元も自分のtokenだけfinally終了する', async () => {
    vi.mocked(liveModesApi.beginChanges).mockRejectedValueOnce('busy');
    const { result } = renderHook(() => useFixture([plugin('original')]));
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(presetApi.load).not.toHaveBeenCalled();
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(liveModesApi.endChanges).not.toHaveBeenCalled();
    vi.mocked(presetApi.load).mockRejectedValueOnce('broken');
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(liveModesApi.endChanges).toHaveBeenCalledExactlyOnceWith('batch1');
    expect(result.current.plugins.map(value => value.id)).toEqual(['original']);
});

it('一括復元失敗は未完成VSTを表示せず、分割APIへfallbackしない', async () => {
    vi.mocked(audioApi.restorePlugin).mockRejectedValue(new Error('failed'));
    const { result } = renderHook(() => useFixture());
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(audioApi.loadPlugin).not.toHaveBeenCalled();
    expect(audioApi.setPluginState).not.toHaveBeenCalled();
    expect(result.current.plugins).toEqual([]);
    expect(result.current.error).toMatch(/復元できませんでした/);
    expect(result.current.loading).toBe(false);
});

it('旧ラックの削除途中で失敗したら、削除できた項目だけ表示から取り除く', async () => {
    vi.mocked(audioApi.removePlugin).mockImplementation(async id => { if (id === 'old-2') throw new Error('remove failed'); });
    const { result } = renderHook(() => useFixture([plugin('old-1'), plugin('old-2')]));
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(result.current.plugins.map(p => p.id)).toEqual(['old-2']);
    expect(audioApi.restorePlugin).not.toHaveBeenCalled();
});

it('途中失敗では成功済みの項目だけ表示してpartialを返す', async () => {
    vi.mocked(presetApi.load).mockResolvedValue({ name: 'preset', plugins: [saved, { ...saved, path: 'bad' }] });
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => {
        if (request.path === 'bad') throw new Error('failed');
        return { id: request.path, name: request.path, prepared: false };
    });
    const { result } = renderHook(() => useFixture());
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(result.current.plugins).toEqual([expect.objectContaining({ id: 'new', enabled: false, muted: true, gain: 0.5 })]);
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(2);
});

it('正常な構成は保存状態まで復元し、成功を返す', async () => {
    const { result } = renderHook(() => useFixture([plugin('old')]));
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(true); });
    expect(result.current.plugins).toEqual([expect.objectContaining({ id: 'new', enabled: false, muted: true, gain: 0.5 })]);
    expect(audioApi.restorePlugin).toHaveBeenCalledWith({ path: 'new', state: 'saved', bypassed: true, muted: true, gain: 0.5 });
    expect(result.current.error).toBeNull();
});

it('状態取得に失敗したら、保存もバックアップを伴う構成置換も開始しない', async () => {
    vi.mocked(audioApi.getPluginState).mockRejectedValue(new Error('state unavailable'));
    const save = vi.spyOn(presetApi, 'save');
    const apply = vi.spyOn(presetApi, 'applyProfile');
    const restore = vi.spyOn(presetApi, 'restoreBackup');
    const { result } = renderHook(() => useFixture([plugin('old')]));
    await act(async () => {
        expect(await result.current.savePreset('preset')).toBe(false);
        expect(await result.current.applyProfile('profile')).toBeNull();
        expect(await result.current.restoreBackupProfile()).toBeNull();
    });
    expect(save).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
});


it('保存時の空文字stateを欠落へ変換せず保持する', async () => {
    vi.mocked(audioApi.getPluginState).mockResolvedValue('');
    const save = vi.spyOn(presetApi, 'save').mockResolvedValue(undefined);
    const { result } = renderHook(() => useFixture([plugin('old')]));
    await act(async () => { expect(await result.current.savePreset('empty-state')).toBe(true); });
    expect(save).toHaveBeenCalledWith('empty-state', [expect.objectContaining({ state: '' })]);
});

it('復元応答待ちの世代変更では返却IDを回収し、古い構成を表示しない', async () => {
    let generation = 0;
    let finish!: (value: { id: string; name: string; prepared: boolean }) => void;
    vi.mocked(audioApi.restorePlugin).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const progress = vi.fn(); const loading = vi.fn();
    const { result } = renderHook(() => usePluginProfiles([], progress, loading, vi.fn(), () => generation));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.loadPreset('preset'); });
    await act(async () => {});
    generation += 1;
    await act(async () => { finish({ id: 'late-id', name: 'New', prepared: true }); expect(await pending).toBe(false); });
    expect(audioApi.removePlugin).toHaveBeenCalledWith('late-id');
    expect(progress).not.toHaveBeenCalledWith([expect.objectContaining({ id: 'late-id' })]);
    expect(loading).not.toHaveBeenLastCalledWith(false);
});

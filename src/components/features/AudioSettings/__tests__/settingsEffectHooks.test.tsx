import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type ActiveAudioConfig } from '@/api/audio';
import { liveOutputApi, type LiveOutputStatus } from '@/api/liveOutput';
import { cancelLeave, registerLeaveGuard, requestLeave } from '@/components/layout/pageLeave';
import { useAudioPresets } from '../useAudioPresets';
import { useLiveOutputInUse } from '../useLiveOutputInUse';
import { useSavedConnection, useSavedRestoreAvailable } from '../useSavedConnection';
import { useAdvancedModePreference, useBeginnerModeSync, useSettingsLeaveGuard } from '../useSettingsPreferences';
import { useActiveSettingsTab, useSoundPlace } from '../useSettingsNavigation';

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); cancelLeave(); vi.restoreAllMocks(); localStorage.clear(); });

const savedConfig: ActiveAudioConfig = { host: 'WASAPI', input: 'mic', output: 'out', sample_rate: 48000, buffer_size: 512 };

it('保存済みの接続が無いときだけ、エンジン側の復帰先を調べる', async () => {
    const read = vi.spyOn(audioApi, 'getSavedAudioConfig').mockResolvedValue(savedConfig);
    const { result, rerender } = renderHook(({ needed }) => useSavedRestoreAvailable(needed), { initialProps: { needed: false } });
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
    rerender({ needed: true });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ needed: false });
    expect(result.current).toBe(false);
});

it('調べている間に条件が外れたら、遅れて届いた古い応答を捨てる', async () => {
    const late = deferred<ActiveAudioConfig | null>();
    vi.spyOn(audioApi, 'getSavedAudioConfig').mockReturnValue(late.promise);
    const { result, rerender } = renderHook(({ needed }) => useSavedRestoreAvailable(needed), { initialProps: { needed: true } });
    rerender({ needed: false });
    await act(async () => { late.resolve(savedConfig); await late.promise; });
    expect(result.current).toBe(false);
});

it('復帰先が無い・読めない・形が不正なときは、復帰できると案内しない', async () => {
    const read = vi.spyOn(audioApi, 'getSavedAudioConfig');
    read.mockResolvedValueOnce(null);
    const none = renderHook(() => useSavedRestoreAvailable(true));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(none.result.current).toBe(false);
    read.mockRejectedValueOnce(new Error('読めない'));
    const failed = renderHook(() => useSavedRestoreAvailable(true));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(failed.result.current).toBe(false);
    read.mockResolvedValueOnce({ ...savedConfig, host: ' ' });
    const invalid = renderHook(() => useSavedRestoreAvailable(true));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(invalid.result.current).toBe(false);
});

const status = (deviceId: string | null): LiveOutputStatus => ({
    config: { deviceId, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null,
});

it('配信向けの出力は、音楽鑑賞のときだけ読み、既定から外れているときに真にする', async () => {
    const request = vi.spyOn(liveOutputApi, 'request').mockResolvedValue(status('dev'));
    const voice = renderHook(() => useLiveOutputInUse('voice'));
    await act(async () => { await Promise.resolve(); });
    expect(request).not.toHaveBeenCalled();
    expect(voice.result.current).toBe(false);
    const music = renderHook(() => useLiveOutputInUse('music'));
    await waitFor(() => expect(music.result.current).toBe(true));
    request.mockResolvedValue(status(null));
    const unchanged = renderHook(() => useLiveOutputInUse('music'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(unchanged.result.current).toBe(false);
});

it('配信向けの出力の読込が失敗しても、接続のページを壊さず偽にする', async () => {
    const first = vi.spyOn(liveOutputApi, 'request').mockResolvedValue(status('dev'));
    const { result, rerender } = renderHook(({ purpose }) => useLiveOutputInUse(purpose), { initialProps: { purpose: 'music' as 'music' | 'voice' } });
    await waitFor(() => expect(result.current).toBe(true));
    first.mockRejectedValue(new Error('失敗'));
    rerender({ purpose: 'voice' });
    rerender({ purpose: 'music' });
    await waitFor(() => expect(result.current).toBe(false));
    first.mockImplementation(() => { throw new Error('同期の失敗'); });
    rerender({ purpose: 'voice' });
    rerender({ purpose: 'music' });
    await waitFor(() => expect(first).toHaveBeenCalledTimes(3));
    expect(result.current).toBe(false);
});

it('配信向けの出力は、読込の途中で表示が変わったら古い応答を捨てる', async () => {
    const late = deferred<LiveOutputStatus>();
    vi.spyOn(liveOutputApi, 'request').mockReturnValue(late.promise);
    const { result, rerender } = renderHook(({ purpose }) => useLiveOutputInUse(purpose), { initialProps: { purpose: 'music' as 'music' | 'voice' } });
    rerender({ purpose: 'voice' });
    await act(async () => { late.resolve(status('dev')); await late.promise; });
    expect(result.current).toBe(false);
});

const input = (overrides: Partial<Parameters<typeof useSavedConnection>[0]> = {}) => ({
    isOpen: true, currentConfig: undefined, currentSampleRate: undefined, currentBufferSize: undefined, ...overrides,
});

it('保存済みの接続は現在の設定が優先で、無いときは保存先を読み、サンプルレートと大きさは現在値で上書きする', () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', sampleRate: 44100, bufferSize: 256, inputChannels: [0, 1] }));
    const stored = renderHook(() => useSavedConnection(input({ currentSampleRate: 96000 })));
    expect(stored.result.current).toMatchObject({ host: 'ASIO', sampleRate: 96000, bufferSize: 256 });
    const current = renderHook(() => useSavedConnection(input({ currentConfig: { host: 'WASAPI', sampleRate: 48000 }, currentBufferSize: 128 })));
    expect(current.result.current).toMatchObject({ host: 'WASAPI', sampleRate: 48000, bufferSize: 128 });
    localStorage.clear();
    const none = renderHook(() => useSavedConnection(input()));
    expect(none.result.current).toBeNull();
});

it('保存先は、開閉や現在の設定が変わるときだけ読み直し、同じ入力の描画では読み直さない', () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI' }));
    const { result, rerender } = renderHook((props: ReturnType<typeof input>) => useSavedConnection(props), { initialProps: input() });
    const first = result.current;
    expect(first?.host).toBe('WASAPI');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO' }));
    rerender(input());
    expect(result.current).toBe(first);
    rerender(input({ isOpen: false }));
    rerender(input({ isOpen: true }));
    expect(result.current?.host).toBe('ASIO');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI' }));
    rerender(input({ currentConfig: { host: '' } }));
    expect(result.current?.host).toBe('WASAPI');
});

it('現在値が NaN でも、同じ入力の描画で読み直しを繰り返さない', () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI' }));
    const { result, rerender } = renderHook((props: ReturnType<typeof input>) => useSavedConnection(props),
        { initialProps: input({ currentSampleRate: Number.NaN, currentBufferSize: Number.NaN }) });
    const first = result.current;
    rerender(input({ currentSampleRate: Number.NaN, currentBufferSize: Number.NaN }));
    expect(result.current).toBe(first);
});

it('詳しい調整の表示は保存済みの選びから始め、3択に無い大きさのときは開き、選びを保存する', () => {
    localStorage.setItem('vst_host_settings_advanced', 'true');
    const saved = renderHook(() => useAdvancedModePreference(true, 512));
    expect(saved.result.current[0]).toBe(true);
    localStorage.setItem('vst_host_settings_advanced', 'false');
    const { result, rerender } = renderHook(({ open, size }) => useAdvancedModePreference(open, size), { initialProps: { open: false, size: 300 } });
    expect(result.current[0]).toBe(false);
    rerender({ open: true, size: 300 });
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('vst_host_settings_advanced')).toBe('true');
    act(() => result.current[1](false));
    expect(localStorage.getItem('vst_host_settings_advanced')).toBe('false');
    rerender({ open: true, size: 512 });
    expect(result.current[0]).toBe(false);
});

it('かんたん表示の選びは、通知の値・storageの再読込に追従し、外した後は反応しない', () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    const { result, unmount } = renderHook(() => useBeginnerModeSync());
    expect(result.current).toBe(false);
    act(() => { window.dispatchEvent(new CustomEvent('vst_host_beginner_mode_changed', { detail: true })); });
    expect(result.current).toBe(true);
    act(() => { window.dispatchEvent(new CustomEvent('vst_host_beginner_mode_changed')); });
    expect(result.current).toBe(false);
    localStorage.setItem('vst_host_beginner_mode', 'true');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'vst_host_beginner_mode' })); });
    expect(result.current).toBe(true);
    unmount();
    act(() => { window.dispatchEvent(new CustomEvent('vst_host_beginner_mode_changed', { detail: false })); });
    expect(result.current).toBe(true);
});

const guardState = { isApplying: false, activeTab: 'audio', hasConnectionChanges: false, shortcutsDirty: false, protectionPending: false };
const leaves = () => { const apply = vi.fn(); requestLeave(apply); return apply; };

it('適用中は離れる操作を止め、未保存の下書きがある区分では確認へ回す', () => {
    const { rerender } = renderHook((state: typeof guardState) => useSettingsLeaveGuard(state), { initialProps: guardState });
    expect(leaves()).toHaveBeenCalledTimes(1);
    rerender({ ...guardState, isApplying: true });
    expect(leaves()).not.toHaveBeenCalled();
    rerender({ ...guardState, hasConnectionChanges: true });
    expect(leaves()).not.toHaveBeenCalled();
    rerender({ ...guardState, activeTab: 'obs', hasConnectionChanges: true });
    expect(leaves()).toHaveBeenCalledTimes(1);
    rerender({ ...guardState, activeTab: 'shortcuts', shortcutsDirty: true });
    expect(leaves()).not.toHaveBeenCalled();
    rerender({ ...guardState, activeTab: 'sound', protectionPending: true });
    expect(leaves()).not.toHaveBeenCalled();
});

it('離れる確認は、ページを閉じたら外れて、別の入口の登録は消さない', () => {
    const { unmount } = renderHook(() => useSettingsLeaveGuard({ ...guardState, isApplying: true }));
    expect(leaves()).not.toHaveBeenCalled();
    unmount();
    expect(leaves()).toHaveBeenCalledTimes(1);
    const unregister = registerLeaveGuard(() => 'block');
    const other = renderHook(() => useSettingsLeaveGuard(guardState));
    other.unmount();
    expect(leaves()).toHaveBeenCalledTimes(1);
    unregister();
});

it('区分は移動の依頼が変わったときだけ指定へ戻し、閉じて開き直しても選び中の区分を保つ', () => {
    const { result, rerender } = renderHook(({ tab, request }) => useActiveSettingsTab(tab, request), { initialProps: { tab: 'audio' as const, request: 0 } });
    act(() => result.current[1]('obs'));
    rerender({ tab: 'audio', request: 0 });
    expect(result.current[0]).toBe('obs');
    rerender({ tab: 'audio', request: 1 });
    expect(result.current[0]).toBe('audio');
});

it('音づくりの小区分は、親が持つときは親の値、無いときは中で持ち、同じ場所は確認を通さない', () => {
    const owned = vi.fn();
    const parent = renderHook(() => useSoundPlace({ initialSection: undefined, tabRequest: 0, soundPlaceProp: 'peak', soundFocusNonce: 4, onSoundPlace: owned }));
    expect(parent.result.current.soundPlace).toBe('peak');
    expect(parent.result.current.focusNonce).toBe(4);
    act(() => parent.result.current.chooseSoundPlace('singing', true));
    expect(owned).toHaveBeenCalledWith('singing', true);
    const parentWithoutPlace = renderHook(() => useSoundPlace({ initialSection: 'singing', tabRequest: 0, soundPlaceProp: undefined, soundFocusNonce: 0, onSoundPlace: owned }));
    expect(parentWithoutPlace.result.current.soundPlace).toBe('basic');

    const { result, rerender } = renderHook(({ section, request }) => useSoundPlace({ initialSection: section, tabRequest: request, soundPlaceProp: undefined, soundFocusNonce: 9, onSoundPlace: undefined }),
        { initialProps: { section: 'liveModes' as 'liveModes' | 'singing' | undefined, request: 0 } });
    expect(result.current.soundPlace).toBe('liveModes');
    expect(result.current.focusNonce).toBe(0);
    const blocked = registerLeaveGuard(() => 'block');
    act(() => result.current.chooseSoundPlace('singing'));
    expect(result.current.soundPlace).toBe('liveModes');
    act(() => result.current.chooseSoundPlace('liveModes'));
    expect(result.current.soundPlace).toBe('liveModes');
    blocked();
    act(() => result.current.chooseSoundPlace('singing'));
    expect(result.current.soundPlace).toBe('singing');
    act(() => result.current.chooseSoundPlace('singing', true));
    expect(result.current.focusNonce).toBe(1);
    rerender({ section: undefined, request: 1 });
    expect(result.current.soundPlace).toBe('basic');
});

it('名前付きの接続は、開くたびに保存先から読み直し、壊れた保存は今の一覧を残す', () => {
    localStorage.setItem('vst_host_audio_presets', JSON.stringify({ a: { host: 'WASAPI' } }));
    const { result, rerender } = renderHook(({ open }) => useAudioPresets(open), { initialProps: { open: false } });
    expect(result.current.presets).toEqual({});
    rerender({ open: true });
    expect(Object.keys(result.current.presets)).toEqual(['a']);
    rerender({ open: false });
    localStorage.setItem('vst_host_audio_presets', '{壊れ');
    rerender({ open: true });
    expect(Object.keys(result.current.presets)).toEqual(['a']);
});

it('名前付きの接続は、空の名前では保存せず、保存と削除を保存先へ反映して選択を外す', () => {
    const { result } = renderHook(() => useAudioPresets(true));
    act(() => result.current.savePreset({ host: 'ASIO' }));
    expect(localStorage.getItem('vst_host_audio_presets')).toBeNull();
    act(() => result.current.setPresetName('  '));
    act(() => result.current.savePreset({ host: 'ASIO' }));
    expect(localStorage.getItem('vst_host_audio_presets')).toBeNull();
    act(() => result.current.setPresetName('配信'));
    act(() => result.current.savePreset({ host: 'ASIO', sampleRate: 48000 }));
    expect(JSON.parse(localStorage.getItem('vst_host_audio_presets') ?? '{}')).toEqual({ 配信: { host: 'ASIO', sampleRate: 48000 } });
    act(() => result.current.deletePreset('配信'));
    expect(result.current.presets).toEqual({});
    expect(result.current.presetName).toBe('');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_presets') ?? 'null')).toEqual({});
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, defaultReverb, type BuiltinSnapshot } from '@/api/builtinEffects';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
let current: BuiltinSnapshot;
beforeEach(() => {
    localStorage.clear();
    current = { epoch: 'engine', revision: '2', appliedRevision: '2', pending: false, undoToken: null, error: null,
        config: { active: true, preset: 'singing', amount: 0.6, singing: { lowCutHz: 110, dynamics: 0.65, brightnessDb: -1 } } };
    vi.spyOn(builtinApi, 'request').mockImplementation(async request => {
        if (request.action === 'apply') current = { ...current, revision: '3', config: request.config, undoToken: 'undo' };
        return structuredClone(current);
    });
    vi.spyOn(audioApi, 'getEngineTuningConfig').mockResolvedValue({ enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false });
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [], outputs: [] });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ builtInEffectsEnabled: true, builtInEffectsPreset: 'singing', builtInEffectsAmount: 0.6 } as EngineRuntimeStats);
    vi.spyOn(audioApi, 'setBuiltInEffects').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });
it('ホットキーの入力中に Escape すると入力だけを取り消し、設定は閉じない', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_shortcuts' ? { bindings: [{ action: 'muteToggle', shortcut: 'Alt+KeyM' }], errors: [] } : null);
    const onClose = vi.fn();
    render(<AudioSettingsModal isOpen onClose={onClose} onConfigChange={vi.fn()} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'ホットキー' }), { button: 0, ctrlKey: false });
    const button = await screen.findByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(button, { key: 'Escape', code: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveTextContent('Alt+KeyM');
});
it('設定画面の遅延根拠は手動停止で失効し、遅い旧stats応答を受理しない', async () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockClear();
    vi.spyOn(audioApi, 'getEngineTuningConfig').mockResolvedValue({ enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false });
    const stats = { builtInEffectsEnabled: false, noiseReductionEnabled: true, latencyMetadata: { schemaVersion: 1 as const, streamRunning: true, nominalSampleRateHz: 48000, fixedBufferRequestFrames: 256, nrConfiguredEnabled: true, nrProcessingRateHz: 48000, nrProcessingFrameSamples: 480, vstReportedLatencySamples: 0, signalCorrespondence: 'unmeasured' as const } } as EngineRuntimeStats;
    let old!: (value: EngineRuntimeStats) => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValueOnce(stats).mockReturnValueOnce(new Promise(resolve => { old = resolve; }));
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const system = await screen.findByRole('tab', { name: 'システム' });
    fireEvent.keyDown(system, { key: 'Enter' });
    fireEvent.click(screen.getByText('診断情報'));
    await screen.findByText('256 sample / 5.33 ms');
    fireEvent.click(screen.getByRole('button', { name: '統計を更新' }));
    act(() => { for (const [name, callback] of vi.mocked(listen).mock.calls) if (name === 'audio-stopped') callback({ event: name, id: 1, payload: null }); });
    await act(async () => old(stats));
    expect(screen.queryByText('256 sample / 5.33 ms')).not.toBeInTheDocument();
    expect(screen.getByText(/音声は停止中・未確認です/)).toBeInTheDocument();
});
it('通常設定を開くだけでbuiltin snapshotを取得せず、音作りを開いて初めて取得する', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('tab', { name: '音づくり' });
    expect(builtinApi.request).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('tab', { name: '音づくり' }), { key: 'Enter' });
    await waitFor(() => expect(builtinApi.request).toHaveBeenCalledWith({ action: 'snapshot' }));
});
it.each(['ja', 'en'] as const)('歌向けON/OFFは全値を保持し、短いプリセット名でも同じ即時APIへ送る（%s）', async locale => {
    current.config.reverb = { ...defaultReverb, enabled: true };
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} /></LocaleProvider>);
    const toggle = await screen.findByRole('switch', { name: message(locale, 'settings.AudioSettingsModal.097') });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.getByRole('slider', { name: message(locale, 'settings.AudioSettingsModal.104') })).toBeDisabled();
    expect(screen.getByText(message(locale, 'settings.AudioSettingsModal.102'))).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(builtinApi.request).toHaveBeenCalledWith({ action: 'apply', epoch: 'engine', expectedRevision: '2', config: {
        active: false, preset: 'singing', amount: 0.6, singing: { lowCutHz: 110, dynamics: 0.65, brightnessDb: -1 },
        reverb: { ...defaultReverb, enabled: true },
    } }));
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
    const legacy = screen.getByRole('button', { name: message(locale, 'settings.AudioSettingsModal.098') });
    await waitFor(() => expect(legacy).toBeEnabled());
    expect(screen.getByText(message(locale, 'settings.AudioSettingsModal.092'))).toBeVisible();
    for (const key of ['settings.AudioSettingsModal.099', 'settings.AudioSettingsModal.100'] as const) {
        expect(screen.getByRole('button', { name: message(locale, key) })).toBeEnabled();
    }
    fireEvent.click(legacy);
    await waitFor(() => expect(audioApi.setBuiltInEffects).toHaveBeenCalledWith({ active: true, preset: 'broadcast', amount: 0.6 }));
});


it.each([true, false])('音づくりの基本を先に置き、歌向けの欄を閉じて直接入口を基本操作へ合わせる（かんたん=%s）', async beginner => {
    localStorage.setItem('vst_host_beginner_mode', String(beginner));
    render(<AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const noise = await screen.findByRole('heading', { name: 'ノイズ低減' });
    const builtIn = screen.getByRole('heading', { name: '内蔵ボイスチェーン' });
    expect(noise.compareDocumentPosition(builtIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(noise).toHaveFocus();
    expect(screen.getByText('歌向けに整える').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('本番の歌・雑談モード').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('combobox', { name: '表示言語' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: '外観' }), { key: 'Enter' });
    expect(screen.getByRole('combobox', { name: '表示言語' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'システム' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ホットキー' })).toBeInTheDocument();
});

it('プロファイル適用でモードが変わっても音づくりの表示を古い統計値へ戻さず、次の操作で新しい設定を送る', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({ noiseReductionEnabled: false, noiseReductionActive: false, noiseReductionMode: 'low', noiseControlStrength: 0.6, noiseVoiceGuard: false, builtInEffectsEnabled: true, builtInEffectsPreset: 'singing', builtInEffectsAmount: 0.6 } as EngineRuntimeStats);
    const setNoise = vi.spyOn(audioApi, 'setNoiseControlConfig').mockResolvedValue(undefined);
    render(<AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const noise = await screen.findByRole('switch', { name: message('ja', 'settings.AudioSettingsModal.107') });
    await waitFor(() => expect(noise).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('button', { name: message('ja', 'master.nrLow') })).toHaveAttribute('aria-pressed', 'true'));
    act(() => { window.dispatchEvent(new CustomEvent('profile-fx-applied', { detail: {
        noiseControl: { enabled: true, mode: 'venue', strength: 1.1, voiceGuard: true },
        builtinFx: { preset: 'warm', enabled: false, amount: 0.4 },
    } })); });
    await act(async () => {});
    expect(screen.getByRole('button', { name: message('ja', 'master.nrVenue') })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: message('ja', 'master.nrLow') })).toHaveAttribute('aria-pressed', 'false');
    expect(noise).toBeChecked();
    fireEvent.click(noise);
    await waitFor(() => expect(setNoise).toHaveBeenCalledWith({ active: false, mode: 'venue', strength: 1.1, voiceGuard: true }));
});

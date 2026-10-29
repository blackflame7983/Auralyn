import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, type BuiltinSnapshot } from '@/api/builtinEffects';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { AudioSettingsModal } from '../AudioSettingsModal';
import { ShortcutsPanel } from '../ShortcutsPanel';
import { ObsSafeSetup } from '../ObsSafeSetup';
import { MigrationPanel } from '../MigrationPanel';
import { InputChannelSelector } from '../InputChannelSelector';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
const devices = { inputs: [{ name: '実名のマイク', host: 'Wasapi', channels: 2, index: 0, is_input: true, is_default: true }], outputs: [{ name: '実名の出力', host: 'Wasapi', channels: 2, index: 0, is_input: false, is_default: true }] };
const current: BuiltinSnapshot = { epoch: 'engine', revision: '2', appliedRevision: '2', pending: false, undoToken: null, error: null, config: { active: true, preset: 'singing', amount: .6, singing: { lowCutHz: 100, dynamics: .5, brightnessDb: 0 } } };
beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices));
    localStorage.setItem('vst_host_session_plugins', 'opaque-session-original');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'obs_connection_status') return false;
        if (command === 'obs_setup_history') return [];
        if (command === 'get_shortcuts') return { bindings: [], errors: [] };
        if (command === 'get_engine_tuning_config') return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
        return null;
    });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: false, streamFailed: false });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ builtInEffectsEnabled: true, builtInEffectsPreset: 'singing', builtInEffectsAmount: .6 } as EngineRuntimeStats);
    vi.spyOn(builtinApi, 'request').mockResolvedValue(structuredClone(current));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it('実設定dialogのタブと未保存入力を保ち、言語変更だけではIPCや音声操作を再送しない', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} /></LocaleProvider>);
    await screen.findByRole('option', { name: '実名のマイク' });
    fireEvent.change(screen.getByRole('textbox', { name: '保存する名前' }), { target: { value: '未保存の実名' } });
    const dialog = screen.getByRole('dialog');
    const driver = screen.getByRole('combobox', { name: 'オーディオドライバ' });
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('combobox', { name: 'Audio driver' })).toBe(driver);
    expect(screen.getByRole('textbox', { name: 'Name to save' })).toHaveValue('未保存の実名');
    expect(screen.getByRole('tab', { name: 'Audio' })).toHaveAttribute('aria-selected', 'true');
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem('vst_host_session_plugins')).toBe('opaque-session-original');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'OBS' }), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox', { name: 'OBS host name' }), { target: { value: 'unsaved-studio' } });
    const host = screen.getByRole('textbox', { name: 'OBS host name' });
    const obsCalls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('ja'); });
    expect(screen.getByRole('tab', { name: 'OBS連携' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'OBSホスト名' })).toBe(host);
    expect(host).toHaveValue('unsaved-studio');
    expect(invoke).toHaveBeenCalledTimes(obsCalls);
});

it('歌と残響の未適用下書きを同じ入力要素に維持し、localeで再取得・適用・試聴をしない', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const preview = vi.fn();
    render(<LocaleProvider store={store}><AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} onPreviewSinging={preview} /></LocaleProvider>);
    const low = await screen.findByRole('spinbutton', { name: '低音の整理（Hz）' });
    fireEvent.change(low, { target: { value: '130' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '残響を有効にする' }));
    await act(async () => {});
    const ipc = vi.mocked(invoke).mock.calls.length;
    const builtin = vi.mocked(builtinApi.request).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('spinbutton', { name: 'Low-cut (Hz)' })).toBe(low);
    expect(low).toHaveValue(130);
    expect(screen.getByRole('checkbox', { name: 'Enable reverb' })).toBeChecked();
    expect(screen.getByRole('tab', { name: 'Sound' })).toHaveAttribute('aria-selected', 'true');
    expect(builtinApi.request).toHaveBeenCalledTimes(builtin);
    expect(invoke).toHaveBeenCalledTimes(ipc);
    expect(preview).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('キー操作%sは同じstable IDとキーを保存し、通知は再操作なしで再翻訳する', async locale => {
    const store = createLocaleStore(() => locale, () => true);
    vi.mocked(invoke).mockImplementation(async (command, args) => command === 'save_shortcuts' ? { bindings: (args as { bindings: unknown[] }).bindings, errors: [] } : { bindings: [], errors: [] });
    render(<LocaleProvider store={store}><ShortcutsPanel /></LocaleProvider>);
    const label = locale === 'ja' ? '歌にする' : 'Switch to Singing';
    const modifier = screen.getByRole('combobox', { name: locale === 'ja' ? `${label}の修飾キー` : `${label} modifier` });
    await waitFor(() => expect(modifier).toBeEnabled());
    fireEvent.change(modifier, { target: { value: 'Alt' } });
    fireEvent.change(screen.getByRole('combobox', { name: locale === 'ja' ? `${label}の通常キー` : `${label} regular key` }), { target: { value: 'F12' } });
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? 'キー設定を保存' : 'Save key settings' }));
    await screen.findByRole('status');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', { bindings: [{ action: 'singingOn', shortcut: 'Alt+F12' }] });
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale(locale === 'ja' ? 'en' : 'ja'); });
    expect(screen.getByRole('status')).toHaveTextContent(locale === 'ja' ? 'Key settings saved.' : 'キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledTimes(calls);
});

it('OBS履歴の実名と制御tokenは英訳せず、英語の復元操作だけを同じIDへ送る', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'obs_setup_history' ? [{ id: 4, changes: [{ source: 'Auralyn マイク', label: 'ミュート', before: false, after: true }], results: ['適用済み'], restorable: true, connectionLabel: 'studio実名' }] : []);
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}><ObsSafeSetup connected disabled={false} onBusyChange={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByText('Previous changes'));
    await screen.findByText(/適用済み/);
    expect(screen.getByText(/Auralyn マイク/)).toBeVisible();
    expect(screen.getByText(/studio実名/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Undo change #4' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('obs_restore_setup', { id: 4 }));
});

it('入力radioの動的ARIAを切り替えても信号監視を再起動せず、同じch番号だけを送る', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    vi.spyOn(audioApi, 'setChannelScan').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
    render(<LocaleProvider store={store}><InputChannelSelector maxChannels={4} /></LocaleProvider>);
    await waitFor(() => expect(audioApi.setChannelScan).toHaveBeenCalledWith(true));
    const pair = screen.getByRole('radio', { name: '入力チャンネル 3/4' });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('radio', { name: 'Input channels 3/4' })).toBe(pair);
    expect(audioApi.setChannelScan).toHaveBeenCalledTimes(1);
    fireEvent.click(pair);
    await waitFor(() => expect(pair).toBeChecked());
    expect(audioApi.setInputChannels).toHaveBeenCalledExactlyOnceWith(2, 3);
});

it('危険設定の確認dialogもkeyから再翻訳し、確認前に設定を書き換えない', async () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} /></LocaleProvider>);
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'システム' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('switch', { name: 'リアルタイム優先度' }));
    const dialog = screen.getByRole('dialog', { name: 'リアルタイム優先度を有効化しますか？' });
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog', { name: 'Enable Realtime priority?' })).toBe(dialog);
    expect(screen.getByText('Incorrect settings may make mouse and keyboard input sluggish.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(invoke).not.toHaveBeenCalledWith('save_engine_tuning_config', expect.anything());
});

it('移行の動的件数を英語で表示し、実ファイル名・VST名は保持する', async () => {
    vi.mocked(invoke).mockResolvedValue({ appVersion: '1.2.3', settings: ['stableKey'], files: ['日本語.profile'], plugins: ['実名VST'], audio: null });
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}><MigrationPanel /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Review migration file' }));
    expect(await screen.findByText('Created with version: 1.2.3 / Settings: 1 / Files: 1')).toBeVisible();
    expect(screen.getByText('日本語.profile')).toBeVisible();
    expect(screen.getByText('実名VST')).toBeVisible();
});

it('外観タブで表示用途を切り替えられ、言語の下に置く', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: '外観' }), { key: 'Enter' });
    const purpose = await screen.findByRole('combobox', { name: '表示用途' });
    const language = screen.getByRole('combobox', { name: /言語/ });
    expect(language.compareDocumentPosition(purpose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
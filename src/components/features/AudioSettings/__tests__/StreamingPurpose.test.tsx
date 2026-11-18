import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, type BuiltinSnapshot } from '@/api/builtinEffects';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
const devices = { inputs: [{ name: '実名のマイク', host: 'Wasapi', channels: 2, index: 0, is_input: true, is_default: true }], outputs: [{ name: '実名の出力', host: 'Wasapi', channels: 2, index: 0, is_input: false, is_default: true }] };
const current: BuiltinSnapshot = { epoch: 'engine', revision: '2', appliedRevision: '2', pending: false, undoToken: null, error: null, config: { active: true, preset: 'singing', amount: .6, singing: { lowCutHz: 100, dynamics: .5, brightnessDb: 0 } } };

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', input: '実名のマイク', output: '実名の出力', sampleRate: 48000, bufferSize: 512 }));
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'obs_connection_status') return false;
        if (command === 'obs_setup_history') return [];
        if (command === 'get_shortcuts') return { bindings: [], errors: [] };
        if (command === 'get_engine_tuning_config') return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
        if (command === 'live_output') return { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false, splitProcessing: false, monitorSinging: null, monitorTalk: null }, sink: null, error: null };
        return null;
    });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: false, streamFailed: false });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ builtInEffectsEnabled: false } as EngineRuntimeStats);
    vi.spyOn(builtinApi, 'request').mockResolvedValue(structuredClone(current));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

function open(locale: 'ja' | 'en') {
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} /></LocaleProvider>);
}

function expectStreamingSections(locale: 'ja' | 'en', present: boolean) {
    for (const key of ['liveOutput.title', 'streamMix.title', 'structure.monitor'] as const) {
        const count = screen.queryAllByText(message(locale, key), { exact: true }).length;
        if (present) expect(count).toBeGreaterThan(0);
        else expect(count).toBe(0);
    }
}

it.each(['ja', 'en'] as const)('配信では分離出力・歌モニター・配信ミックスを出し、使用中の欄は出さない（%s）', async locale => {
    open(locale);
    expect(await screen.findAllByText(message(locale, 'liveOutput.title'), { exact: true })).not.toHaveLength(0);
    expectStreamingSections(locale, true);
    expect(screen.queryByText(message(locale, 'settings.streamingInUse'))).not.toBeInTheDocument();
    expect(screen.queryByText(message(locale, 'streamMix.voiceOnly'))).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'live_output')).toBe(false);
});

it.each(['ja', 'en'] as const)('音楽鑑賞で配信向けの設定が既定なら、欄を隠して戻す案内だけ残す（%s）', async locale => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    open(locale);
    expect(await screen.findByText(message(locale, 'streamMix.voiceOnly'))).toBeVisible();
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'live_output')).toBe(true));
    expectStreamingSections(locale, false);
    expect(screen.queryByText(message(locale, 'settings.streamingInUse'))).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('音楽鑑賞で使っている配信向けの設定だけ、閉じた欄に残す（%s）', async locale => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    localStorage.setItem('auralyn_stream_mix_panel', 'shown');
    localStorage.setItem('auralyn_monitor_trial_original_v1', '{');
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'live_output') return { config: { deviceId: 'cable', monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'obs_connection_status') return false;
        if (command === 'obs_setup_history') return [];
        if (command === 'get_shortcuts') return { bindings: [], errors: [] };
        if (command === 'get_engine_tuning_config') return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
        return null;
    });
    open(locale);
    const summary = await screen.findByText(message(locale, 'settings.streamingInUse'));
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await screen.findAllByText(message(locale, 'liveOutput.title'), { exact: true });
    expectStreamingSections(locale, true);
    expect(screen.getByText(message(locale, 'streamMix.voiceOnly'))).toBeVisible();
});

it.each(['ja', 'en'] as const)('音楽鑑賞ではマイクの許可の案内を平時に出さず、配信・通話では出す（%s）', async locale => {
    const guide = message(locale, 'settings.MicrophonePermissionGuide.238');
    localStorage.setItem('auralyn_display_purpose', 'music');
    open(locale);
    expect(await screen.findByText(message(locale, 'streamMix.voiceOnly'))).toBeVisible();
    expect(screen.queryByText(guide)).not.toBeInTheDocument();
    cleanup();
    localStorage.setItem('auralyn_display_purpose', 'voice');
    open(locale);
    expect(await screen.findByText(guide)).toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('配信向けの欄が出ない理由は、何が出ないのかを先に言う（%s）', locale => {
    const text = message(locale, 'streamMix.voiceOnly');
    expect(text).toContain(message(locale, 'liveOutput.title'));
    expect(text).toContain(message(locale, 'streamMix.title'));
});

it.each(['ja', 'en'] as const)('接続のページの配信ミックスの欄は、すぐ反映することと、準備の場所を書く（%s）', async locale => {
    open(locale);
    const heading = (await screen.findAllByText(message(locale, 'streamMix.title'), { exact: true })).find(node => node.tagName === 'H3');
    const section = heading?.closest('section');
    if (!section) throw new Error('streamMix section not found');
    expect(section).toHaveTextContent(message(locale, 'streamMix.instant'));
    expect(section).toHaveTextContent(message(locale, 'streamMix.settingsHint'));
    expect(message(locale, 'streamMix.settingsHint')).toContain(message(locale, 'liveOutput.title'));
    expect(within(section).getByRole('checkbox', { name: message(locale, 'streamMix.show') })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: message(locale, 'streamMix.openHome') })).toBeInTheDocument();
});
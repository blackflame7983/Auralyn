import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi } from '@/api/audio';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { usePlugins } from '@/hooks/usePlugins';
import { PLUGIN_SESSION_KEY } from '@/hooks/usePluginSessionPersistence';
import { installSessionRackFixture } from '@/hooks/__tests__/sessionRackFixture';
import { message } from '@/i18n/messages';
import { checkRestoredRack } from '@/lib/rackRestoreOutcome';
import { AudioSettingsModal } from '../AudioSettingsModal';

// 切り替えの確認と、実際の usePlugins().restoreSession を通して、再起動後の VST 復元の失敗が巻き戻しにつながることを確かめる。
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), loading: vi.fn(), info: vi.fn() } }));

const voiceSource = { kind: 'device', config: { purpose: 'voice' } } as const;
const musicSource = { kind: 'device', config: { purpose: 'music' } } as const;
const config = { host: 'Wasapi', input: 'Mic', output: 'Headphones', sampleRate: 48000, bufferSize: 512, inputSource: voiceSource };
const musicRecord = { host: 'Wasapi', input: 'CABLE Output', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512, inputSource: musicSource };
const devices = {
    inputs: [
        { host: 'Wasapi', name: 'Mic', channels: 2, is_input: true, is_default: true, index: 0 },
        { host: 'Wasapi', name: 'CABLE Output', channels: 2, is_input: true, is_default: false, index: 1 },
    ],
    outputs: [
        { host: 'Wasapi', name: 'Headphones', channels: 2, is_input: false, is_default: true, index: 0 },
        { host: 'Wasapi', name: 'USB Headphones', channels: 2, is_input: false, is_default: false, index: 1 },
    ],
};
const restartResult = { sample_rate: 48000, buffer_size: 512, channels: 2 };
let failVstChecks = 0;

beforeEach(() => {
    localStorage.clear();
    failVstChecks = 0;
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    localStorage.setItem('auralyn_display_purpose', 'voice');
    localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: musicRecord }));
    installSessionRackFixture();
    const fixture = vi.mocked(audioApi.sessionRack).getMockImplementation();
    if (!fixture) throw new Error('sessionRack の模擬が入っていません');
    // 再起動のあと、実ラックの確認を失敗させる。残り回数が無くなれば（元の接続へ戻したあと）通常に戻る。
    vi.mocked(audioApi.sessionRack).mockImplementation(async request => {
        if (failVstChecks > 0 && request.action === 'snapshot') { failVstChecks -= 1; throw new Error('注入した VST の確認失敗'); }
        return fixture(request);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

// ModalLayer と同じ配線: 再起動のあとはラックを空にして、保存した構成を戻し、その結果を返す。
function Harness({ onConfigChange }: { onConfigChange: () => Promise<void> }) {
    const plugins = usePlugins();
    return <AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={vi.fn()} onConfigChange={onConfigChange}
        onEngineRestarted={async () => {
            plugins.resetPlugins();
            await plugins.restoreSession();
            return await checkRestoredRack(localStorage.getItem(PLUGIN_SESSION_KEY));
        }} />;
}

it('再起動のあとの実際の VST 復元が失敗したら、切り替えを失敗として元の接続へ戻し、音楽鑑賞に確定しない', async () => {
    const restart = vi.spyOn(audioApi, 'restart').mockImplementation(async () => {
        // 再起動で、保存した構成の復元を試みる実ラックの確認が失敗する。元へ戻す再起動のあとは成功する。
        if (restart.mock.calls.length === 1) failVstChecks = 2;
        return restartResult;
    });
    const onConfigChange = vi.fn(async () => {});
    render(<Harness onConfigChange={onConfigChange} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    localStorage.setItem(PLUGIN_SESSION_KEY, JSON.stringify([{ path: 'a', name: '実名 a', enabled: true, muted: false, gain: .8, state: 'opaque-a' }]));
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(message('ja', 'purpose.vstIncomplete'));
    expect(alert).toHaveTextContent('表示と音声設定は元のままです');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(restart.mock.calls[1].slice(0, 3)).toEqual(['Wasapi', 'Mic', 'Headphones']);
    expect(readDisplayPurpose()).toBe('voice');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic', output: 'Headphones' });
    expect(onConfigChange).toHaveBeenCalledTimes(2);
});

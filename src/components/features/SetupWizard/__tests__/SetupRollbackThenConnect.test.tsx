import { TutorialProvider } from '@/contexts/TutorialContext';
import { chooseObsRoute } from './wizardActions';
import { type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { ModalLayer } from '@/components/layout/ModalLayer';
import { useUIState } from '@/hooks/useUIState';
import { useAudioConfig } from '@/hooks/useAudioConfig';
import type { AudioDevice } from '@/api/audio';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const mic: AudioDevice = { name: 'USB マイク', host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: true };
const cable: AudioDevice = { ...mic, name: 'CABLE Input', is_input: false };
const CONFIG_KEY = 'vst_host_audio_config';

function AppModals() {
    const ui = useUIState();
    const { audioConfig, handleConfigUpdate } = useAudioConfig(() => ui.setIsWizardOpen(true));
    return <TutorialProvider>
        <output data-testid="audio-config">{audioConfig.sampleRate}/{audioConfig.bufferSize}</output>
        <button type="button" onClick={() => { ui.setIsWizardOpen(false); ui.setIsSettingsOpen(true); }}>接続のページを開く</button>
        <ModalLayer ui={ui} audioConfig={audioConfig} handleConfigUpdate={handleConfigUpdate}
            pluginsApi={{} as ComponentProps<typeof ModalLayer>['pluginsApi']} onPluginAdded={() => {}} />
    </TutorialProvider>;
}

beforeEach(() => {
    localStorage.clear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'get_audio_devices') return { inputs: [mic], outputs: [cable] };
        if (command === 'get_audio_state') return { is_running: false, config: null };
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        if (command === 'start_audio') {
            const request = args as { sampleRate?: number; bufferSize?: number } | undefined;
            return { sample_rate: request?.sampleRate, buffer_size: request?.bufferSize, channels: 2 };
        }
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); });

const startRequests = () => vi.mocked(invoke).mock.calls
    .filter(([command]) => command === 'start_audio')
    .map(([, args]) => args as { sampleRate?: number; bufferSize?: number });

it('初回のセットアップが保存の途中で失敗して未設定へ戻っても、そのあと接続のページから開始した要求と保存値に 0 が入らない', async () => {
    render(<AppModals />);
    await screen.findByRole('radio', { name: 'OBSで配信' }, { timeout: 5000 });
    await chooseObsRoute();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
        if (key === 'vst_host_setup_goal') throw new Error('容量不足');
        return original.call(this, key, value);
    };
    try {
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'stop_audio')).toBe(true));
        await waitFor(() => expect(screen.queryByRole('heading', { name: '音声設定を保存しました' })).not.toBeInTheDocument());
    } finally { Storage.prototype.setItem = original; }
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('audio-config')).toHaveTextContent('48000/512'));
    const requestsBefore = startRequests().length;

    fireEvent.click(screen.getByRole('button', { name: '接続のページを開く', hidden: true }));
    const input = await screen.findByRole('combobox', { name: 'マイク' }, { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('option', { name: mic.name })).toBeInTheDocument());
    fireEvent.change(input, { target: { value: mic.name } });
    const output = await screen.findByRole('combobox', { name: '出力先' });
    fireEvent.change(output, { target: { value: cable.name } });
    const save = await screen.findByRole('button', { name: /接続を保存/ });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(startRequests().length).toBe(requestsBefore + 1));

    const request = startRequests()[requestsBefore];
    expect(request.sampleRate).toBe(48000);
    expect(request.bufferSize).toBe(512);
    await waitFor(() => expect(localStorage.getItem(CONFIG_KEY)).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}')).toMatchObject({ sampleRate: 48000, bufferSize: 512 });
});

import { TutorialProvider, useTutorial } from '@/contexts/TutorialContext';
import { chooseObsRoute } from './wizardActions';
import { type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ModalLayer } from '@/components/layout/ModalLayer';
import { useUIState } from '@/hooks/useUIState';
import { useAudioConfig } from '@/hooks/useAudioConfig';
import type { AudioDevice } from '@/api/audio';

// 遷移先のデバイス操作は起動せず、親のモーダル切替だけを検証する。
vi.mock('@/components/features/AudioSettings/AudioSettingsModal', () => ({
    AudioSettingsModal: () => <h2>オーディオ設定</h2>,
}));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const mic: AudioDevice = { name: 'USB マイク', host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: true };
const cable: AudioDevice = { ...mic, name: 'CABLE Input', is_input: false };
let hasInput: boolean;
let sampleRate: number;
let bufferSize: number;

function TutorialState() {
    const { currentStep } = useTutorial();
    return <output data-testid="tutorial-step">{currentStep}</output>;
}

function AppModals() {
    const ui = useUIState();
    const { audioConfig, handleConfigUpdate } = useAudioConfig(() => ui.setIsWizardOpen(true));
    return <TutorialProvider>
        <TutorialState />
        <output data-testid="audio-config">{audioConfig.sampleRate}/{audioConfig.bufferSize}</output>
        <ModalLayer ui={ui} audioConfig={audioConfig} handleConfigUpdate={handleConfigUpdate}
            pluginsApi={{} as ComponentProps<typeof ModalLayer>['pluginsApi']} onPluginAdded={() => {}} />
    </TutorialProvider>;
}

beforeEach(() => {
    localStorage.clear();
    vi.mocked(toast.error).mockClear();
    hasInput = true;
    sampleRate = 96000;
    bufferSize = 1024;
    vi.mocked(listen).mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: hasInput ? [mic] : [], outputs: [cable] };
        if (command === 'get_audio_state') return { is_running: false, config: null };
        if (command === 'start_audio') {
            // 実エンジンと同じく、起動応答より先に実値のイベントを通知する。
            const onStarted = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-started')?.[1];
            onStarted?.({ event: 'audio-started', id: 1, payload: { sample_rate: sampleRate, buffer_size: bufferSize } });
            return { sample_rate: sampleRate, buffer_size: bufferSize, channels: 2 };
        }
    });
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe('セットアップと親画面の連携', () => {
    it('入力未検出時はウィザードを閉じてオーディオ設定だけを開く', async () => {
        hasInput = false;
        render(<AppModals />);
        await screen.findByRole('button', { name: 'OBSで配信' }, { timeout: 3000 });
        fireEvent.click(screen.getByRole('button', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('button', { name: 'WASAPI の入力が見つからない場合は設定を開く' }));
        await screen.findByRole('heading', { name: 'オーディオ設定' });
        expect(screen.queryByRole('heading', { name: 'マイクを選んでください' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'セットアップを閉じる' })).not.toBeInTheDocument();
        expect(localStorage.getItem('vst_host_wizard_done')).toBeNull();
        expect(screen.getByTestId('tutorial-step')).toHaveTextContent('none');
    });

    it.each([[96000, 1024], [44100, 256]])('起動後も実値 %i Hz / %i を親画面と保存設定に維持する', async (rate, buffer) => {
        sampleRate = rate;
        bufferSize = buffer;
        render(<AppModals />);
        await chooseObsRoute();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        await waitFor(() => expect(screen.getByTestId('audio-config')).toHaveTextContent(`${rate}/${buffer}`));
        expect(JSON.parse(localStorage.getItem('vst_host_audio_config') || '{}')).toEqual({
            host: 'WASAPI', input: mic.name, output: cable.name, sampleRate: rate, bufferSize: buffer,
        });
        expect(localStorage.getItem('vst_host_wizard_done')).toBe('true');
        expect(screen.getByTestId('tutorial-step')).toHaveTextContent('click_add_effect');
    });
});


it('スキップでも既存の完了フラグを保存し、同じウィンドウの開始条件を更新する', async () => {
    render(<AppModals />);
    await screen.findByRole('button', { name: 'OBSで配信' }, { timeout: 3000 });
    expect(screen.getByTestId('tutorial-step')).toHaveTextContent('none');
    fireEvent.click(screen.getByRole('button', { name: 'セットアップをスキップ' }));
    await waitFor(() => expect(localStorage.getItem('vst_host_wizard_done')).toBe('true'));
    expect(screen.getByTestId('tutorial-step')).toHaveTextContent('click_add_effect');
});

it('単に閉じた場合は完了フラグを保存せず、開始通知を送らない', async () => {
    render(<AppModals />);
    await screen.findByRole('button', { name: 'OBSで配信' }, { timeout: 3000 });
    const notify = vi.fn();
    window.addEventListener('vst_host_tutorial_start', notify);
    try {
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'OBSで配信' })).not.toBeInTheDocument());
        expect(localStorage.getItem('vst_host_wizard_done')).toBeNull();
        expect(screen.getByTestId('tutorial-step')).toHaveTextContent('none');
        expect(notify).not.toHaveBeenCalled();
    } finally {
        window.removeEventListener('vst_host_tutorial_start', notify);
    }
});

it('起動失敗では完了フラグを保存せず、開始通知を送らない', async () => {
    const { audioApi } = await import('@/api/audio');
    const start = vi.spyOn(audioApi, 'start').mockRejectedValueOnce(new Error('start failed'));
    const notify = vi.fn();
    window.addEventListener('vst_host_tutorial_start', notify);
    try {
        render(<AppModals />);
        await chooseObsRoute();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(localStorage.getItem('vst_host_wizard_done')).toBeNull();
        expect(screen.getByTestId('tutorial-step')).toHaveTextContent('none');
        expect(notify).not.toHaveBeenCalled();
    } finally {
        start.mockRestore();
        window.removeEventListener('vst_host_tutorial_start', notify);
    }
});

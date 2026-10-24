import { type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ModalLayer } from '../ModalLayer';
import { useUIState } from '@/hooks/useUIState';

// 遷移先の設定操作は実行せず、実際の画面とUI状態を経由したタブ選択を確認する。
vi.mock('@/components/features/AudioSettings/AudioSettingsModal', () => ({
    AudioSettingsModal: ({ initialTab }: { initialTab: string }) => <h2>設定タブ: {initialTab}</h2>,
}));
let streamRunning: boolean;
let adviceKey: string;
function AppModals() {
    const ui = useUIState();
    return <>
        <button onClick={() => ui.setIsTemplateWizardOpen(true)}>テンプレートを開く</button>
        <button onClick={() => ui.setIsVoiceCheckOpen(true)}>試聴を開く</button>
        <ModalLayer ui={ui} audioConfig={{ host: 'WASAPI' }} handleConfigUpdate={vi.fn()}
            pluginsApi={{ availablePlugins: [], isScanning: false, scanPlugins: vi.fn() } as unknown as ComponentProps<typeof ModalLayer>['pluginsApi']}
            onPluginAdded={vi.fn()} />
    </>;
}

beforeEach(() => {
    streamRunning = true;
    adviceKey = 'noise_floor_high';
    localStorage.clear();
    vi.mocked(listen).mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'auto_gain') return { running: streamRunning, streamFailed: false };
        if (command === 'get_audio_state') return { is_running: true, config: null };
        if (command === 'analyze_voice_check') return {
            clip: { count: 0, ratio: 0, positionsMs: [] }, dropouts: { count: 0, positionsMs: [] },
            noiseFloorDb: { raw: -60, processed: -65 }, snrImprovementDb: 5,
            bandDeltaDb: [], loudness: { rmsDb: -18, peakDb: -6 }, verdict: 'warn',
            advices: [{ severity: 'warn', messageKey: adviceKey,
                params: { bandHz: 4000, deltaDb: -6, noiseFloorDb: -40, snrImprovementDb: 1, count: 1, currentBufferSize: 512, recommendedBufferSize: 1024 } }],
        };
        return null;
    });
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); localStorage.clear(); });

it('テンプレートの内蔵処理の入口は音づくりタブを開く', async () => {
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: 'テンプレートを開く' }));
    // 初回の遅延importを待ち、画面内の操作は表示完了後に確認する。
    await screen.findByRole('dialog', { name: 'VST構成テンプレート' }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: '外部VSTを使わず、内蔵処理を設定する' }));
    await screen.findByRole('heading', { name: '設定タブ: sound' });
    expect(screen.queryByRole('dialog', { name: 'VST構成テンプレート' })).not.toBeInTheDocument();
});

it.each(['high_freq_attenuation', 'noise_floor_high', 'noise_suppression_weak', 'dropout_detected'])(
    '品質チェックの%sは対象の設定タブへ進む', async key => {
        adviceKey = key;
        render(<AppModals />);
        fireEvent.click(screen.getByRole('button', { name: '試聴を開く' }));
        await screen.findByRole('dialog', { name: 'ボイスチェック' });
        await waitFor(() => expect(vi.mocked(listen).mock.calls.some(([name]) => name === 'voice-check-state')).toBe(true));
        act(() => {
            const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'voice-check-state')![1];
            callback({ event: 'voice-check-state', id: 1, payload: { state: 'ready', position_ms: 0, duration_ms: 1000 } });
        });
        fireEvent.click(screen.getByRole('button', { name: '品質チェックを実行' }));
        const target = key === 'dropout_detected' ? 'audio' : 'sound';
        fireEvent.click(await screen.findByRole('button', { name: target === 'sound' ? '音づくりを開く' : 'オーディオ設定を開く' }));
        await screen.findByRole('heading', { name: `設定タブ: ${target}` });
        expect(screen.queryByRole('dialog', { name: 'ボイスチェック' })).not.toBeInTheDocument();
    },
);

it('録音準備からは接続用のオーディオタブを開く', async () => {
    streamRunning = false;
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: '試聴を開く' }));
    await screen.findByText(/音声が停止しています/);
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    await screen.findByRole('heading', { name: '設定タブ: audio' });
});

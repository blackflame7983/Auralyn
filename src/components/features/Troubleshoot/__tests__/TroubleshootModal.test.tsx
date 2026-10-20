import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { TroubleshootModal } from '../TroubleshootModal';

const config = { host: 'Wasapi', input: 'USB mic', output: 'Headphones' };
const openDiagnosis = () => {
    render(<TroubleshootModal isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /OBS（配信・録画）/ }));
};
beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

it.each(['', '-A', '-B'])('CABLE%s Inputの到達確認は、同じ系統・ホストのOutputだけを検査する', async variant => {
    vi.useFakeTimers();
    const output = `CABLE${variant} Input (VB-Audio) [44/48kHz]`;
    const receiver = `CABLE${variant} Output (VB-Audio) [44/48kHz]`;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_state') return { is_running: true, config: { ...config, output } };
        if (command === 'auto_gain') return { running: true, streamFailed: false };
        if (command === 'get_audio_devices') return { inputs: [
            { name: receiver, host: 'ASIO' },
            { name: variant === '-B' ? 'CABLE-A Output' : 'CABLE-B Output', host: 'Wasapi' },
            { name: receiver, host: 'Wasapi' },
        ], outputs: [] };
        if (command === 'probe_loopback') return { detected: true, levelDb: -20 };
    });
    openDiagnosis();
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '続行' }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('probe_loopback', { inputDevice: receiver, durationMs: 1500, freqHz: 1000 });
    expect(screen.getByText(new RegExp(`CABLE${variant} Output.*テストトーンを検出`))).toBeInTheDocument();
    expect(screen.getByText(/OBS のソースに/)).toHaveTextContent(`CABLE${variant} Output`);
});

it.each([
    { output: 'CABLE-A Input', inputs: [{ name: 'CABLE Output', host: 'Wasapi' }] },
    { output: 'CABLE Input', inputs: [{ name: 'CABLE Output', host: 'ASIO' }] },
    { output: 'CABLE Input', inputs: [{ name: 'CABLE Output', host: 'Wasapi' }, { name: 'CABLE Output (VB-Audio)', host: 'Wasapi' }] },
    { output: 'Voicemeeter Input', inputs: [{ name: 'CABLE Output', host: 'Wasapi' }] },
    { output: 'Custom Virtual Output', inputs: [{ name: 'CABLE Output', host: 'Wasapi' }] },
])('対になる入力を一意に特定できなければ、別ケーブルで検査せず手動確認を案内する: %j', async ({ output, inputs }) => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_state') return { is_running: true, config: { ...config, output } };
        if (command === 'auto_gain') return { running: true, streamFailed: false };
        if (command === 'get_audio_devices') return { inputs, outputs: [] };
    });
    openDiagnosis();
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalledWith('probe_loopback', expect.anything());
    expect(screen.getByText(/対になる入力を一意に特定できませんでした/)).toBeInTheDocument();
    expect(screen.getByText(/^直し方: 手動確認/)).toBeInTheDocument();
    if (output === 'Voicemeeter Input') {
        expect(screen.getByText(/OBS のソースに/)).toHaveTextContent('Voicemeeter のバス設定に対応する録音デバイス');
        expect(screen.getByText(/OBS のソースに/)).not.toHaveTextContent('CABLE Output');
    }
});

it.each([
    { is_running: true, config: null },
    { is_running: false, config },
])('未設定・停止中はマイク権限や音到達の診断へ進まない: %j', async state => {
    vi.mocked(invoke).mockResolvedValue(state);
    openDiagnosis();
    await screen.findByRole('button', { name: '設定を開く' });
    expect(screen.getAllByText('音声の開始を確認できないため、未確認です')).toHaveLength(6);
    expect(screen.queryByText(/マイク権限/)).not.toBeInTheDocument();
    expect(vi.mocked(listen).mock.calls.some(([event]) => event === 'audio-level')).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('play_test_tone', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('get_routing_diagnostics');
});

it.each([{ running: false, streamFailed: false }, { running: true, streamFailed: true }, null])(
    '設定やプロセスがあってもストリームを確認できなければ測定しない: %j', async stream => {
        vi.mocked(invoke).mockImplementation(async command => {
            if (command === 'get_audio_state') return { is_running: true, config };
            if (command === 'auto_gain') return stream;
        });
        openDiagnosis();
        await screen.findByRole('button', { name: '設定を開く' });
        expect(screen.getAllByText('音声の開始を確認できないため、未確認です')).toHaveLength(6);
        expect(vi.mocked(listen).mock.calls.some(([event]) => event === 'audio-level')).toBe(false);
    },
);

it('比較情報や通信デバイスが未取得なら成功を表示しない', async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_state') return { is_running: true, config };
        if (command === 'auto_gain') return { running: true, streamFailed: false };
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_routing_diagnostics') return {
            devices: [], engineSampleRateHz: null, sampleRateMismatches: [],
            defaultCommsRenderIsVirtual: false, defaultCommsRenderName: null, warnings: [],
        };
    });
    openDiagnosis();
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    await act(async () => {});
    expect(screen.getByText('比較に必要なサンプルレート情報を取得できませんでした')).toBeInTheDocument();
    expect(screen.getByText('既定通信デバイスを確認できませんでした')).toBeInTheDocument();
    expect(screen.queryByText(/仮想ケーブルと一致/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('play_test_tone', expect.anything());
});

it.each(['Discord（通話）', 'その他アプリ'])('%s の受け側処理を一律OFFにせず、比較と試聴を案内する', async purpose => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_state') return { is_running: true, config };
        if (command === 'auto_gain') return { running: true, streamFailed: false };
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_routing_diagnostics') return {
            devices: [], engineSampleRateHz: null, sampleRateMismatches: [],
            defaultCommsRenderIsVirtual: false, defaultCommsRenderName: null, warnings: [],
        };
    });
    render(<TroubleshootModal isOpen onClose={vi.fn()} onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(purpose.replace(/[（）]/g, '\\$&')) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    await act(async () => {});
    expect(screen.getByText(/一つずつ/)).toHaveTextContent(/試聴/);
    expect(screen.getByText(/回り込みが増えないか確認/)).toBeInTheDocument();
    expect(screen.queryByText(/を OFF にする/)).not.toBeInTheDocument();
});

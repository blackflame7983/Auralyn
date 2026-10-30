import { noiseMeasurementApi } from '@/api/noiseMeasurement';
import { noiseMeasurementFixture } from '@/__tests__/fixtures/noiseMeasurement';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
const devices = {
    inputs: [
        { name: 'ASIO device', host: 'ASIO', channels: 2, index: 0, is_input: true, is_default: true },
        { name: 'USB mic', host: 'Wasapi', channels: 2, index: 1, is_input: true, is_default: true },
    ],
    outputs: [
        { name: 'ASIO device', host: 'ASIO', channels: 2, index: 0, is_input: false, is_default: true },
        { name: 'Headphones', host: 'Wasapi', channels: 2, index: 1, is_input: false, is_default: true },
    ],
};
const openSettings = () => render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={vi.fn()} />);
const hostSelect = () => screen.getAllByRole('combobox').find(element =>
    Array.from((element as HTMLSelectElement).options).some(option => option.value === 'Wasapi'))!;

it('ASIO能力未取得でも960サンプルの表示値と開始要求値が一致する', async () => {
    localStorage.setItem('vst_host_settings_advanced', 'true');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'ASIO device', output: 'ASIO device', bufferSize: 960, sampleRate: 48000 }));
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({
        inputs: [{ ...devices.inputs[0], channels: 0 }], outputs: [{ ...devices.outputs[0], channels: 0 }],
    });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 960, channels: 2 });
    render(<AudioSettingsModal isOpen currentBufferSize={960} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const buffer = await screen.findByRole('combobox', { name: 'バッファサイズ' });
    expect(buffer).toHaveValue('960');
    expect(screen.getByRole('option', { name: '960 サンプル' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '保存して開始' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('ASIO', 'ASIO device', 'ASIO device', 960, 48000, undefined, undefined));
});

beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('測定の詳細は選んだときだけ開き、閉じると開始した測定を取り消す', async () => {
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ noiseReductionEnabled: true, noiseReductionMode: 'low', builtInEffectsEnabled: false } as EngineRuntimeStats);
    let value = noiseMeasurementFixture();
    const request = vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(async req => {
        if (req.action === 'start') value = noiseMeasurementFixture('capturing', '1');
        return value;
    });
    render(<AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('button', { name: '測定値で調整' });
    expect(screen.getByText('周囲の音を測定').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('button', { name: '3秒測定' })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '測定値で調整' }));
    const start = await screen.findByRole('button', { name: '3秒測定' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'start', epoch: 'measurement-engine', generation: '0' }));
    await screen.findByText(/測定中/);
    fireEvent.click(screen.getByText('周囲の音を測定'));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'cancel', epoch: 'measurement-engine', generation: '1' }));
    expect(screen.queryByRole('button', { name: '3秒測定' })).not.toBeInTheDocument();
});

it('未保存で閉じて再表示してもキャッシュからホストとデバイスを選択する', async () => {
    const first = openSettings();
    await screen.findByRole('option', { name: 'ASIO device' });
    first.unmount();
    openSettings();
    await waitFor(() => expect(hostSelect()).toHaveValue('ASIO'));
    expect(screen.getByRole('option', { name: 'ASIO device' })).toBeInTheDocument();
    expect(screen.queryByText('対応デバイスなし')).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_audio_devices')).toHaveLength(1);
});

it('接続設定と即時反映の音づくりを分け、操作名を公開する', async () => {
    openSettings();
    const host = await screen.findByRole('combobox', { name: 'オーディオドライバ' });
    const input = screen.getByRole('combobox', { name: 'マイク入力' });
    expect(screen.queryByRole('switch', { name: 'ノイズ低減' })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '音づくり' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('switch', { name: 'ノイズ低減' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '内蔵ボイスチェーン' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存して開始' })).not.toBeInTheDocument();
    expect(host.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

});

it('キャッシュのみの再表示でも保存済みWASAPIの入出力を復元する', async () => {
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices));
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', input: 'USB mic', output: 'Headphones' }));
    openSettings();
    await waitFor(() => expect(hostSelect()).toHaveValue('Wasapi'));
    expect(screen.getByRole('option', { name: 'USB mic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Headphones' })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('get_audio_devices', expect.anything());
});

it('消えた保存ホストを使用可能なホストへ置き換え、手動で切り替えられる', async () => {
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices));
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Removed driver' }));
    openSettings();
    await waitFor(() => expect(hostSelect()).toHaveValue('ASIO'));
    expect(screen.getByRole('option', { name: 'ASIO device' })).toBeInTheDocument();
    // 手動切替も引き続き有効であることを確認する。
    fireEvent.change(hostSelect(), { target: { value: 'Wasapi' } });
    expect(screen.getByRole('option', { name: 'USB mic' })).toBeInTheDocument();
});

it('処理設定の取得前は音づくりを変更しない', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return new Promise(() => {});
        return null;
    });
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    expect(await screen.findByRole('switch', { name: '内蔵ボイスチェーン' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'ノイズ低減' })).toBeDisabled();
    expect(screen.getByText(/現在の設定を確認できるまで/)).toBeInTheDocument();
});

it('数値の詳細を出さない間はノイズ低減の強さを弱／強だけにし、数値の強さを出さない', async () => {
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('heading', { name: 'ノイズ低減' });
    expect(screen.queryByRole('slider', { name: 'ノイズ低減の抑制強度' })).not.toBeInTheDocument();
});

it('ノイズ低減OFF中に強度を変更してもONにせず、タッチ・ペンのpointer操作で確定する', async () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const slider = await screen.findByRole('slider', { name: 'ノイズ低減の抑制強度' });
    await waitFor(() => expect(slider).toBeEnabled());
    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.pointerUp(slider, { pointerType: 'touch' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_noise_control_config', {
        active: false, mode: 'smart', strength: 1, voiceGuard: true,
    }));
    await waitFor(() => expect(slider).toBeEnabled());
    fireEvent.blur(slider);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'set_noise_control_config')).toHaveLength(1);
});

it('声を守るの変更でも明示したON/OFF状態を維持する', async () => {
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const guard = await screen.findByRole('switch', { name: '声を守る' });
    await waitFor(() => expect(guard).toBeEnabled());
    fireEvent.click(guard);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_noise_control_config', {
        active: false, mode: 'smart', strength: 0.8, voiceGuard: false,
    }));
});

it('モードの選択だけではOFFのノイズ低減を起動しない', async () => {
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const mode = await screen.findByRole('button', { name: '強' });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.click(mode);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_noise_control_config', {
        active: false, mode: 'high', strength: 0.8, voiceGuard: true,
    }));
});

it('学習の中止失敗を未処理のPromise拒否にせず、状態再取得から再試行できる', async () => {
    vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(async request => {
        if (request.action === 'cancel') throw new Error('offline');
        return noiseMeasurementFixture('capturing', '2');
    });
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    fireEvent.click(screen.getByText('周囲の音を測定'));
    const cancel = await screen.findByRole('button', { name: '測定を中止' });
    await waitFor(() => expect(cancel).toBeEnabled());
    fireEvent.click(cancel);
    expect(await screen.findByText('測定状態を取得できません。再取得してください。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '状態を再取得' })).toBeEnabled();
});

it('不正な入力で学習が失敗したら、以前のプロファイルを今回の成功と表示しない', async () => {
    vi.spyOn(noiseMeasurementApi, 'request').mockResolvedValue({ ...noiseMeasurementFixture('invalid', '2'), quality: ['nonFinite'], previousAvailable: true });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({
        noiseReductionEnabled: true, noiseLearningState: 'invalid', noiseProfileAvailable: true,
        noiseProfileRms: 0.01,
    } as EngineRuntimeStats);
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    fireEvent.click(screen.getByText('周囲の音を測定'));
    expect(await screen.findByText('この測定は利用できません。条件を確認して測り直してください。')).toBeInTheDocument();
    expect(screen.queryByText(/学習済み RMS/)).not.toBeInTheDocument();
});

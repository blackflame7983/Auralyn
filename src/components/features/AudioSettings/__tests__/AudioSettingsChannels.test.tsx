import { audioApi } from '@/api/audio';
import { openSystemTab } from './settingsActions';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';
import { InputChannelSelector } from '../InputChannelSelector';
import { listen } from '@tauri-apps/api/event';
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const devices = {
    inputs: [
        { name: 'ASIO device', host: 'ASIO', channels: 22 },
        { name: 'Cable input', host: 'Wasapi', channels: 2 },
    ],
    outputs: [
        { name: 'ASIO device', host: 'ASIO', channels: 22 },
        { name: 'Test output', host: 'Wasapi', channels: 2 },
    ],
};
beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
        'vst_host_audio_config',
        JSON.stringify({
            host: 'ASIO',
            input: 'ASIO device',
            output: 'ASIO device',
            inputChannels: [6, 7],
        })
    );
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_audio_devices') return devices;
        if (cmd === 'start_audio' || cmd === 'restart_audio_engine')
            return { sample_rate: 48000, buffer_size: 512, channels: 2 };
        if (cmd === 'get_autostart_status') return { enabled: false };
        return null;
    });
});
afterEach(() => {
    cleanup();
    localStorage.clear();
});

it.each([2, 64])('未取得のチャンネルは選べず、取得後は実際の%ich分だけを表示する', async channels => {
    const view = render(<InputChannelSelector maxChannels={0} initialChannels={[2, 3]} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText(/入力チャンネル数が未確認/)).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'set_input_channels')).toBe(false);
    view.rerender(<InputChannelSelector maxChannels={channels} />);
    if (channels > 8) fireEvent.click(screen.getByRole('button', { name: 'すべての入力ペアを表示' }));
    expect(screen.getAllByRole('radio')).toHaveLength(channels / 2);
    expect(screen.queryByText(/入力チャンネル数が未確認/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 1/2' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 0, right: 1 }));
});

it('多入力では選択中と信号のあるペアを残し、全ペアを展開して選び直せる', async () => {
    let scan: (event: { payload: number[] }) => void = () => {};
    vi.mocked(listen).mockImplementation(async (event, handler) => {
        if (event === 'audio-channel-scan') scan = handler as typeof scan;
        return () => {};
    });
    render(<InputChannelSelector maxChannels={22} initialChannels={[20, 21]} />);
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radio', { name: '入力チャンネル 21/22' })).toBeChecked();
    act(() => scan({ payload: Array.from({ length: 22 }, (_, i) => i === 16 ? 0.2 : 0) }));
    expect(screen.getByRole('radio', { name: '入力チャンネル 17/18' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'すべての入力ペアを表示' }));
    expect(screen.getAllByRole('radio')).toHaveLength(11);
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 13/14' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '入力チャンネル 13/14' })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '入力ペアを少なく表示' }));
    expect(screen.getByRole('radio', { name: '入力チャンネル 13/14' })).toBeVisible();
});

it.each(['保存して開始', '音声エンジンを再起動'])(
    'ASIOからWASAPIの%sでエンジンと保存値を0/1へ更新する',
    async (action) => {
        const update = vi.fn();
        render(
            <AudioSettingsModal
                isOpen
                onClose={() => {}}
                onConfigChange={update}
                currentInputChannels={[6, 7]}
            />
        );
        await screen.findByRole('option', { name: 'Wasapi' });
        const host = screen
            .getAllByRole('combobox')
            .find((e) =>
                Array.from((e as HTMLSelectElement).options).some((o) => o.value === 'Wasapi')
            )!;
        fireEvent.change(host, { target: { value: 'Wasapi' } });
        if (action === '音声エンジンを再起動') await openSystemTab();
        fireEvent.click(screen.getByRole('button', { name: action }));
        if (action === '音声エンジンを再起動')
            fireEvent.click(await screen.findByRole('button', { name: '再起動する' }));
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith(
                expect.objectContaining({ host: 'Wasapi', inputChannels: [0, 1] }), { audioStarted: true }
            )
        );
        expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 0, right: 1 });
    }
);

it('ASIOを維持する保存では6/7を維持する', async () => {
    const update = vi.fn();
    render(
        <AudioSettingsModal
            isOpen
            onClose={() => {}}
            onConfigChange={update}
            currentInputChannels={[6, 7]}
        />
    );
    await screen.findByRole('option', { name: 'ASIO device' });
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ host: 'ASIO', inputChannels: [6, 7] }), { audioStarted: true }
        )
    );
    expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 6, right: 7 });
});

it('入力ペアは同じ名前の標準ラジオとして選択・復元できる', async () => {
    const mapped = vi.fn();
    const view = render(<InputChannelSelector initialChannels={[2, 3]} maxChannels={6} onChannelMapped={mapped} />);
    const group = screen.getByRole('group', { name: '入力チャンネルの選択' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    expect(new Set(radios.map(radio => radio.name)).size).toBe(1);
    expect(screen.getByRole('radio', { name: '入力チャンネル 3/4' })).toBeChecked();
    const last = screen.getByRole('radio', { name: '入力チャンネル 5/6' });
    last.focus();
    fireEvent.click(last);
    await waitFor(() => expect(mapped).toHaveBeenCalledWith([4, 5]));
    expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 4, right: 5 });
    expect(last).toBeChecked();
    expect(last).toHaveFocus();
    view.rerender(<InputChannelSelector initialChannels={[0, 1]} maxChannels={6} onChannelMapped={mapped} />);
    expect(screen.getByRole('radio', { name: '入力チャンネル 1/2' })).toBeChecked();
});

it('端数のチャンネルでも既存どおり末尾ペアを表示してマッピングする', async () => {
    const mapped = vi.fn();
    render(<InputChannelSelector maxChannels={3} onChannelMapped={mapped} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 3/4' }));
    await waitFor(() => expect(mapped).toHaveBeenCalledWith([2, 3]));
});

it('マッピング失敗では元の選択を保ち、成功する再試行まで親へ通知しない', async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'set_input_channels' && fail) throw new Error('mapping failed');
        return null;
    });
    const mapped = vi.fn();
    render(<InputChannelSelector maxChannels={4} onChannelMapped={mapped} />);
    const target = screen.getByRole('radio', { name: '入力チャンネル 3/4' });
    fireEvent.click(target);
    expect(await screen.findByRole('alert')).toHaveTextContent('入力チャンネルを変更できませんでした');
    expect(screen.getByRole('radio', { name: '入力チャンネル 1/2' })).toBeChecked();
    expect(mapped).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(target);
    await waitFor(() => expect(mapped).toHaveBeenCalledWith([2, 3]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('監視データ待ちと継続監視を区別し、信号を日本語で示す', async () => {
    const view = render(<InputChannelSelector maxChannels={4} />);
    await screen.findByText(/信号データを待っています/);
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-channel-scan')![1];
    act(() => callback({ event: 'audio-channel-scan', id: 1, payload: [0, 0, 0.2, 0] }));
    expect(screen.getByText('信号を継続して監視しています。')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '入力チャンネル 3/4' })).toHaveAccessibleDescription('信号あり');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(view.container.querySelector('.animate-pulse')).toBeNull();
    view.rerender(<InputChannelSelector maxChannels={6} />);
    expect(screen.getByText(/信号データを待っています/)).toBeInTheDocument();
    expect(screen.getAllByText('信号未検出')).toHaveLength(3);
});

it.each(['set_channel_scan', 'listen'])('監視開始の%s失敗を表示して選択は維持する', async failure => {
    if (failure === 'listen') vi.mocked(listen).mockRejectedValue(new Error('listen failed'));
    else vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'set_channel_scan') throw new Error('scan failed');
        return null;
    });
    render(<InputChannelSelector initialChannels={[2, 3]} maxChannels={4} />);
    await screen.findByText(/信号監視を開始できませんでした/);
    expect(screen.getByRole('radio', { name: '入力チャンネル 3/4' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '入力チャンネル 1/2' })).toBeEnabled();
});

it('遅い購読の完了が画面終了後なら解除し、監視を開始しない', async () => {
    let resolveListener!: (unsubscribe: () => void) => void;
    vi.mocked(listen).mockImplementation(() => new Promise(resolve => { resolveListener = resolve; }));
    const unsubscribe = vi.fn();
    const view = render(<InputChannelSelector />);
    view.unmount();
    await act(async () => resolveListener(unsubscribe));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('set_channel_scan', { active: true });
    expect(invoke).toHaveBeenCalledWith('set_channel_scan', { active: false });
});

it('監視終了の失敗も回収する', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'set_channel_scan' && (args as { active: boolean }).active === false) throw new Error('stop failed');
        return null;
    });
    const view = render(<InputChannelSelector />);
    await screen.findByText(/信号データを待っています/);
    view.unmount();
    await waitFor(() => expect(warning).toHaveBeenCalledWith('入力チャンネルの信号監視を停止できませんでした。'));
    warning.mockRestore();
});

beforeEach(() => { vi.spyOn(audioApi, 'getEngineTuningConfig').mockResolvedValue({ enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false }); });

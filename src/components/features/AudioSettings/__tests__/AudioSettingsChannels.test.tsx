import { audioApi } from '@/api/audio';
import { StrictMode } from 'react';
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
    expect(invoke).not.toHaveBeenCalledWith('set_input_channels', expect.anything());
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

it.each(['保存して開始', '音声処理を再起動'])(
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
        if (action === '音声処理を再起動') await openSystemTab();
        fireEvent.click(screen.getByRole('button', { name: action }));
        if (action === '音声処理を再起動')
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
    expect(invoke).not.toHaveBeenCalledWith('set_input_channels', expect.anything());
    expect(last).toBeChecked();
    expect(last).toHaveFocus();
    view.rerender(<InputChannelSelector initialChannels={[0, 1]} maxChannels={6} onChannelMapped={mapped} />);
    expect(screen.getByRole('radio', { name: '入力チャンネル 1/2' })).toBeChecked();
});

it('端数の最後のチャンネルをモノラルで選択する', async () => {
    const mapped = vi.fn();
    render(<InputChannelSelector maxChannels={3} onChannelMapped={mapped} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 3/3' }));
    await waitFor(() => expect(mapped).toHaveBeenCalledWith([2, 2]));
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
    expect(screen.getAllByText('未測定')).toHaveLength(3);
});

it.each(['set_channel_scan', 'listen'])('監視開始の%s失敗を表示して選択は維持する', async failure => {
    if (failure === 'listen') vi.mocked(listen).mockRejectedValue(new Error('listen failed'));
    else vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'set_channel_scan') throw new Error('scan failed');
        return null;
    });
    render(<InputChannelSelector initialChannels={[2, 3]} maxChannels={4} />);
    await screen.findByText(/信号監視を切り替えられませんでした/);
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
    expect(invoke).not.toHaveBeenCalledWith('set_channel_scan', { active: false });
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

it('監視範囲外のペアは未測定でも選択できる', async () => {
    const mapped = vi.fn();
    render(<InputChannelSelector maxChannels={34} onChannelMapped={mapped} />);
    await screen.findByText(/信号データを待っています/);
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-channel-scan')![1];
    act(() => callback({ event: 'audio-channel-scan', id: 1, payload: Array(32).fill(0) }));
    fireEvent.click(screen.getByRole('button', { name: 'すべての入力ペアを表示' }));
    const target = screen.getByRole('radio', { name: '入力チャンネル 33/34' });
    expect(target).toHaveAccessibleDescription('未測定');
    fireEvent.click(target);
    expect(mapped).toHaveBeenCalledWith([32, 33]);
});

it('監視対象でない機器は購読せず未測定と表示する', () => {
    render(<InputChannelSelector maxChannels={4} monitorEnabled={false} />);
    expect(screen.getByText(/現在の接続と異なる/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '入力チャンネル 1/2' })).toHaveAccessibleDescription('未測定');
    expect(listen).not.toHaveBeenCalled();
});

it('ペア変更は下書きであり、保存開始後にのみ適用する', async () => {
    const update = vi.fn();
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={update} currentInputChannels={[6, 7]} />);
    const pair = await screen.findByRole('radio', { name: '入力チャンネル 3/4' });
    fireEvent.click(pair);
    expect(update).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('set_input_channels', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ inputChannels: [2, 3] }), { audioStarted: true }));
    expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 2, right: 3 });
});


it('現在のレートと 88.2 / 192 kHz を選択肢に残す', async () => {
    localStorage.setItem('vst_host_settings_advanced', 'true');
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={vi.fn()} currentSampleRate={176400} />);
    const rate = await screen.findByRole('combobox', { name: 'サンプルレート' });
    expect(rate).toHaveValue('176400');
    expect(within(rate).getByRole('option', { name: '88.2 kHz' })).toBeInTheDocument();
    expect(within(rate).getByRole('option', { name: '192.0 kHz' })).toBeInTheDocument();
});

it('同じチャンネル数の別機器では下書きと信号表示を引き継がない', async () => {
    const twoDevices = { inputs: [
        { name: 'First', id: 'first', host: 'ASIO', channels: 4 },
        { name: 'Second', id: 'second', host: 'ASIO', channels: 4 },
    ], outputs: [{ name: 'First', id: 'first-out', host: 'ASIO', channels: 4 }] };
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'First', output: 'First' }));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return twoDevices;
        if (command === 'get_audio_state') return { is_running: true, config: { host: 'ASIO', input_id: 'first' } };
        if (command === 'auto_gain') return { running: true, streamFailed: false };
        return null;
    });
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={vi.fn()} currentInputChannels={[0, 1]} />);
    await screen.findByRole('option', { name: 'Second' });
    await waitFor(() => expect(listen).toHaveBeenCalledWith('audio-channel-scan', expect.any(Function)));
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-channel-scan')![1];
    act(() => callback({ event: 'audio-channel-scan', id: 1, payload: [0, 0, 0.2, 0] }));
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 3/4' }));
    const input = screen.getAllByRole('combobox').find(element => Array.from((element as HTMLSelectElement).options).some(option => option.value === 'id:second'))!;
    fireEvent.change(input, { target: { value: 'id:second' } });
    expect(screen.getByRole('radio', { name: '入力チャンネル 1/2' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '入力チャンネル 3/4' })).toHaveAccessibleDescription('未測定');
    expect(screen.getByText(/現在の接続と異なる/)).toBeInTheDocument();
});


it('遅い監視開始を待ってから最後の停止を送り、監視を復活させない', async () => {
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'set_channel_scan' && (args as { active: boolean }).active) await new Promise<void>(resolve => { finish = resolve; });
        return null;
    });
    const view = render(<InputChannelSelector maxChannels={4} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    view.unmount();
    expect(invoke).not.toHaveBeenCalledWith('set_channel_scan', { active: false });
    await act(async () => { finish(); });
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('set_channel_scan', { active: false }));
});

it('複数利用では片方の終了で停止せず、最後の終了で停止する', async () => {
    const first = render(<InputChannelSelector maxChannels={4} />);
    const second = render(<InputChannelSelector maxChannels={4} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_channel_scan', { active: true }));
    first.unmount();
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalledWith('set_channel_scan', { active: false });
    second.unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_channel_scan', { active: false }));
});

it('StrictModeの再購読でも最後の利用終了時に監視を止める', async () => {
    const view = render(<StrictMode><InputChannelSelector maxChannels={4} /></StrictMode>);
    await screen.findByText(/信号データを待っています/);
    view.unmount();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('set_channel_scan', { active: false }));
});

it('開始失敗後に再試行できる', async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'set_channel_scan' && (args as { active: boolean }).active && fail) throw new Error('start failed');
        return null;
    });
    render(<InputChannelSelector maxChannels={4} />);
    await screen.findByText(/信号監視を切り替えられませんでした/);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByText(/信号データを待っています/);
});

it('機器変更時の停止失敗は表示し、停止を再試行できる', async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'set_channel_scan' && !(args as { active: boolean }).active && fail) throw new Error('stop failed');
        return null;
    });
    const view = render(<InputChannelSelector maxChannels={4} />);
    await screen.findByText(/信号データを待っています/);
    view.rerender(<InputChannelSelector maxChannels={4} monitorEnabled={false} />);
    await screen.findByText(/信号監視を切り替えられませんでした/);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByText(/現在の接続と異なる/);
    expect(invoke).toHaveBeenLastCalledWith('set_channel_scan', { active: false });
});


it('稼働中にエンジンが再起動したら監視を再適用する', async () => {
    render(<InputChannelSelector maxChannels={4} />);
    await screen.findByText(/信号データを待っています/);
    const started = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-started')![1];
    expect(vi.mocked(invoke).mock.calls.filter(([name, args]) => name === 'set_channel_scan' && (args as { active: boolean }).active)).toHaveLength(1);
    await act(async () => started({ event: 'audio-started', id: 1, payload: undefined }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([name, args]) => name === 'set_channel_scan' && (args as { active: boolean }).active)).toHaveLength(2));
});

it('終了後に完了した古い開始通知の購読を解除し、新しい利用を維持する', async () => {
    let finish!: (stop: () => void) => void;
    let first = true;
    vi.mocked(listen).mockImplementation((event) => {
        if (event === 'audio-started' && first) { first = false; return new Promise(resolve => { finish = resolve; }); }
        return Promise.resolve(() => {});
    });
    const old = render(<InputChannelSelector maxChannels={4} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    old.unmount();
    const current = render(<InputChannelSelector maxChannels={4} />);
    await screen.findByText(/信号データを待っています/);
    const stopOld = vi.fn();
    await act(async () => { finish(stopOld); });
    expect(stopOld).toHaveBeenCalledOnce();
    expect(screen.getByText(/信号データを待っています/)).toBeInTheDocument();
    current.unmount();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('set_channel_scan', { active: false }));
});


it('古い利用の購読失敗は新しい監視を止めない', async () => {
    let rejectOld!: (error: Error) => void;
    let first = true;
    vi.mocked(listen).mockImplementation(event => {
        if (event === 'audio-started' && first) { first = false; return new Promise((_, reject) => { rejectOld = reject; }); }
        return Promise.resolve(() => {});
    });
    const old = render(<InputChannelSelector maxChannels={4} />);
    await waitFor(() => expect(rejectOld).toBeTypeOf('function'));
    old.unmount();
    render(<InputChannelSelector maxChannels={4} />);
    await screen.findByText(/信号データを待っています/);
    await act(async () => rejectOld(new Error('old subscription failed')));
    expect(screen.getByText(/信号データを待っています/)).toBeInTheDocument();
    expect(screen.queryByText(/信号監視を切り替えられませんでした/)).not.toBeInTheDocument();
});


it('取得済みのASIO範囲外を無効にし、現在値と未取得側を表示する', async () => {
    localStorage.setItem('vst_host_settings_advanced', 'true');
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return {
            inputs: [{ ...devices.inputs[0], sample_rate_ranges: [[48000, 96000]] }],
            outputs: [{ ...devices.outputs[0] }],
        };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={vi.fn()} currentSampleRate={176400} />);
    const rate = await screen.findByRole('combobox', { name: 'サンプルレート' });
    await waitFor(() => expect(within(rate).getByRole('option', { name: '44.1 kHz （非対応）' })).toBeDisabled());
    expect(rate).toHaveValue('176400');
    expect(within(rate).getByRole('option', { name: '176.4 kHz （非対応）' })).toBeDisabled();
    expect(within(rate).getByRole('option', { name: '88.2 kHz' })).toBeEnabled();
    expect(screen.getByText('出力の対応レートは未確認です。')).toBeInTheDocument();
    expect(screen.getByText('現在の選択値は確認済みの対応範囲外です。')).toBeInTheDocument();
});


it('同名の入出力をIDで復元・選び直し、選んだIDで開始と保存を行う', async () => {
    const input = (id: string) => ({ name: '同名マイク', id, host: 'Wasapi', channels: 2 });
    const output = (id: string) => ({ name: '同名出力', id, host: 'Wasapi', channels: 2 });
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', input: '同名マイク', output: '同名出力', inputId: 'mic-b', outputId: 'out-b' }));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: [input('mic-a'), input('mic-b')], outputs: [output('out-a'), output('out-b')] };
        if (command === 'start_audio') return { sample_rate: 48000, buffer_size: 512, channels: 2 };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
    const update = vi.fn();
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={update} />);
    const micB = await screen.findByRole('option', { name: '同名マイク (mic-b)' });
    const inputSelect = micB.closest('select')!;
    const outputSelect = screen.getByRole('option', { name: '同名出力 (out-b)' }).closest('select')!;
    await waitFor(() => expect(inputSelect).toHaveValue('id:mic-b'));
    expect(outputSelect).toHaveValue('id:out-b');
    fireEvent.change(inputSelect, { target: { value: 'id:mic-a' } });
    fireEvent.change(outputSelect, { target: { value: 'id:out-a' } });
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ input: '同名マイク', inputId: 'mic-a', output: '同名出力', outputId: 'out-a' }), { audioStarted: true }));
    expect(invoke).toHaveBeenCalledWith('start_audio', expect.objectContaining({ input: '同名マイク', inputId: 'mic-a', output: '同名出力', outputId: 'out-a' }));
});

it('IDを保存していない同名機器は勝手に選択しない', async () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', input: '同名マイク', output: '出力' }));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: [{ name: '同名マイク', id: 'a', host: 'Wasapi', channels: 2 }, { name: '同名マイク', id: 'b', host: 'Wasapi', channels: 2 }], outputs: [{ name: '出力', id: 'out', host: 'Wasapi', channels: 2 }] };
        return null;
    });
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={vi.fn()} />);
    const option = await screen.findByRole('option', { name: '同名マイク (a)' });
    expect(option.closest('select')).toHaveValue('');
    expect(screen.getByRole('button', { name: '保存して開始' })).toBeDisabled();
});


it('開始後の入力設定失敗を明示し、同じ下書きの再試行で開始を繰り返さない', async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'start_audio') return { sample_rate: 48000, buffer_size: 512, channels: 2 };
        if (command === 'set_input_channels' && fail) { fail = false; throw new Error('channels failed'); }
        return null;
    });
    const save = vi.fn();
    render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={save} currentInputChannels={[6, 7]} />);
    await screen.findByRole('option', { name: 'ASIO device' });
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await screen.findByText(/音声は開始済みですが、入力チャンネルの設定が完了していません/);
    fireEvent.click(screen.getByRole('button', { name: '設定に戻って再試行' }));
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'start_audio')).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'set_input_channels')).toHaveLength(2);
});

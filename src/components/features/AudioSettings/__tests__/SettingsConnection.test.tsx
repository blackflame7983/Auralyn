import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { useState } from 'react';
import type { AudioPreferences } from '@/lib/audioPreferences';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
const config = { host: 'Wasapi', input: 'Mic', output: 'Headphones', sampleRate: 48000, bufferSize: 512 };
const devices = {
    inputs: [{ host: 'Wasapi', name: 'Mic', channels: 2, is_input: true, is_default: true, index: 0 }],
    outputs: [{ host: 'Wasapi', name: 'Headphones', channels: 2, is_input: false, is_default: true, index: 0 }],
};
beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

it.each(['ja', 'en'] as const)('開始失敗後に状態不明でも失敗理由と再開始しなかった案内を表示する (%s)', async locale => {
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    const start = vi.spyOn(audioApi, 'start').mockRejectedValue(new Error('Device start rejected'));
    const changed = vi.fn();
    const close = vi.fn();
    const before = localStorage.getItem('vst_host_audio_config');
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <AudioSettingsModal isOpen currentConfig={config} onClose={close} onConfigChange={changed} />
    </LocaleProvider>);
    fireEvent.click(await screen.findByRole('button', { name: message(locale, 'settings.AudioSettingsModal.197') }));
    expect(await screen.findByText(message(locale, 'settings.AudioSettingsModal.017', { arg0: 'Error: Device start rejected' }))).toBeVisible();
    expect(screen.getByText(message(locale, 'settings.startUnknown'))).toBeVisible();
    expect(start).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(localStorage.getItem('vst_host_audio_config')).toBe(before);
});

it('空の現在設定では自動選択を変更予定にせず、初回に開始する機器を示す', async () => {
    localStorage.removeItem('vst_host_audio_config');
    render(<AudioSettingsModal isOpen currentConfig={{ host: '' }} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    expect(screen.queryByText(/^変更予定：/)).not.toBeInTheDocument();
    expect(screen.getByText('初回設定：WASAPI・Mic → Headphonesで開始します')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接続を保存して開始' })).toBeEnabled();
});

it.each([null, 'unreadable'])('保存が%sなら復帰ボタンと説明を表示しない', async saved => {
    localStorage.clear();
    const read = vi.spyOn(audioApi, 'getSavedAudioConfig');
    if (saved === null) read.mockResolvedValue(null); else read.mockRejectedValue(new Error('unreadable'));
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    await screen.findByRole('combobox', { name: 'マイク' });
    expect(screen.queryByRole('button', { name: '保存済みの音声設定を読み込む' })).not.toBeInTheDocument();
    expect(screen.queryByText('画面の設定が空でも、このアプリに残る音声設定を読み込めます。読み込みだけでは音声を開始しません。')).not.toBeInTheDocument();
});

it('画面側の設定が空でも保存済みの接続を明示復帰し、音声は開始しない', async () => {
    localStorage.clear();
    vi.spyOn(audioApi, 'getSavedAudioConfig').mockResolvedValue({ host: 'Wasapi', input: 'Mic', output: 'Headphones', sample_rate: 48000, buffer_size: 256 });
    const start = vi.spyOn(audioApi, 'start');
    function Parent() {
        const [current, setCurrent] = useState<AudioPreferences>({ host: '' });
        return <AudioSettingsModal isOpen currentConfig={current} onClose={vi.fn()} onConfigChange={config => {
            localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
            setCurrent(config);
        }} />;
    }
    render(<Parent />);
    fireEvent.click(await screen.findByRole('button', { name: '保存済みの音声設定を読み込む' }));
    await screen.findByText('保存済みの音声設定を読み込みました。内容を確認してから開始してください。');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config')!).bufferSize).toBe(256);
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '保存済みの音声設定を読み込む' })).not.toBeInTheDocument();
});

it('開始失敗では保存した選択を保持し、設定を開き直して直前の接続へ戻れる', async () => {
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ ...devices, inputs: [...devices.inputs, { ...devices.inputs[0], name: 'Failed microphone', index: 1 }] });
    vi.spyOn(audioApi, 'start').mockRejectedValue(new Error('Device start rejected'));
    const before = localStorage.getItem('vst_host_audio_config');
    const changed = vi.fn();
    const view = render(<AudioSettingsModal isOpen currentConfig={config} onClose={vi.fn()} onConfigChange={changed} />);
    const input = await screen.findByRole('combobox', { name: 'マイク' });
    await waitFor(() => expect(input).toHaveValue('Mic'));
    fireEvent.change(input, { target: { value: 'Failed microphone' } });
    fireEvent.click(screen.getByRole('button', { name: '接続を保存して開始' }));
    await screen.findByText(/Device start rejected/);
    expect(changed).not.toHaveBeenCalled();
    expect(localStorage.getItem('vst_host_audio_config')).toBe(before);
    view.unmount();
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={changed} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
});

it.each(['channels', 'save'] as const)('システム再起動の%s失敗から接続画面で再試行してVST復元まで完了する', async stage => {
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const start = vi.spyOn(audioApi, 'start');
    const channels = vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
    if (stage === 'channels') restart.mockRejectedValueOnce(new Error('input setting failed'));
    const save = vi.fn().mockResolvedValue(undefined);
    if (stage === 'save') save.mockRejectedValueOnce(new Error('storage failed'));
    const restored = vi.fn().mockResolvedValue(undefined);
    const closed = vi.fn();
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={closed} onConfigChange={save} onEngineRestarted={restored} />);
    await screen.findByRole('button', { name: '接続を保存して再起動' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
    const button = await screen.findByRole('button', { name: '音声処理を再起動' });
    await waitFor(() => expect(button).toBeEnabled());
    button.focus();
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: '再起動する' }));
    await screen.findByText(stage === 'channels' ? /input setting failed/ : /storage failed/);
    fireEvent.click(await screen.findByRole('button', { name: '設定に戻って再試行' }));
    const retry = await screen.findByRole('button', { name: '接続を保存して再起動' });
    expect(retry).toBeEnabled();
    expect(restored).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(restart).toHaveBeenCalledTimes(stage === 'channels' ? 2 : 1);
    expect(start).not.toHaveBeenCalled();
    expect(channels).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(stage === 'save' ? 2 : 1);
    expect(restored).toHaveBeenCalledOnce();
});

it.each(['ASIO', 'Wasapi'])('別hostのプリセットで先頭以外の入出力を復元する（変更前=%s）', async previousHost => {
    const targetHost = previousHost === 'ASIO' ? 'Wasapi' : 'ASIO';
    const items = ['ASIO', 'Wasapi'].flatMap(host => [1, 2].map(index => ({
        host, name: `${host} device ${index}`, id: `${host}-${index}`, channels: 4,
    })));
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: previousHost, input: `${previousHost} device 1`, output: `${previousHost} device 1`, sampleRate: 48000, bufferSize: 512 }));
    localStorage.setItem('vst_host_audio_presets', JSON.stringify({ target: {
        host: targetHost, input: `${targetHost} device 2`, output: `${targetHost} device 2`, sampleRate: 48000, bufferSize: 512,
    } }));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: items, outputs: items };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const input = await screen.findByRole('combobox', { name: previousHost === 'ASIO' ? '機器' : 'マイク' });
    await waitFor(() => expect(input).toHaveValue(`id:${previousHost}-1`));
    fireEvent.change(screen.getByRole('combobox', { name: '入出力プリセット' }), { target: { value: 'target' } });
    await waitFor(() => expect(input).toHaveValue(`id:${targetHost}-2`));
    fireEvent.click(screen.getByRole('button', { name: '接続を保存して開始' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(targetHost, `${targetHost} device 2`, `${targetHost} device 2`, 512, 48000, `${targetHost}-2`, `${targetHost}-2`, undefined, expect.objectContaining({ outputRouting: expect.any(Object) }), { source: { kind: "device", config: { purpose: "voice" } } }));
});

it('稼働中の変更なし保存を抑止し、変更を戻すと再び抑止する', async () => {
    const start = vi.spyOn(audioApi, 'start');
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const save = await screen.findByRole('button', { name: '接続を保存して再起動' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(/変更はありません.*音声が一瞬途切れます/);
    fireEvent.click(save);
    expect(start).not.toHaveBeenCalled();
    const summary = screen.getByText('接続方式・音切れの設定', { exact: false, selector: 'summary' });
    fireEvent.click(summary);
    await waitFor(() => expect(summary.closest('details')).toHaveAttribute('open'));
    fireEvent.click(await screen.findByRole('radio', { name: '途切れにくく' }));
    expect(save).toBeEnabled();
    expect(screen.getByText('変更予定：音の途切れにくさ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '標準' }));
    expect(save).toBeDisabled();
});

it('停止中の変更なしでも明示開始できる', async () => {
    render(<AudioSettingsModal isOpen isAudioRunning={false} currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: '接続を保存して開始' })).toBeEnabled();
});

it.each([false, true])('入力ペアの下書きだけでは保存せず、明示適用後に接続先とともに保存する（機器変更=%s）', async changeDevice => {
    const applied: AudioPreferences = { host: 'ASIO', input: 'Device A', output: 'Device A', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] };
    localStorage.setItem('vst_host_audio_config', JSON.stringify(applied));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return {
            inputs: ['Device A', 'Device B'].map(name => ({ name, host: 'ASIO', channels: 4 })),
            outputs: ['Device A', 'Device B'].map(name => ({ name, host: 'ASIO', channels: 4 })),
        };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 4 });
    const changed = vi.fn();
    function Parent() {
        const [current, setCurrent] = useState(applied);
        return <AudioSettingsModal isOpen isAudioRunning currentConfig={current} currentInputChannels={current.inputChannels}
            onClose={vi.fn()} onConfigChange={(update, options) => {
                changed(update, options);
                setCurrent(previous => ({ ...previous, ...update }));
            }} />;
    }
    render(<Parent />);
    const input = await screen.findByRole('combobox', { name: '機器' });
    await waitFor(() => expect(input).toHaveValue('Device A'));
    const save = screen.getByRole('button', { name: '接続を保存して再起動' });
    expect(save).toBeDisabled();
    if (changeDevice) fireEvent.change(input, { target: { value: 'Device B' } });
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 3/4' }));
    expect(changed).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    const selected = changeDevice ? 'Device B' : 'Device A';
    await waitFor(() => expect(start).toHaveBeenCalledWith('ASIO', selected, selected, 512, 48000, undefined, undefined, undefined, expect.objectContaining({ inputChannels: [2, 3] }), { source: { kind: "device", config: { purpose: "voice" } } }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ host: 'ASIO', input: selected, output: selected, inputChannels: [2, 3] }), { audioStarted: true }));
});

it('設定画面内で開始後の反映に失敗しても、稼働中の同じ設定を再試行できる', async () => {
    const change = vi.fn().mockRejectedValueOnce(new Error('storage failed')).mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const props = { isOpen: true, currentConfig: config, onClose: vi.fn(), onConfigChange: change };
    const view = render(<AudioSettingsModal {...props} isAudioRunning={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '接続を保存して開始' }));
    await screen.findByRole('button', { name: '設定に戻って再試行' });
    view.rerender(<AudioSettingsModal {...props} isAudioRunning />);
    fireEvent.click(screen.getByRole('button', { name: '設定に戻って再試行' }));
    const retry = await screen.findByRole('button', { name: '接続を保存して再起動' });
    expect(retry).toBeEnabled();
    expect(retry).toHaveAccessibleDescription(/設定の反映を再試行します/);
    fireEvent.click(retry);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
});

it('3択にない256サンプルは数値指定として開き、選択状態を公開する', async () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ ...config, bufferSize: 256 }));
    render(<AudioSettingsModal isOpen currentBufferSize={256} initialSection="audioTuning" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const numeric = await screen.findByRole('radio', { name: '数値で指定' });
    await waitFor(() => expect(numeric).toHaveAttribute('aria-checked', 'true'));
    expect(numeric.closest('[role="radiogroup"]')?.querySelector('[data-segment-indicator]')).toHaveClass('border-segment-accent');
    expect(screen.getByRole('radio', { name: 'おまかせ' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('combobox', { name: 'バッファサイズ' })).toHaveValue('256');
});

it.each(['numeric', 'glitch'] as const)('%sの条件では途切れ設定を開く', async reason => {
    if (reason === 'numeric') localStorage.setItem('vst_host_beginner_mode', 'false');
    else vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ glitchCount: 1 } as EngineRuntimeStats);
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const summary = await screen.findByText('接続方式・音切れの設定', { exact: false, selector: 'summary' });
    await waitFor(() => expect(summary.closest('details')).toHaveAttribute('open'));
});

it('通常は現在値付きで閉じ、再検出の操作領域を確保する', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const summary = await screen.findByText('接続方式・音切れの設定', { exact: false, selector: 'summary' });
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(summary).toHaveTextContent('標準 · 48 kHz');
    expect(screen.getByRole('button', { name: '機器を再検出' })).toHaveClass('min-h-9');
});


it('入力元・マイク・出力先は同じカードと見出しの階層で区切る', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'マイク' });
    for (const name of ['入力元と用途', 'マイク', '出力先']) {
        const group = screen.getByRole('group', { name });
        expect(group.tagName).toBe('FIELDSET');
        expect(group).toHaveClass('rounded-card', 'border', 'border-border', 'p-3');
        expect(group.querySelector('legend')).toHaveClass('text-ui-heading', 'font-semibold');
    }
});

it('音楽の入力欄は見える名前と読み上げ名をPCの音にそろえる', async () => {
    localStorage.setItem('vst_host_setup_goal', 'music');
    render(<AudioSettingsModal isOpen currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const input = await screen.findByRole('combobox', { name: 'PCの音' });
    expect(screen.getByText('PCの音', { selector: 'label' })).toHaveAttribute('for', input.id);
});


it.each([['Asio', 'saved-id', undefined], ['ASIO', undefined, 'listed-id']] as const)('保存済み%s・ID差でも復帰した入力と出力ペアを保つ', async (host, savedId, listedId) => {
    localStorage.clear();
    const item = { name: 'Interface', id: listedId, host: 'ASIO', channels: 8, index: 0, is_default: true };
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [{ ...item, is_input: true }], outputs: [{ ...item, is_input: false }] });
    vi.spyOn(audioApi, 'getSavedAudioConfig').mockResolvedValue({ host, input: item.name, input_id: savedId, output: item.name, output_id: savedId,
        sample_rate: 48000, buffer_size: 512, routing: { inputChannels: [4, 5], outputRouting: { mode: 'independent', channels: [6, 7] } } });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 8 });
    function Parent() {
        const [current, setCurrent] = useState<AudioPreferences>({ host: '' });
        return <AudioSettingsModal isOpen currentConfig={current} onClose={vi.fn()} onConfigChange={next => {
            localStorage.setItem('vst_host_audio_config', JSON.stringify(next)); setCurrent(previous => ({ ...previous, ...next }));
        }} />;
    }
    render(<Parent />);
    fireEvent.click(await screen.findByRole('button', { name: '保存済みの音声設定を読み込む' }));
    await screen.findByText('保存済みの音声設定を読み込みました。内容を確認してから開始してください。');
    fireEvent.click(screen.getByRole('button', { name: '接続を保存して開始' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('ASIO', item.name, item.name, 512, 48000, listedId, listedId, undefined,
        { inputChannels: [4, 5], outputRouting: { mode: 'independent', channels: [6, 7] } }, expect.anything()));
});

it('再起動なしの開始失敗で旧接続へ戻してもVST復元を重ねない', async () => {
    let stopped = false;
    vi.spyOn(audioApi, 'getAudioState').mockImplementation(async () => ({ is_running: !stopped, config: stopped ? null : { host: 'Wasapi', input: 'Mic', output: 'Headphones', sample_rate: 48000, buffer_size: 512 } }));
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    const start = vi.spyOn(audioApi, 'start').mockImplementationOnce(async () => { stopped = true; throw new Error('new failed'); })
        .mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const restored = vi.fn();
    render(<AudioSettingsModal isOpen isAudioRunning={false} currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} onEngineRestarted={restored} />);
    fireEvent.click(await screen.findByRole('button', { name: '接続を保存して開始' }));
    await screen.findByText(/new failed/);
    expect(start).toHaveBeenCalledTimes(2);
    expect(restored).not.toHaveBeenCalled();
});

it('入力元の入口は機器一覧の読み込み後に入力選択へフォーカスする', async () => {
    render(<AudioSettingsModal isOpen initialSection="primaryInput" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'マイク' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: '入力元' })).toHaveFocus());
});

it('音楽鑑賞では音づくりの配信ミックス入口も理由付きで無効にする', async () => {
    localStorage.setItem('vst_host_setup_goal', 'music');
    render(<AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const button = await screen.findByRole('button', { name: '配信ミックスの設定' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/.+/);
});

it('入力元への移動は設定のエラー表示が終わるまで待機する', async () => {
    vi.spyOn(audioApi, 'getDevices').mockRejectedValueOnce(new Error('enumeration failed'));
    const view = render(<AudioSettingsModal isOpen initialSection="primaryInput" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: '設定に戻って再試行' });
    expect(document.getElementById('primary-input-settings')).toBeNull();
    retry.focus();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('combobox', { name: '入力元' })).toHaveFocus());
    view.unmount();
});

it('接続の折りたたみ見出しも通常セクションと同じトークンを使う', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'マイク' });
    const summary = screen.getByText('接続方式・音切れの設定', { exact: false, selector: 'summary' });
    expect(summary).toHaveClass('text-ui-heading', 'font-semibold');
    expect(summary).not.toHaveClass('text-sm');
});

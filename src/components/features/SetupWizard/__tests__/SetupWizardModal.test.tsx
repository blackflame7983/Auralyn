import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SetupWizardModal } from '../SetupWizardModal';
import type { AudioDevice } from '../../../../api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const device = (name: string, isInput = false): AudioDevice => ({
    name, host: 'WASAPI', is_input: isInput, index: 0, channels: 2, is_default: true,
});
const mic = device('USB マイク', true);
const cable = device('CABLE Input (VB-Audio)');
let inputs: AudioDevice[];
let outputs: AudioDevice[];
let reach: boolean | 'unsupported';
let startFails: boolean;
let startError: string;
let obsFails: boolean;

const openWizard = async () => {
    const onApplyConfig = vi.fn();
    const onClose = vi.fn();
    const onSkip = vi.fn();
    render(<SetupWizardModal isOpen onClose={onClose} onSkip={onSkip} onApplyConfig={onApplyConfig} />);
    await screen.findByRole('button', { name: 'OBS向けに設定する' });
    return { onApplyConfig, onClose, onSkip };
};
const quickStart = async () => {
    const callbacks = await openWizard();
    fireEvent.click(screen.getByRole('button', { name: 'OBS向けに設定する' }));
    await screen.findByRole('heading', { name: '設定と接続の確認' });
    return callbacks;
};

beforeEach(() => {
    localStorage.clear();
    inputs = [mic];
    outputs = [cable, device('スピーカー')];
    reach = true;
    startFails = false;
    startError = '起動失敗';
    obsFails = false;
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockClear();
    vi.mocked(invoke).mockImplementation(async (command) => {
        switch (command) {
            case 'get_audio_devices': return { inputs, outputs };
            case 'begin_display_locale_session': return 1;
            case 'set_display_locale': return true;
            case 'get_audio_state': return { is_running: false, config: null };
            case 'auto_gain': return { running: true, streamFailed: false };
            case 'start_audio':
                if (startFails) throw new Error(startError);
                return { sample_rate: 48000, buffer_size: 512, channels: 2 };
            case 'connect_obs':
                if (obsFails) throw new Error('接続失敗');
                return;
            case 'obs_check_audio_reach': return { reached: reach };
            default: return;
        }
    });
});
afterEach(cleanup);

describe('セットアップの接続チェック', () => {
    it('locale切替は選択中の実デバイスとdialogを保持し、音声操作・保存を行わない', async () => {
        const store = createLocaleStore(() => 'ja', () => true);
        inputs = [mic, device('Second microphone', true)];
        const onApplyConfig = vi.fn(); const onClose = vi.fn();
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={onClose} onApplyConfig={onApplyConfig} /></LocaleProvider>);
        fireEvent.click(await screen.findByRole('button', {name: '用途を選んで設定する'}));
        fireEvent.click(screen.getByRole('button', {name: 'OBSで配信'}));
        const input = screen.getByRole('combobox', {name: '入力デバイス'});
        fireEvent.change(input, {target: {value: 'Second microphone'}});
        const dialog = screen.getByRole('dialog');
        const before = vi.mocked(invoke).mock.calls.filter(([command]) => ['start_audio','stop_audio','voice_check_preview','save_preset'].includes(String(command))).length;
        fireEvent.change(screen.getByLabelText('表示言語'), {target: {value: 'en'}});
        await screen.findByRole('heading', {name: 'Choose a microphone'});
        expect(screen.getByRole('dialog')).toBe(dialog); expect(input).toHaveValue('Second microphone');
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => ['start_audio','stop_audio','voice_check_preview','save_preset'].includes(String(command)))).toHaveLength(before);
        expect(onApplyConfig).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    });
    it('プロセスが常駐していても開始前が停止中なら、中断時に音声を開始しない', async () => {
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => {
            if (command === 'get_audio_state') return Promise.resolve({ is_running: true, config: { host: 'ASIO', input: 'previous', output: 'previous' } });
            if (command === 'auto_gain') return Promise.resolve({ running: false, streamFailed: false });
            return base(command, args, options);
        });
        const { onClose } = await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        fireEvent.click(screen.getByRole('button', { name: '中断する' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(invoke).toHaveBeenLastCalledWith('stop_audio');
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.objectContaining({ host: 'ASIO' }));
    });

    it('設定の反映に失敗した場合は完了表示や表示モードの保存を行わない', async () => {
        const onApplyConfig = vi.fn().mockRejectedValue(new Error('save failed'));
        render(<SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={onApplyConfig} />);
        fireEvent.click(await screen.findByRole('button', { name: 'OBS向けに設定する' }));
        fireEvent.click(await screen.findByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(onApplyConfig).toHaveBeenCalledOnce());
        expect(await screen.findByRole('heading', { name: '設定と接続の確認' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: '音声設定を保存しました' })).not.toBeInTheDocument();
        expect(localStorage.getItem('vst_host_beginner_mode')).toBeNull();
    });

    it.each(['マイクの音を流して確認', '設定を保存して開始'])('アクセス拒否時の%sでは権限案内を開き、設定を保存せず再試行できる', async action => {
        startFails = true;
        startError = 'Input Stream Build Failed: 0x80070005';
        const { onApplyConfig } = await quickStart();
        fireEvent.click(screen.getByRole('button', { name: action }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Windowsのマイク設定を開く' })).toBeVisible());
        expect(document.querySelector('details')).toHaveAttribute('open');
        expect(onApplyConfig).not.toHaveBeenCalled();
        expect(localStorage.getItem('vst_host_audio_config')).toBeNull();
        startFails = false;
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(onApplyConfig).toHaveBeenCalledOnce());
    });
    it('拡大表示で外側をスクロールしても、手順切替時に先頭へ戻して見出しへフォーカスする', async () => {
        await openWizard();
        const surface = document.querySelector<HTMLElement>('.modal-surface-base')!;
        const body = document.querySelector<HTMLElement>('.modal-body-base')!;
        surface.scrollTop = 300;
        body.scrollTop = 120;
        fireEvent.click(screen.getByRole('button', { name: '用途を選んで設定する' }));
        expect(surface.scrollTop).toBe(0);
        expect(body.scrollTop).toBe(0);
        expect(screen.getByRole('heading', { name: 'どのような用途で使用しますか？' })).toHaveFocus();
    });
    const openListeningOutput = async () => {
        await openWizard();
        fireEvent.click(screen.getByRole('button', { name: '用途を選んで設定する' }));
        fireEvent.click(screen.getByRole('button', { name: '音楽鑑賞・テスト' }));
        const next = screen.getByRole('button', { name: /次へ/ });
        await waitFor(() => expect(next).toBeEnabled());
        fireEvent.click(next);
    };

    it.each(['仮想出力のみ', '既定不明の複数物理出力', '仮想出力が既定'])('Windows既定を確認できないとき、別の候補を勝手に選ばない: %s', async scenario => {
        outputs = scenario === '仮想出力のみ' ? [{ ...cable, is_default: false }]
            : scenario === '仮想出力が既定' ? [cable, { ...device('スピーカー'), is_default: false }]
                : [{ ...device('スピーカー USB'), is_default: false }, { ...device('ヘッドホン'), is_default: false }];
        await openListeningOutput();
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        expect(screen.getByText(/Windows の既定の物理出力を確認できませんでした/)).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
        if (scenario === '既定不明の複数物理出力') {
            fireEvent.click(screen.getByRole('button', { name: /ヘッドホン\/スピーカー/ }));
            const select = screen.getByRole('combobox', { name: 'ヘッドホン・スピーカー' });
            expect(select).toHaveValue('');
            fireEvent.change(select, { target: { value: 'ヘッドホン' } });
            expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
        }
    });

    it('確認できた既定の物理出力を使い、再検出で既定が変わったら選択も更新する', async () => {
        outputs = [{ ...device('スピーカー USB'), is_default: false }, device('ヘッドホン')];
        await openListeningOutput();
        expect(screen.getByText('ヘッドホン')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
        outputs = outputs.map(d => ({ ...d, is_default: false }));
        fireEvent.click(screen.getByRole('button', { name: '再検出' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled());
        outputs = outputs.map(d => ({ ...d, is_default: d.name === 'スピーカー USB' }));
        fireEvent.click(screen.getByRole('button', { name: '再検出' }));
        await waitFor(() => expect(screen.getByText('スピーカー USB')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
    });

    it('複数の仮想出力は明示選択し、受け側の対になる名前を案内する', async () => {
        outputs = [cable, device('CABLE-A Input (VB-Audio)'), device('Voicemeeter Input')];
        await openWizard();
        expect(within(screen.getByTestId('setup-actions')).getByRole('button', { name: '用途を選んで設定する' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'OBS向けに設定する' }));
        const output = await screen.findByRole('combobox', { name: '仮想ケーブルの出力先' });
        expect(output).toHaveValue('');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        fireEvent.change(output, { target: { value: 'CABLE-A Input (VB-Audio)' } });
        expect(screen.getByText(/受け側では CABLE-A Output/)).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('setup-actions')).getByRole('button', { name: /次へ/ }));
        expect(within(screen.getByTestId('setup-actions')).getByRole('button', { name: '設定を保存して開始' })).toBeInTheDocument();
        expect(screen.getByText(/OBS の入力デバイスは「CABLE-A Output/)).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    });

    it('再生リダイレクトが先頭・既定でも、マイクを推奨する', async () => {
        inputs = [device('再生リダイレクト [44/48/96kHz]', true), device('ライン入力', true), { ...mic, is_default: false }];
        await quickStart();
        expect(screen.getByText(mic.name)).toBeInTheDocument();
        expect(screen.queryByText(inputs[0].name)).not.toBeInTheDocument();
    });

    it.each(['再生リダイレクト', 'Stereo Mix', 'ステレオ ミキサー', 'Loopback', 'What U Hear', 'CABLE Output', 'Voicemeeter Out B1'])('入力が %s だけなら自動選択せず手動選択へ進む', async name => {
        inputs = [device(name, true)];
        await openWizard();
        fireEvent.click(screen.getByRole('button', { name: 'OBS向けに設定する' }));
        await screen.findByRole('heading', { name: 'マイクを選んでください' });
        expect(screen.getByRole('combobox', { name: '入力デバイス' })).toHaveValue('');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
    });

    it('物理マイクが複数あれば既定の候補でも自動選択せず、明示選択を待つ', async () => {
        inputs = [device('再生リダイレクト', true), { ...device('Microphone USB', true), is_default: false }, mic];
        await openWizard();
        fireEvent.click(screen.getByRole('button', { name: '用途を選んで設定する' }));
        fireEvent.click(screen.getByRole('button', { name: 'OBSで配信' }));
        const select = screen.getByRole('combobox', { name: '入力デバイス' });
        expect(select).toHaveValue('');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        fireEvent.change(select, { target: { value: mic.name } });
        expect(select).toHaveValue(mic.name);
    });

    it('サウンドテストの開始・停止に音声状態を追従させ、未確認の到達と区別する', async () => {
        await quickStart();
        expect(screen.getByRole('status')).toHaveTextContent('音声は停止中です。');
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('音声は稼働中です。'));
        expect(screen.getByRole('status')).not.toHaveTextContent('音声は停止中です。');
        expect(screen.getByRole('status')).toHaveTextContent('OBS への音の到達は未確認です。');
        fireEvent.click(screen.getByRole('button', { name: 'マイクの確認を停止' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('音声は停止中です。'));
    });

    it('テストを開始しても、OBS の接続失敗の案内は残す', async () => {
        obsFails = true;
        await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('OBS に接続できませんでした。'));
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('音声は稼働中です。'));
        expect(screen.getByRole('status')).toHaveTextContent('OBS に接続できませんでした。');
    });

    it('明示的なスキップを、途中の中断や保存と区別する', async () => {
        const { onSkip, onClose, onApplyConfig } = await openWizard();
        fireEvent.click(screen.getByRole('button', { name: 'スキップ（手動設定）' }));
        expect(onSkip).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
        expect(onApplyConfig).not.toHaveBeenCalled();
    });
    it('ケーブル未導入時は物理出力へ迂回せず、導入と再検出を案内する', async () => {
        outputs = [device('スピーカー')];
        await openWizard();
        fireEvent.click(screen.getByRole('button', { name: 'OBS向けに設定する' }));
        await screen.findByText(/仮想ケーブルが見つかりません/);
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        expect(screen.queryByRole('heading', { name: '設定と接続の確認' })).not.toBeInTheDocument();
        outputs = [cable];
        fireEvent.click(screen.getByRole('button', { name: '再検出' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled());
        expect(invoke).toHaveBeenCalledWith('get_audio_devices', { forceRefresh: true });
        expect(screen.getByRole('combobox', { name: '仮想ケーブルの出力先' })).toHaveValue(cable.name);
    });

    it('未接続では到達確認を無効にし、手動手順を表示する', async () => {
        await quickStart();
        expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeDisabled();
        expect(screen.getByText(/音声入力キャプチャ/)).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('connect_obs', expect.anything());
        expect(invoke).not.toHaveBeenCalledWith('obs_setup_auralyn_source');
    });

    it.each([
        [true, 'OBS の「Auralyn マイク」で音の到達を確認しました。'],
        [false, '音の到達を確認できませんでした。'],
        ['unsupported', '自動での到達確認を利用できません。'],
    ] as const)('到達結果 %s を区別し、エンジン開始後に確認する', async (status, text) => {
        reach = status;
        await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text));
        const commands = vi.mocked(invoke).mock.calls.map(c => c[0]);
        expect(commands.indexOf('start_audio')).toBeLessThan(commands.indexOf('obs_check_audio_reach'));
        expect(invoke).not.toHaveBeenCalledWith('obs_setup_auralyn_source');
    });

    it('OBS 接続失敗でも手動手順と再試行を残す', async () => {
        obsFails = true;
        await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('OBS に接続できませんでした。'));
        expect(screen.getByRole('button', { name: 'OBS に接続する' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeDisabled();
    });

    it('不正なポートを送信せず、接続先変更で到達結果を無効にする', async () => {
        await quickStart();
        fireEvent.change(screen.getByLabelText('ポート'), { target: { value: '0' } });
        expect(screen.getByRole('button', { name: 'OBS に接続する' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('ポート'), { target: { value: '4455' } });
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeEnabled());
        fireEvent.change(screen.getByLabelText('接続先'), { target: { value: '127.0.0.1' } });
        expect(screen.getByRole('status')).toHaveTextContent('再接続');
        expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeDisabled();
    });

    it('音声の起動失敗時は設定を保存しない', async () => {
        startFails = true;
        const { onApplyConfig } = await quickStart();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(screen.getByRole('button', { name: '設定を保存して開始' })).toBeEnabled());
        expect(onApplyConfig).not.toHaveBeenCalled();
        expect(screen.queryByText('音声設定を保存しました')).not.toBeInTheDocument();
    });

    it('テスト停止後の保存に失敗しても、停止状態から再試行できる', async () => {
        const { onApplyConfig } = await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        startFails = true;
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('button', { name: 'マイクの音を流して確認' });
        expect(onApplyConfig).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'マイクの確認を停止' })).not.toBeInTheDocument();
    });

    it('Discord は対応する入力の手動確認を案内し、OBS に接続しない', async () => {
        await openWizard();
        fireEvent.click(screen.getByRole('button', { name: '用途を選んで設定する' }));
        fireEvent.click(screen.getByRole('button', { name: 'ボイスチャット' }));
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        expect(screen.getByText(/Discord の「設定/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'OBS に接続する' })).not.toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalledWith('obs_check_audio_reach', expect.anything());
    });

    it('音声停止に失敗したときはデバイス選択へ遷移しない', async () => {
        await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'stop_audio'
            ? Promise.reject(new Error('停止失敗')) : base(command, args, options));
        fireEvent.click(screen.getByRole('button', { name: '入力を選び直す' }));
        await waitFor(() => expect(screen.getByRole('button', { name: '入力を選び直す' })).toBeEnabled());
        expect(screen.getByRole('heading', { name: '設定と接続の確認' })).toBeInTheDocument();
    });

    it('中断時は起動前の音声設定を復元してから閉じる', async () => {
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'get_audio_state'
            ? Promise.resolve({ is_running: true, config: { host: 'ASIO', input: '元の入力', output: '元の出力', buffer_size: 256, sample_rate: 44100 } })
            : base(command, args, options));
        const { onClose, onApplyConfig } = await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        fireEvent.click(screen.getByRole('button', { name: '中断する' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(invoke).toHaveBeenLastCalledWith('start_audio', expect.objectContaining({ host: 'ASIO', input: '元の入力', output: '元の出力', bufferSize: 256, sampleRate: 44100 }));
        expect(onApplyConfig).not.toHaveBeenCalled();
        expect(localStorage.getItem('vst_host_wizard_done')).toBeNull();
    });

    it('開始前の音声設定を取得できない場合は、テストと保存を禁止する', async () => {
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'get_audio_state'
            ? Promise.reject(new Error('取得失敗')) : base(command, args, options));
        await quickStart();
        expect(screen.getByRole('button', { name: 'マイクの音を流して確認' })).toBeDisabled();
        expect(screen.getByRole('button', { name: '設定を保存して開始' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'OBS に接続する' })).toBeDisabled();
    });

    it('確認中は閉じる・選び直す・保存と重複実行を抑止する', async () => {
        let finish!: (value: unknown) => void;
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'obs_check_audio_reach'
            ? new Promise(resolve => { finish = resolve; })
            : base(command, args, options));
        await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' }));
        await waitFor(() => expect(finish).toBeDefined());
        expect(screen.getByRole('button', { name: '出力先を選び直す' })).toBeDisabled();
        expect(screen.getByRole('button', { name: '設定を保存して開始' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'セットアップを閉じる' })).toBeDisabled();
        const errorListener = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-stream-error')![1];
        await act(async () => { errorListener({ event: 'audio-stream-error', id: 1, payload: 'device removed' }); });
        await act(async () => { finish({ reached: true }); });
        expect(screen.getByRole('status')).toHaveTextContent('音声が中断されました。');
        expect(screen.getByRole('button', { name: '出力先を選び直す' })).toBeEnabled();
    });

    it('入力の再検出で消えたデバイスを保持せず、接続し直せる', async () => {
        await quickStart();
        fireEvent.click(screen.getByRole('button', { name: '入力を選び直す' }));
        await screen.findByRole('combobox', { name: '入力デバイス' });
        inputs = [];
        fireEvent.click(screen.getByRole('button', { name: '入力デバイスを再検出' }));
        await screen.findByText('入力デバイスが見つかりませんでした。');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        inputs = [device('別のマイク', true)];
        fireEvent.click(screen.getByRole('button', { name: '入力デバイスを再検出' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '入力デバイス' })).toHaveValue('別のマイク'));
        expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
    });

    it('テスト後の選び直しは停止を待ち、保存後は元の停止状態へ戻さない', async () => {
        const { onApplyConfig, onClose } = await quickStart();
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        fireEvent.click(screen.getByRole('button', { name: '出力先を選び直す' }));
        await screen.findByRole('heading', { name: '音の出力先を選んでください' });
        expect(invoke).toHaveBeenCalledWith('stop_audio');
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(onApplyConfig).toHaveBeenCalledWith('WASAPI', mic.name, cable.name, { sample_rate: 48000, buffer_size: 512, channels: 2 });
        vi.mocked(invoke).mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalled();
    });
});

describe('初回選択と表示設定', () => {
    it.each([true, false])('音声設定の適用成功後だけ表示を保存する: %s', async (beginner) => {
        localStorage.setItem('vst_host_beginner_mode', String(!beginner));
        await openWizard();
        fireEvent.click(
            screen.getByRole('radio', {
                name: beginner
                    ? '配信をはじめたい（かんたん表示）'
                    : 'VSTで音を調整したい（詳細表示）',
            })
        );
        fireEvent.click(screen.getByRole('button', { name: 'OBS向けに設定する' }));
        await screen.findByRole('heading', { name: '設定と接続の確認' });
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!beginner));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(beginner));
    });
    it('選択後に閉じても既存の表示設定を変えない', async () => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: '配信をはじめたい（かんたん表示）' }));
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    });
    it('適用失敗では選んだ表示を確定しない', async () => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        startFails = true;
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: '配信をはじめたい（かんたん表示）' }));
        fireEvent.click(screen.getByRole('button', { name: 'OBS向けに設定する' }));
        await screen.findByRole('heading', { name: '設定と接続の確認' });
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: '設定を保存して開始' })).toBeEnabled()
        );
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    });
    it('明示的に手動設定へ進む場合は選択を保存する', async () => {
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'VSTで音を調整したい（詳細表示）' }));
        fireEvent.click(screen.getByRole('button', { name: 'スキップ（手動設定）' }));
        await waitFor(() => expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false'));
    });
});

it('確認stepのlocale切替で入力出力・テスト状態とdialogを保持し設定を再送しない', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const apply = vi.fn();
    render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={apply} /></LocaleProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'OBS向けに設定する' }));
    await screen.findByRole('heading', { name: '設定と接続の確認' });
    const dialog = screen.getByRole('dialog'); const test = screen.getByRole('button', { name: 'マイクの音を流して確認' });
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Check by sending microphone audio' })).toBe(test);
    expect(screen.getAllByText('USB マイク').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CABLE Input (VB-Audio)').length).toBeGreaterThan(0);
    expect(vi.mocked(invoke).mock.calls).toHaveLength(calls);
    expect(apply).not.toHaveBeenCalled();
});

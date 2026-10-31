import { chooseObsRoute } from './wizardActions';
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
    await screen.findByRole('button', { name: 'OBSで配信' });
    return { onApplyConfig, onClose, onSkip };
};
const quickStart = async () => {
    const callbacks = await openWizard();
    await chooseObsRoute();
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
        await screen.findByRole('button', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('button', {name: 'OBSで配信'}));
        const input = screen.getByRole('combobox', {name: '入力デバイス'});
        fireEvent.change(input, {target: {value: 'Second microphone'}});
        const dialog = screen.getByRole('dialog');
        const before = vi.mocked(invoke).mock.calls.filter(([command]) => ['start_audio','stop_audio','voice_check_preview','save_preset'].includes(String(command))).length;
        // 表示言語の選択は最初の画面だけに置く。途中の切替は外観設定など別経路のlocale変更で確かめる。
        expect(screen.queryByLabelText('表示言語')).not.toBeInTheDocument();
        act(() => { store.setLocale('en'); });
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
        await chooseObsRoute();
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
        fireEvent.click(screen.getByRole('button', { name: 'OBSで配信' }));
        expect(surface.scrollTop).toBe(0);
        expect(body.scrollTop).toBe(0);
        expect(screen.getByRole('heading', { name: 'マイクを選んでください' })).toHaveFocus();
    });
    const openListeningOutput = async () => {
        await openWizard();
        await screen.findByRole('button', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('button', { name: '自分で聴く' }));
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
            fireEvent.click(screen.getByRole('button', { name: /ヘッドホン・スピーカー/ }));
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
        expect(within(screen.getByTestId('setup-actions')).getByRole('button', { name: 'セットアップをスキップ' })).toBeInTheDocument();
        await chooseObsRoute();
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

    // 名前の組み合わせはwizardModelのNode試験で扱い、画面は操作禁止と明示選択を守る。
    it('ループバック入力だけなら自動選択せず、利用者の明示選択まで進めない', async () => {
        inputs = [device('Loopback', true)];
        await openWizard();
        await chooseObsRoute();
        await screen.findByRole('heading', { name: 'マイクを選んでください' });
        expect(screen.getByRole('combobox', { name: '入力デバイス' })).toHaveValue('');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        fireEvent.change(screen.getByRole('combobox', { name: '入力デバイス' }), { target: { value: 'Loopback' } });
        expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
    });

    it('物理マイクが複数あれば既定の候補でも自動選択せず、明示選択を待つ', async () => {
        inputs = [device('再生リダイレクト', true), { ...device('Microphone USB', true), is_default: false }, mic];
        await openWizard();
        await screen.findByRole('button', { name: 'OBSで配信' });
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
        fireEvent.click(screen.getByRole('button', { name: 'セットアップをスキップ' }));
        expect(onSkip).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
        expect(onApplyConfig).not.toHaveBeenCalled();
    });
    it('ケーブル未導入時は物理出力へ迂回せず、導入と再検出を案内する', async () => {
        outputs = [device('スピーカー')];
        await openWizard();
        await chooseObsRoute();
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
        await screen.findByRole('button', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('button', { name: '通話（Discordなど）' }));
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
    it.each([
        [false, false], [false, true], [true, false], [true, true],
    ])('初期選択は現在のパネルに合わせ、そのまま保存しても開閉を変えない: panel=%s details=%s', async (panel, details) => {
        localStorage.setItem('auralyn_vst_panel_open', String(panel));
        localStorage.setItem('vst_host_beginner_mode', String(!details));
        await quickStart();
        expect((screen.getByRole('radio', { name: 'VSTで音を調整したい（VST 構成を開いておく）' }) as HTMLInputElement).checked).toBe(panel);
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBe(String(panel));
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!(details || panel)));
    });
    it.each([
        [false, false], [false, true], [true, false], [true, true],
    ])('選んだ開閉を反映し、数値の詳細は VST 選択でのみ ON にする: VST=%s details=%s', async (vst, details) => {
        localStorage.setItem('auralyn_vst_panel_open', String(!vst));
        localStorage.setItem('vst_host_beginner_mode', String(!details));
        await quickStart();
        fireEvent.click(screen.getByRole('radio', { name: vst ? 'VSTで音を調整したい（VST 構成を開いておく）' : '配信をはじめたい' }));
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!details));
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBe(String(!vst));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBe(String(vst));
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!(details || vst)));
    });
    it('確認画面で表示を選んだ後に中断しても既存の表示設定を変えない', async () => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        const { onClose } = await quickStart();
        fireEvent.click(screen.getByRole('radio', { name: '配信をはじめたい' }));
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'セットアップを中断しますか？' })).getByRole('button', { name: '中断する' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    });
    it('適用失敗では選んだ表示を確定しない', async () => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        startFails = true;
        await quickStart();
        fireEvent.click(screen.getByRole('radio', { name: '配信をはじめたい' }));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(screen.getByRole('button', { name: '設定を保存して開始' })).toBeEnabled());
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    });
    it('用途選択では表示モードを選ばせず、スキップでも既存表示を保存し直さない', async () => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        const { onSkip } = await openWizard();
        expect(screen.queryByRole('radio')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'セットアップをスキップ' }));
        await waitFor(() => expect(onSkip).toHaveBeenCalledOnce());
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    });
});

it('確認stepのlocale切替で入力出力・テスト状態とdialogを保持し設定を再送しない', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const apply = vi.fn();
    render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={apply} /></LocaleProvider>);
    await chooseObsRoute();
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

describe('入力ステップのレベル表示', () => {
    it('動作中の入力と同じマイクを選んでいる間だけ、音声を開始せずにレベルを示す', async () => {
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => {
            if (command === 'get_audio_state') return Promise.resolve({ is_running: true, config: { host: 'WASAPI', input: 'USB マイク', output: 'CABLE Input (VB-Audio)', sample_rate: 48000, buffer_size: 512 } });
            return base(command, args, options);
        });
        inputs = [mic, device('Second microphone', true)];
        await openWizard();
        fireEvent.click(screen.getByRole('button', { name: 'OBSで配信' }));
        const input = screen.getByRole('combobox', { name: '入力デバイス' });
        fireEvent.change(input, { target: { value: 'USB マイク' } });
        expect(await screen.findByRole('meter', { name: 'マイクの入力レベル' })).toBeInTheDocument();
        fireEvent.change(input, { target: { value: 'Second microphone' } });
        expect(screen.queryByRole('meter')).not.toBeInTheDocument();
        expect(screen.getByText(/マイクの音を流して確認/)).toBeInTheDocument();
        expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'start_audio')).toBe(false);
    });
});


describe('PC audio purpose', () => {
    const fx = { active: true, preset: 'singing', amount: 0.7, singing: { lowCutHz: 80, dynamics: 0.4, brightnessDb: 2 }, reverb: { enabled: true, mix: 0.2, decaySeconds: 1, damping: 0.4 } };
    const snapshot = { epoch: 'epoch', revision: '1', appliedRevision: '1', config: fx, pending: false, undoToken: null, error: null };
    const chooseMusic = async () => {
        fireEvent.click(await screen.findByRole('button', { name: /PCの音にエフェクト/ }));
        await screen.findByRole('combobox', { name: 'PCの音の入力を選択' });
    };
    const toConfirm = async () => {
        await chooseMusic();
        await waitFor(() => expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        await screen.findByRole('heading', { name: '設定と接続の確認' });
    };
    it('選択だけでは既存目的や音設定を変えず、複数ケーブルは選択を待つ', async () => {
        inputs = [mic, device('CABLE Output A', true), device('CABLE Output B', true)];
        localStorage.setItem('vst_host_setup_goal', 'obs');
        await openWizard(); await chooseMusic();
        expect(screen.getByRole('combobox', { name: 'PCの音の入力を選択' })).toHaveValue('');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
        expect(invoke).not.toHaveBeenCalledWith('set_noise_control_config', expect.anything());
        expect(screen.getByText(/再生アプリ → CABLE Input/)).toBeInTheDocument();
    });
    it('OBS の仮想出力から music に切り替えると物理出力を選び直す', async () => {
        inputs = [mic, device('CABLE Output', true)]; outputs = [cable, device('Headphones')];
        await openWizard(); await chooseObsRoute();
        fireEvent.click(screen.getByRole('button', { name: '入力を選び直す' }));
        fireEvent.click(screen.getByRole('button', { name: '戻る' }));
        await toConfirm();
        expect(screen.getByText('Headphones')).toBeInTheDocument();
        expect(screen.queryByText('CABLE Input (VB-Audio)')).not.toBeInTheDocument();
    });
    it('明示適用で両処理をOFFにし、その他の設定を保持する', async () => {
        inputs = [mic, device('CABLE Output', true)]; outputs = [device('Headphones')];
        const original = vi.mocked(invoke).getMockImplementation()!;
        let applied = false;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: true }, noiseReductionEnabled: false, noiseReductionMode: 'venue', noiseControlStrength: 0.8, noiseVoiceGuard: true };
            if (command === 'builtin_effects') {
                if ((args as any).request.action === 'apply') applied = true;
                return applied ? { ...snapshot, revision: '2', appliedRevision: '2', undoToken: 'undo', config: { ...fx, active: false, reverb: {...fx.reverb, enabled: false} } } : snapshot;
            }
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard();
        onApplyConfig.mockImplementation((host, input, output, actual) => {
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size }));
            localStorage.setItem('vst_host_wizard_done', 'true');
        });
        await toConfirm();
        expect(screen.queryByRole('button', { name: 'マイクの音を流して確認' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(invoke).toHaveBeenCalledWith('set_noise_control_config', { active: false, mode: 'venue', strength: 0.8, voiceGuard: true });
        expect(invoke).toHaveBeenCalledWith('builtin_effects', { request: { action: 'apply', epoch: 'epoch', expectedRevision: '1', config: { ...fx, active: false, reverb: {...fx.reverb, enabled: false} } } });
        expect(onApplyConfig).toHaveBeenCalledOnce(); expect(localStorage.getItem('vst_host_setup_goal')).toBe('music');
    });
    it.each([
        [true, 'success'], [false, 'success'],
        [true, 'reject'], [false, 'reject'],
        [true, 'readback'], [false, 'readback'],
    ] as const)('音楽鑑賞は保存待ち・失敗時の開閉を保ち、読み戻し成功後だけ選択を反映する: VST=%s %s', async (vst, result) => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        localStorage.setItem('auralyn_vst_panel_open', String(!vst));
        localStorage.setItem('vst_host_beginner_mode', String(vst));
        const original = vi.mocked(invoke).getMockImplementation()!;
        const inactive = { ...snapshot, config: { ...fx, active: false, reverb: { ...fx.reverb, enabled: false } } };
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: true }, noiseReductionEnabled: false, noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'builtin_effects') return inactive;
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard();
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        onApplyConfig.mockImplementation(async (host, input, output, actual) => {
            await pending;
            if (result === 'reject') throw new Error('save failure');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size }));
            if (result !== 'readback') localStorage.setItem('vst_host_wizard_done', 'true');
        });
        await toConfirm();
        fireEvent.click(screen.getByRole('radio', { name: vst ? 'VSTで音を調整したい（VST 構成を開いておく）' : '音を手軽に調整したい' }));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(onApplyConfig).toHaveBeenCalledOnce());
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBe(String(!vst));
        await act(async () => { finish(); });
        if (result === 'success') await screen.findByRole('heading', { name: '音声設定を保存しました' });
        else await screen.findByRole('alert');
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBe(String(result === 'success' ? vst : !vst));
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(result === 'success' && vst ? false : vst));
    });
    it('音楽鑑賞の新規利用者が手軽を選ぶと、用途の既定値より明示的に閉じる選択を優先する', async () => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        const original = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: true }, noiseReductionEnabled: false, noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'builtin_effects') return { ...snapshot, config: { ...fx, active: false, reverb: { ...fx.reverb, enabled: false } } };
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard();
        onApplyConfig.mockImplementation((host, input, output, actual) => {
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size }));
            localStorage.setItem('vst_host_wizard_done', 'true');
        });
        await toConfirm();
        expect(screen.getByRole('radio', { name: '音を手軽に調整したい' })).toBeChecked();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('music');
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBe('false');
        expect(localStorage.getItem('vst_host_beginner_mode')).toBeNull();
    });
    it('保存途中の失敗では、この操作が書いた保存値を条件付きで戻す', async () => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('vst_host_audio_config', 'previous');
        const original = vi.mocked(invoke).getMockImplementation()!;
        let applied = false;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: true }, noiseReductionEnabled: false, noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'builtin_effects') {
                if ((args as any).request.action === 'apply') applied = true;
                return applied ? { ...snapshot, revision: '2', appliedRevision: '2', config: { ...fx, active: false, reverb: {...fx.reverb, enabled: false} } } : snapshot;
            }
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard();
        onApplyConfig.mockImplementation((host, input, output, actual) => {
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size }));
            throw new Error('save failure');
        });
        await toConfirm(); fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('alert');
        expect(localStorage.getItem('vst_host_audio_config')).toBe('previous');
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
        expect(localStorage.getItem('vst_host_wizard_done')).toBeNull();
    });
    it.each([false, undefined])('最終確認時にストリームが稼働中でなければ保存しない (%s)', async (running) => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        localStorage.setItem('vst_host_setup_goal', 'obs');
        const original = vi.mocked(invoke).getMockImplementation()!;
        let applied = false;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: running }, noiseReductionEnabled: false, noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'builtin_effects') {
                if ((args as any).request.action === 'apply') applied = true;
                return applied ? { ...snapshot, revision: '2', appliedRevision: '2', config: { ...fx, active: false, reverb: {...fx.reverb, enabled: false} } } : snapshot;
            }
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard(); await toConfirm();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('alert');
        expect(onApplyConfig).not.toHaveBeenCalled();
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    });
    it('反映待ちの内蔵効果は保存完了にせず、確認を促す', async () => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        localStorage.setItem('vst_host_setup_goal', 'obs');
        const original = vi.mocked(invoke).getMockImplementation()!;
        let applied = false;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: true }, noiseReductionEnabled: false, noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'builtin_effects') {
                if ((args as any).request.action === 'apply') applied = true;
                return applied ? { ...snapshot, revision: '2', pending: true, config: { ...fx, active: false, reverb: {...fx.reverb, enabled: false} } } : snapshot;
            }
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard(); await toConfirm();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('一部変わった可能性');
        expect(onApplyConfig).not.toHaveBeenCalled(); expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    });
    it('NR適用失敗は内蔵効果の条件付きundoを試み、保存完了しない', async () => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        localStorage.setItem('vst_host_setup_goal', 'obs');
        const original = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'set_noise_control_config') throw new Error('failure');
            if (command === 'builtin_effects') return (args as any).request.action === 'snapshot' ? snapshot : { ...snapshot, revision: '2', undoToken: 'undo', config: { ...fx, active: false, reverb: {...fx.reverb, enabled: false} } };
            return original(command, args);
        });
        const { onApplyConfig } = await openWizard(); await toConfirm();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('alert');
        expect(invoke).toHaveBeenCalledWith('builtin_effects', { request: { action: 'undo', epoch: 'epoch', expectedRevision: '2', undoToken: 'undo' } });
        expect(onApplyConfig).not.toHaveBeenCalled(); expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    });
});

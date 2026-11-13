import { useSetupWizard } from '../useSetupWizard';
import { chooseObsRoute } from './wizardActions';
import { act, renderHook, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SetupWizardModal } from '../SetupWizardModal';
import type { AudioDevice } from '../../../../api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

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

const vstChoice = 'VSTで音を調整したい（完了後にVSTのページを開く）';
const openWizard = async () => {
    const onApplyConfig = vi.fn();
    const onClose = vi.fn();
    const onSkip = vi.fn();
    const onCompleted = vi.fn();
    render(<SetupWizardModal isOpen onClose={onClose} onSkip={onSkip} onApplyConfig={onApplyConfig} onCompleted={onCompleted} />);
    await screen.findByRole('radio', { name: 'OBSで配信' });
    return { onApplyConfig, onClose, onSkip, onCompleted };
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
    it('送り先は共通の順序で表示し、保存済み music は自分で聴くとして扱う', async () => {
        localStorage.setItem('vst_host_setup_goal', 'music');
        await openWizard();
        const choices = ['OBSで配信', '通話（Discordなど）', '自分で聴く', 'その他のアプリ'].map(name => screen.getByRole('radio', { name }));
        expect(choices.slice(0, -1).every((node, index) => Boolean(node.compareDocumentPosition(choices[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        expect(choices[2]).toBeChecked();
        fireEvent.click(choices[2]);
        expect(screen.getByRole('radio', { name: 'PCの音' })).toBeChecked();
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('music');
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    });
    it('入力がない場合は次へを無効にし、音の元に応じた理由を表示する', async () => {
        inputs = [];
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: '自分で聴く' }));
        await screen.findByText('マイクを選ぶと次へ進めます');
        const next = screen.getByRole('button', { name: /次へ/ });
        expect(next).toBeDisabled();
        expect(next).toHaveAccessibleDescription('マイクを選ぶと次へ進めます');
        fireEvent.click(screen.getByRole('radio', { name: 'PCの音' }));
        expect(next).toHaveAccessibleDescription('PCの音を選ぶと次へ進めます');
        expect(next).toHaveClass('disabled:bg-muted', 'disabled:text-muted-foreground');
    });

    it.each(['ja', 'en'] as const)('入力の読込中は未選択より先に理由を伝え、完了すると解除する（%s）', async locale => {
        const store = createLocaleStore(() => 'ja', () => true);
        const base = vi.mocked(invoke).getMockImplementation()!;
        let resolveDevices!: (value: { inputs: AudioDevice[]; outputs: AudioDevice[] }) => void;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'get_audio_devices'
            ? new Promise(resolve => { resolveDevices = resolve; }) : base(command, args, options));
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn()} /></LocaleProvider>);
        fireEvent.click(await screen.findByRole('radio', { name: 'OBSで配信' }));
        act(() => { store.setLocale(locale); });
        const next = within(screen.getByTestId('setup-actions')).getByRole('button', { name: locale === 'ja' ? '次へ' : 'Next' });
        expect(next).toBeDisabled();
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? '機器を読み込んでいます' : 'Loading devices');
        expect(next).toHaveClass('disabled:opacity-100', 'disabled:bg-muted', 'disabled:text-muted-foreground');
        expect(next).not.toHaveClass('disabled:opacity-50');
        fireEvent.click(next);
        expect(screen.getByRole('heading', { name: locale === 'ja' ? 'マイクを選んでください' : 'Choose a microphone' })).toBeInTheDocument();
        await act(async () => { resolveDevices({ inputs: [mic], outputs }); });
        await waitFor(() => expect(next).toBeEnabled());
        expect(next).not.toHaveAttribute('aria-describedby');
        expect(within(screen.getByTestId('setup-actions')).getByRole('status')).toBeEmptyDOMElement();
    });

    it.each(['ja', 'en'] as const)('入力未選択の理由を音の元に合わせて切り替える（%s）', async locale => {
        inputs = [];
        const store = createLocaleStore(() => 'ja', () => true);
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn()} /></LocaleProvider>);
        fireEvent.click(await screen.findByRole('radio', { name: '自分で聴く' }));
        await screen.findByText('マイクを選ぶと次へ進めます');
        act(() => { store.setLocale(locale); });
        const next = within(screen.getByTestId('setup-actions')).getByRole('button', { name: locale === 'ja' ? '次へ' : 'Next' });
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? 'マイクを選ぶと次へ進めます' : 'Select a microphone to continue');
        fireEvent.click(screen.getByRole('radio', { name: locale === 'ja' ? 'PCの音' : 'PC audio' }));
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? 'PCの音を選ぶと次へ進めます' : 'Select the PC audio input to continue');
        expect(next).toBeDisabled();
    });

    it.each(['ja', 'en'] as const)('出力未選択から再検出・入力消失まで、優先する理由を1つだけ伝える（%s）', async locale => {
        outputs = [];
        const store = createLocaleStore(() => 'ja', () => true);
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn()} /></LocaleProvider>);
        await chooseObsRoute();
        await screen.findByText('出力先を選ぶと次へ進めます');
        act(() => { store.setLocale(locale); });
        const actions = within(screen.getByTestId('setup-actions'));
        const next = actions.getByRole('button', { name: locale === 'ja' ? '次へ' : 'Next' });
        const reason = actions.getByRole('status');
        expect(reason).toBeVisible();
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? '出力先を選ぶと次へ進めます' : 'Select an output device to continue');
        expect(next).toBeDisabled();
        expect(next).toHaveClass('disabled:opacity-100', 'disabled:bg-muted', 'disabled:text-muted-foreground');
        next.focus();
        expect(next).not.toHaveFocus();
        fireEvent.click(next);
        expect(screen.queryByRole('button', { name: '設定を保存して開始' })).not.toBeInTheDocument();
        const base = vi.mocked(invoke).getMockImplementation()!;
        let resolveDevices!: (value: { inputs: AudioDevice[]; outputs: AudioDevice[] }) => void;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'get_audio_devices'
            ? new Promise(resolve => { resolveDevices = resolve; }) : base(command, args, options));
        fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '機器を再検出' : 'Detect devices again' }));
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? '機器を読み込んでいます' : 'Loading devices');
        await act(async () => { resolveDevices({ inputs: [], outputs: [] }); });
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? '戻ってマイクを選ぶと進めます' : 'Go back and select a microphone to continue');
        expect(actions.getByRole('status')).toBe(reason);
        expect(reason).toHaveAttribute('aria-atomic', 'true');
        expect(reason).not.toHaveTextContent(locale === 'ja' ? '送り先を選ぶ' : 'Select an output');
        expect(next).toBeDisabled();
    });

    it('保存後にキーボードでボイスチェック（ボイスチェック）を開き、自動録音しない', async () => {
        const onClose = vi.fn();
        const onOpenVoiceCheck = vi.fn();
        render(<SetupWizardModal isOpen onClose={onClose} onApplyConfig={vi.fn()} onOpenVoiceCheck={onOpenVoiceCheck} />);
        await chooseObsRoute();
        expect(screen.getByRole('region', { name: '入力・処理・出力' })).toHaveTextContent('USB マイク');
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        const button = screen.getByRole('button', { name: /ボイスチェック/ });
        button.focus();
        expect(button).toHaveFocus();
        fireEvent.click(button);
        expect(onClose).toHaveBeenCalledOnce();
        expect(onOpenVoiceCheck).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalledWith('voice_check_preview', expect.anything());
    });
    it('locale切替は選択中の実デバイスとdialogを保持し、音声操作・保存を行わない', async () => {
        const store = createLocaleStore(() => 'ja', () => true);
        inputs = [mic, device('Second microphone', true)];
        const onApplyConfig = vi.fn(); const onClose = vi.fn();
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={onClose} onApplyConfig={onApplyConfig} /></LocaleProvider>);
        await screen.findByRole('radio', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('radio', {name: 'OBSで配信'}));
        const input = screen.getByRole('combobox', {name: '機器'});
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
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        expect(surface.scrollTop).toBe(0);
        expect(body.scrollTop).toBe(0);
        expect(screen.getByRole('heading', { name: 'マイクを選んでください' })).toHaveFocus();
    });
    const openListeningOutput = async () => {
        await openWizard();
        await screen.findByRole('radio', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('radio', { name: '自分で聴く' }));
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
            fireEvent.click(screen.getByRole('radio', { name: /ヘッドホン・スピーカー/ }));
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
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
        await waitFor(() => expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled());
        outputs = outputs.map(d => ({ ...d, is_default: d.name === 'スピーカー USB' }));
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
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
        expect(screen.getByRole('button', { name: /次へ/ })).toHaveAccessibleDescription('出力先を選ぶと次へ進めます');
        fireEvent.change(output, { target: { value: 'CABLE-A Input (VB-Audio)' } });
        expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
        expect(screen.getByRole('button', { name: /次へ/ })).not.toHaveAttribute('aria-describedby');
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
        expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue('');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        fireEvent.change(screen.getByRole('combobox', { name: '機器' }), { target: { value: 'Loopback' } });
        expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled();
    });

    it('物理マイクが複数あれば既定の候補でも自動選択せず、明示選択を待つ', async () => {
        inputs = [device('再生リダイレクト', true), { ...device('Microphone USB', true), is_default: false }, mic];
        await openWizard();
        await screen.findByRole('radio', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        const select = screen.getByRole('combobox', { name: '機器' });
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
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
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
        await screen.findByRole('radio', { name: 'OBSで配信' });
        fireEvent.click(screen.getByRole('radio', { name: '通話（Discordなど）' }));
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
        await screen.findByRole('combobox', { name: '機器' });
        inputs = [];
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
        await screen.findByText('機器が見つかりませんでした。');
        expect(screen.getByRole('button', { name: /次へ/ })).toBeDisabled();
        inputs = [device('別のマイク', true)];
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue('別のマイク'));
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
        expect(onApplyConfig).toHaveBeenCalledWith('WASAPI', mic.name, cable.name, expect.objectContaining({ sample_rate: 48000, buffer_size: 512, channels: 2, routing: { outputRouting: { mode: 'independent', channels: [0, 1] } } }));
        vi.mocked(invoke).mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalled();
    });
});

describe('初回選択と表示設定', () => {
    it.each([false, true])('初期選択はVSTのページを開かず、そのまま保存しても数値の詳細を変えない：details=%s', async details => {
        localStorage.setItem('vst_host_beginner_mode', String(!details));
        const { onCompleted } = await quickStart();
        expect(screen.getByRole('radio', { name: vstChoice })).not.toBeChecked();
        expect(screen.getByRole('radio', { name: '配信をはじめたい' })).toBeChecked();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBeNull();
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!details));
        expect(onCompleted).not.toHaveBeenCalled();
    });
    it.each([
        [false, false], [false, true], [true, false], [true, true],
    ])('VSTを選んだときだけ完了後にページを開き、数値の詳細はVST選択でのみ ON にする：VST=%s details=%s', async (vst, details) => {
        localStorage.setItem('vst_host_beginner_mode', String(!details));
        const { onCompleted } = await quickStart();
        fireEvent.click(screen.getByRole('radio', { name: vst ? vstChoice : '配信をはじめたい' }));
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!details));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(onCompleted).not.toHaveBeenCalled();
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(!(details || vst)));
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBeNull();
        if (vst) expect(onCompleted).toHaveBeenCalledWith(true);
        else expect(onCompleted).not.toHaveBeenCalled();
    });
    it('確認画面で表示を選んだ後に中断しても既存の表示設定を変えない', async () => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        const { onClose } = await quickStart();
        fireEvent.click(screen.getByRole('radio', { name: '配信をはじめたい' }));
        fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        fireEvent.click(within(screen.getByRole('alertdialog', { name: 'セットアップを中断しますか？' })).getByRole('button', { name: '中断する' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    });
    it('目的を選んだだけで中断しても、保存済みの用途と通知を変えない', async () => {
        localStorage.setItem('vst_host_setup_goal', 'listening');
        const notified = vi.fn();
        window.addEventListener('preparation-purpose-changed', notified);
        try {
            const { onClose } = await openWizard();
            fireEvent.click(screen.getByRole('radio', { name: '通話（Discordなど）' }));
            fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
            fireEvent.click(within(screen.getByRole('alertdialog', { name: 'セットアップを中断しますか？' })).getByRole('button', { name: '中断する' }));
            await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
            expect(localStorage.getItem('vst_host_setup_goal')).toBe('listening');
            expect(notified).not.toHaveBeenCalled();
        } finally { window.removeEventListener('preparation-purpose-changed', notified); }
    });
    it.each([['listening', '自分で聴く'], ['local', '自分で聴く'], ['discord', '通話（Discordなど）']])('保存済みの目的 %s は最初の画面で選択中として示し、保存値は変えない', async (saved, name) => {
        localStorage.setItem('vst_host_setup_goal', saved);
        await openWizard();
        expect(screen.getByRole('radio', { name })).toBeChecked();
        expect(screen.getAllByRole('radio', { checked: true })).toHaveLength(1);
        expect(localStorage.getItem('vst_host_setup_goal')).toBe(saved);
    });
    it('設定し直すときは、いま使っているマイクを選んだ状態で入力へ進み、重複した警告を出さない', async () => {
        inputs = [mic, device('Second microphone', true)];
        const base = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation((command, args, options) => {
            if (command === 'get_audio_state') return Promise.resolve({ is_running: true, config: { host: 'WASAPI', input: 'Second microphone', output: 'スピーカー' } });
            if (command === 'get_audio_stream_state') return Promise.resolve({ running: true, streamFailed: false });
            return base(command, args, options);
        });
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue('Second microphone'));
        expect(screen.queryByText('デバイスを選択してください。')).toBeNull();
    });
    it('保存完了時に選んだ目的を用途として保存する', async () => {
        localStorage.setItem('vst_host_setup_goal', 'listening');
        await quickStart();
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('listening');
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
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
        expect(screen.queryByRole('radio', { name: '配信をはじめたい' })).not.toBeInTheDocument();
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
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        const input = screen.getByRole('combobox', { name: '機器' });
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
        fireEvent.click(await screen.findByRole('radio', { name: '自分で聴く' }));
        fireEvent.click(screen.getByRole('radio', { name: 'PCの音' }));
        await screen.findByRole('combobox', { name: '機器' });
    };
    const toConfirm = async () => {
        await chooseMusic();
        await waitFor(() => expect(screen.getByRole('button', { name: /次へ/ })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        await screen.findByRole('heading', { name: '設定と接続の確認' });
    };
    it.each(['ja', 'en'] as const)('出力手順でPCの入力が失われたら戻って選び直す理由を伝える（%s）', async locale => {
        inputs = [device('CABLE Output', true)];
        outputs = [device('Headphones')];
        const store = createLocaleStore(() => 'ja', () => true);
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn()} /></LocaleProvider>);
        await chooseMusic();
        await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: '次へ' }));
        inputs = []; outputs = [];
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
        await screen.findByText('戻ってPCの音を選ぶと進めます');
        act(() => { store.setLocale(locale); });
        const actions = within(screen.getByTestId('setup-actions'));
        const next = actions.getByRole('button', { name: locale === 'ja' ? '次へ' : 'Next' });
        expect(next).toBeDisabled();
        expect(next).toHaveAccessibleDescription(locale === 'ja' ? '戻ってPCの音を選ぶと進めます' : 'Go back and select the PC audio input to continue');
        const back = actions.getByRole('button', { name: locale === 'ja' ? '戻る' : 'Back' });
        back.focus();
        expect(back).toHaveFocus();
        fireEvent.click(back);
        expect(actions.getByRole('status')).toHaveTextContent(locale === 'ja' ? 'PCの音を選ぶと次へ進めます' : 'Select the PC audio input to continue');
        expect(screen.getByRole('heading')).toHaveFocus();
    });

    it('選択だけでは既存目的や音設定を変えず、複数ケーブルは選択を待つ', async () => {
        inputs = [mic, device('CABLE Output A', true), device('CABLE Output B', true)];
        localStorage.setItem('vst_host_setup_goal', 'obs');
        await openWizard(); await chooseMusic();
        expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue('');
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
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size, inputChannels: actual.routing?.inputChannels, outputRouting: actual.routing?.outputRouting }));
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
    ] as const)('音楽鑑賞は保存待ち・失敗時にページを開かず、読み戻し成功後だけ数値の詳細と完了を反映する：VST=%s %s', async (vst, result) => {
        inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
        localStorage.setItem('vst_host_beginner_mode', String(vst));
        const original = vi.mocked(invoke).getMockImplementation()!;
        const inactive = { ...snapshot, config: { ...fx, active: false, reverb: { ...fx.reverb, enabled: false } } };
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'get_engine_runtime_stats') return { latencyMetadata: { streamRunning: true }, noiseReductionEnabled: false, noiseReductionMode: 'high', noiseControlStrength: 0.6, noiseVoiceGuard: false };
            if (command === 'builtin_effects') return inactive;
            return original(command, args);
        });
        const { onApplyConfig, onCompleted } = await openWizard();
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        onApplyConfig.mockImplementation(async (host, input, output, actual) => {
            await pending;
            if (result === 'reject') throw new Error('save failure');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size, inputChannels: actual.routing?.inputChannels, outputRouting: actual.routing?.outputRouting }));
            if (result !== 'readback') localStorage.setItem('vst_host_wizard_done', 'true');
        });
        await toConfirm();
        fireEvent.click(screen.getByRole('radio', { name: vst ? vstChoice : '音を手軽に調整したい' }));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await waitFor(() => expect(onApplyConfig).toHaveBeenCalledOnce());
        expect(onCompleted).not.toHaveBeenCalled();
        await act(async () => { finish(); });
        if (result === 'success') await screen.findByRole('heading', { name: '音声設定を保存しました' });
        else await screen.findByRole('alert');
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBeNull();
        expect(localStorage.getItem('vst_host_beginner_mode')).toBe(String(result === 'success' && vst ? false : vst));
        if (result === 'success') fireEvent.click(screen.getByRole('button', { name: 'セットアップを閉じる' }));
        if (result === 'success' && vst) expect(onCompleted).toHaveBeenCalledWith(true);
        else expect(onCompleted).not.toHaveBeenCalled();
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
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size, inputChannels: actual.routing?.inputChannels, outputRouting: actual.routing?.outputRouting }));
            localStorage.setItem('vst_host_wizard_done', 'true');
        });
        await toConfirm();
        expect(screen.getByRole('radio', { name: '音を手軽に調整したい' })).toBeChecked();
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('music');
        expect(localStorage.getItem('auralyn_vst_panel_open')).toBeNull();
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
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input, output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size, inputChannels: actual.routing?.inputChannels, outputRouting: actual.routing?.outputRouting }));
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
    it('通常の目的でも反映に失敗したら保存済みの用途を変えない', async () => {
        localStorage.setItem('vst_host_setup_goal', 'listening');
        render(<SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn().mockRejectedValue(new Error('save failed'))} />);
        await chooseObsRoute();
        fireEvent.click(await screen.findByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '設定と接続の確認' });
        await waitFor(() => expect(screen.getByRole('button', { name: '設定を保存して開始' })).toBeEnabled());
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('listening');
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

describe('セットアップの見た目と動き（#294）', () => {
    it.each(['ja', 'en'] as const)('済んだ手順だけに完了を添え、現在と未到達の手順を区別する（%s）', async locale => {
        const store = createLocaleStore(() => 'ja', () => true);
        render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn()} /></LocaleProvider>);
        await screen.findByRole('radio', { name: 'OBSで配信' });
        await chooseObsRoute();
        act(() => { store.setLocale(locale); });
        const rail = screen.getByRole('navigation', { name: locale === 'ja' ? 'セットアップの進捗' : 'Setup progress' });
        const rows = within(rail).getAllByRole('listitem');
        const completed = locale === 'ja' ? '（完了）' : '(completed)';
        rows.slice(0, 3).forEach(row => {
            expect(within(row).getByText(completed)).toHaveClass('sr-only');
            expect(row).not.toHaveAttribute('aria-current');
        });
        expect(rows[3]).toHaveAttribute('aria-current', 'step');
        expect(within(rows[3]).queryByText(completed)).not.toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('setup-actions')).getByRole('button', { name: message(locale, 'wizard.outputAgain') }));
        await waitFor(() => expect(rows[2]).toHaveAttribute('aria-current', 'step'));
        expect(within(rows[2]).queryByText(completed)).not.toBeInTheDocument();
        expect(rows[3]).not.toHaveAttribute('aria-current');
        expect(within(rows[3]).queryByText(completed)).not.toBeInTheDocument();
    });

    it('折り返しで前の行や現在行の高さが変わっても印の位置と高さを測り直し、監視を解除する', async () => {
        let measure!: ResizeObserverCallback;
        const observe = vi.fn();
        const disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) { measure = callback; }
            observe = observe;
            disconnect = disconnect;
        });
        const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get');
        const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get');
        let rowTop = 72;
        let rowHeight = 64;
        top.mockImplementation(function (this: HTMLElement) { return this.tagName === 'LI' ? rowTop : 0; });
        height.mockImplementation(function (this: HTMLElement) { return this.tagName === 'LI' ? rowHeight : 0; });
        try {
            await openWizard();
            // Portal の中身が後から現れても、手順を変える前の初回表示で印を測る。
            const firstThumb = screen.getByRole('navigation', { name: 'セットアップの進捗' }).querySelector('.setup-rail-thumb');
            expect(firstThumb).toHaveStyle({ transform: 'translateY(72px)', height: '64px' });
            fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
            const rail = screen.getByRole('navigation', { name: 'セットアップの進捗' });
            const rows = within(rail).getAllByRole('listitem');
            const thumb = rail.querySelector('.setup-rail-thumb');
            expect(thumb).toHaveStyle({ transform: 'translateY(72px)', height: '64px' });
            rows.forEach(row => expect(observe).toHaveBeenCalledWith(row));
            rows.forEach(row => {
                expect(row).toHaveClass('min-h-11');
                expect(row).not.toHaveClass('h-11');
                expect(row.lastElementChild).toHaveClass('min-w-0', 'wrap-break-word');
                expect(row.lastElementChild).not.toHaveClass('truncate');
            });
            rowTop = 100; rowHeight = 88;
            act(() => measure([], {} as ResizeObserver));
            expect(thumb).toHaveStyle({ transform: 'translateY(100px)', height: '88px' });
            cleanup();
            expect(disconnect).toHaveBeenCalled();
        } finally {
            top.mockRestore(); height.mockRestore(); vi.unstubAllGlobals();
        }
    });

    it('手順レールはホームの流れと同じ名前で現在の手順を示し、進む・戻るの向きを中身へ渡す', async () => {
        await openWizard();
        const rail = screen.getByRole('navigation', { name: 'セットアップの進捗' });
        expect([...rail.querySelectorAll('li')].map(item => item.textContent)).toEqual(['1送り先', '2マイク', '3出力先', '4確認']);
        expect(screen.getByRole('heading', { name: '送り先を選んでください' })).toBeVisible();
        expect(within(rail).getByText('送り先').closest('li')).toHaveAttribute('aria-current', 'step');
        // 高さは手順によらず固定し、中身だけをスクロールする。
        expect(document.querySelector('.setup-surface')).not.toBeNull();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        await screen.findByRole('combobox', { name: '機器' });
        expect(within(rail).getByText('マイク').closest('li')).toHaveAttribute('aria-current', 'step');
        expect(document.querySelector('.setup-step')).toHaveAttribute('data-dir', '1');
        fireEvent.click(within(screen.getByTestId('setup-actions')).getByRole('button', { name: '戻る' }));
        expect(within(rail).getByText('送り先').closest('li')).toHaveAttribute('aria-current', 'step');
        expect(document.querySelector('.setup-step')).toHaveAttribute('data-dir', '-1');
        // 同じ手順のまま再描画しても、動きの途中で向きを反転させない。
        fireEvent.change(screen.getByRole('combobox', { name: '表示言語' }), { target: { value: 'en' } });
        expect(await screen.findByText('Destination')).toBeInTheDocument();
        expect(document.querySelector('.setup-step')).toHaveAttribute('data-dir', '-1');
        fireEvent.change(screen.getByRole('combobox', { name: 'Display language' }), { target: { value: 'ja' } });
        expect(await screen.findByText('送り先')).toBeInTheDocument();
    });

    it('選んだカードは印を付けて示し、繰り返す点滅を使わない', async () => {
        await openWizard();
        const obs = screen.getByRole('radio', { name: 'OBSで配信' });
        expect(obs.closest('label')).toHaveAttribute('data-selected', String((obs as HTMLInputElement).checked));
        expect(document.querySelector('[role="dialog"] .animate-pulse')).toBeNull();
    });
});

describe('セットアップでの ASIO（#291）', () => {
    const asio = (isInput: boolean): AudioDevice => ({ name: 'Test ASIO', host: 'ASIO', is_input: isInput, index: 0, channels: 8, is_default: false, id: 'asio:test' });

    it('#464: 3ch ASIOの最後のモノラル候補を空にせず、開始と保存へ[2,2]を渡す', async () => {
        inputs = [{ ...asio(true), channels: 3 }];
        outputs = [{ ...asio(false), channels: 3 }];
        const { onApplyConfig } = await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue('Test ASIO'));
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        for (const name of ['入力チャンネル', '出力チャンネル']) {
            const select = await screen.findByRole('combobox', { name });
            const options = within(select).getAllByRole('option') as HTMLOptionElement[];
            expect(options.map(option => option.value.split(',').map(Number))).toEqual([[0, 1], [2, 2]]);
            expect(options.every(option => option.textContent?.trim())).toBe(true);
            expect(select).toHaveValue('0,1');
            fireEvent.change(select, { target: { value: '2,2' } });
            expect(select).toHaveValue('2,2');
            expect((select as HTMLSelectElement).selectedOptions).toHaveLength(1);
        }
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        const routing = { inputChannels: [2, 2], outputRouting: { mode: 'independent', channels: [2, 2] } };
        expect(invoke).toHaveBeenCalledWith('start_audio', expect.objectContaining({ host: 'ASIO', channelRouting: routing }));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        const starts = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'start_audio');
        expect(starts.length).toBeGreaterThan(0);
        for (const [, payload] of starts) expect(payload).toEqual(expect.objectContaining({ channelRouting: routing }));
        expect(onApplyConfig).toHaveBeenCalledExactlyOnceWith('ASIO', 'Test ASIO', 'Test ASIO', expect.objectContaining({ routing }));
    });

    it.each(['Realtek ASIO', 'VB-Audio Voicemeeter Insert Virtual ASIO'])('専用driverを先に出しても保存済みの%sを上書きしない', async name => {
        const generic = { ...asio(true), name, id: 'asio:generic' };
        inputs = [generic, asio(true)];
        outputs = inputs.map(input => ({ ...input, is_input: false }));
        const original = vi.mocked(invoke).getMockImplementation()!;
        let resolveState!: (state: unknown) => void;
        vi.mocked(invoke).mockImplementation((command, args, options) => command === 'get_audio_state'
            ? new Promise(resolve => { resolveState = resolve; })
            : original(command, args, options));
        const view = renderHook(() => useSetupWizard({ isOpen: true, onClose: vi.fn(), onApplyConfig: vi.fn() }));
        await waitFor(() => expect(view.result.current.isLoadingDevices).toBe(false));
        act(() => { view.result.current.selectGoal('obs'); view.result.current.selectHost('ASIO'); });
        expect(view.result.current.config.input).toBeNull();
        await act(async () => resolveState({ is_running: false, config: { host: 'ASIO', input: name, input_id: generic.id, output: name } }));
        await waitFor(() => expect(view.result.current.config.input?.id).toBe(generic.id));
        expect(view.result.current.availableInputs.map(input => input.name)).toEqual(['Test ASIO', name]);
        await act(async () => { await view.result.current.loadDevices(true); });
        expect(view.result.current.config.input?.id).toBe(generic.id);
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    });

    it('停止中でエンジン構成がなくても保存済みの汎用driverを推奨で置き換えない', async () => {
        const generic = { ...asio(true), name: 'Realtek ASIO', id: 'asio:generic' };
        inputs = [generic, asio(true)];
        outputs = inputs.map(input => ({ ...input, is_input: false }));
        const saved = JSON.stringify({ host: 'ASIO', input: generic.name, inputId: generic.id, output: generic.name });
        localStorage.setItem('vst_host_audio_config', saved);
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue(generic.name));
        expect(localStorage.getItem('vst_host_audio_config')).toBe(saved);
        expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    });

    it('専用driverの推奨後も汎用driverの明示選択を再検出で上書きしない', async () => {
        const generic = { ...asio(true), name: 'Realtek ASIO', id: 'asio:generic' };
        inputs = [generic, asio(true)];
        outputs = inputs.map(input => ({ ...input, is_input: false }));
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        const input = screen.getByRole('combobox', { name: '機器' });
        await waitFor(() => expect(input).toHaveValue('Test ASIO'));
        fireEvent.change(input, { target: { value: generic.name } });
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_audio_devices', { forceRefresh: true }));
        expect(input).toHaveValue(generic.name);
    });

    it('ASIO 機器がなければ接続方式を出さず、WASAPI の流れを変えない', async () => {
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        await screen.findByRole('combobox', { name: '機器' });
        expect(screen.queryByRole('radio', { name: 'ASIO（オーディオインターフェース）' })).not.toBeInTheDocument();
    });

    it('ASIO を選ぶと同じ機器へ返し、選んだチャンネルで音の確認と保存まで終えられる', async () => {
        inputs = [mic, asio(true)];
        outputs = [cable, device('スピーカー'), asio(false)];
        const { onApplyConfig } = await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        const input = screen.getByRole('combobox', { name: '機器' });
        expect(within(input).queryByRole('option', { name: mic.name })).not.toBeInTheDocument();
        await waitFor(() => expect(input).toHaveValue('Test ASIO'));
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        await screen.findByRole('heading', { name: '音の出力先を選んでください' });
        // 送り先の種類（仮想ケーブルなど）は出さず、チャンネルだけを選ぶ。
        expect(screen.queryByRole('button', { name: /仮想ケーブル/ })).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('combobox', { name: '入力チャンネル' }), { target: { value: '2,3' } });
        fireEvent.change(screen.getByRole('combobox', { name: '出力チャンネル' }), { target: { value: '4,5' } });
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        await screen.findByRole('heading', { name: '設定と接続の確認' });
        fireEvent.click(screen.getByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        const routing = { inputChannels: [2, 3], outputRouting: { mode: 'independent', channels: [4, 5] } };
        expect(invoke).toHaveBeenCalledWith('start_audio', expect.objectContaining({ host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO', channelRouting: routing }));
        fireEvent.click(screen.getByRole('button', { name: '設定を保存して開始' }));
        await screen.findByRole('heading', { name: '音声設定を保存しました' });
        expect(onApplyConfig).toHaveBeenCalledWith('ASIO', 'Test ASIO', 'Test ASIO', expect.objectContaining({ routing }));
    });

    it('WASAPI へ戻すと ASIO の機器とチャンネルを捨てて選び直す', async () => {
        inputs = [mic, asio(true)];
        outputs = [cable, asio(false)];
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue('Test ASIO'));
        fireEvent.click(screen.getByRole('radio', { name: 'WASAPI（標準）' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue(mic.name));
        expect(within(screen.getByRole('combobox', { name: '機器' })).queryByRole('option', { name: 'Test ASIO' })).not.toBeInTheDocument();
    });

    it('機器を替えたら前の機器のチャンネルを持ち越さず、1ch の機器ではそのチャンネルだけで開始する', async () => {
        const mono = (isInput: boolean): AudioDevice => ({ ...asio(isInput), name: 'Mono ASIO', id: 'asio:mono', channels: 1 });
        inputs = [mic, asio(true), mono(true)];
        outputs = [cable, asio(false), mono(false)];
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        const input = screen.getByRole('combobox', { name: '機器' });
        fireEvent.change(input, { target: { value: 'Test ASIO' } });
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.change(await screen.findByRole('combobox', { name: '入力チャンネル' }), { target: { value: '6,7' } });
        fireEvent.click(within(screen.getByTestId('setup-actions')).getByRole('button', { name: '戻る' }));
        fireEvent.change(await screen.findByRole('combobox', { name: '機器' }), { target: { value: 'Mono ASIO' } });
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        const channels = await screen.findByRole('combobox', { name: '入力チャンネル' });
        expect(channels).toHaveValue('0,0');
        expect(within(channels).getAllByRole('option')).toHaveLength(1);
        expect(screen.getByRole('combobox', { name: '出力チャンネル' })).toHaveValue('0,0');
        fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'マイクの音を流して確認' }));
        await screen.findByRole('button', { name: 'マイクの確認を停止' });
        expect(invoke).toHaveBeenCalledWith('start_audio', expect.objectContaining({ input: 'Mono ASIO',
            channelRouting: { inputChannels: [0, 0], outputRouting: { mode: 'independent', channels: [0, 0] } } }));
    });

    it('ASIO を選んだ後に機器が見えなくなっても、WASAPI へ戻せる', async () => {
        inputs = [mic, asio(true)];
        outputs = [cable, asio(false)];
        await openWizard();
        fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'ASIO（オーディオインターフェース）' }));
        inputs = [mic];
        outputs = [cable];
        fireEvent.click(screen.getByRole('button', { name: '機器を再検出' }));
        fireEvent.click(await screen.findByRole('radio', { name: 'WASAPI（標準）' }));
        await waitFor(() => expect(screen.getByRole('combobox', { name: '機器' })).toHaveValue(mic.name));
    });
});


it.each(['obs', 'listening', 'music'] as const)('マイクとPCの音の選択欄は日英で見えるラベルから読み上げ名を得る（%s）', async goal => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><SetupWizardModal isOpen onClose={vi.fn()} onApplyConfig={vi.fn()} /></LocaleProvider>);
    fireEvent.click(await screen.findByRole('radio', { name: goal === 'obs' ? 'OBSで配信' : '自分で聴く' }));
    if (goal === 'music') fireEvent.click(screen.getByRole('radio', { name: 'PCの音' }));
    const select = await screen.findByRole('combobox', { name: '機器' });
    expect(screen.getByLabelText('機器', { exact: true })).toBe(select);
    expect(select).not.toHaveAttribute('aria-label');
    expect(screen.getByText('機器', { selector: 'label' })).toHaveAttribute('for', select.id);
    expect(screen.getByRole('heading', { name: goal === 'music' ? 'PCの音を選んでください' : 'マイクを選んでください' })).toBeVisible();
    select.focus();
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('combobox', { name: 'Device' })).toBe(select);
    expect(screen.getByLabelText('Device', { exact: true })).toBe(select);
    expect(screen.getByRole('heading', { name: goal === 'music' ? 'Choose PC audio' : 'Choose a microphone' })).toBeVisible();
    expect(select).toHaveFocus();
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
});


it('ASIOからPCの音へ切り替えるとWASAPIの既定出力を選ぶ', async () => {
    const asio = { ...device('ASIO interface'), host: 'ASIO', id: 'asio' };
    const speaker = { ...device('Windows speaker'), id: 'speaker' };
    inputs = [mic, { ...asio, is_input: true }]; outputs = [asio, speaker];
    const view = renderHook(() => useSetupWizard({ isOpen: true, onClose: vi.fn(), onApplyConfig: vi.fn() }));
    await waitFor(() => expect(view.result.current.asioAvailable).toBe(true));
    act(() => view.result.current.selectGoal('obs'));
    act(() => view.result.current.selectHost('ASIO'));
    expect(view.result.current.config.host).toBe('ASIO');
    act(() => view.result.current.selectGoal('music'));
    expect(view.result.current.config.host).toBe('WASAPI');
    expect(view.result.current.config.output?.id).toBe('speaker');
});

it('PCの音の出力先は2択を2列で並べる', async () => {
    inputs = [device('CABLE Output', true)]; outputs = [device('Headphones')];
    await openWizard();
    fireEvent.click(screen.getByRole('radio', { name: '自分で聴く' }));
    fireEvent.click(screen.getByRole('radio', { name: 'PCの音' }));
    const next = screen.getByRole('button', { name: /次へ/ });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    const option = screen.getByRole('radio', { name: message('ja', 'guide.copy.198') });
    expect(option.closest('[role=radiogroup]')).toHaveClass('grid-cols-2');
    expect(within(option.closest('[role=radiogroup]') as HTMLElement).getAllByRole('radio')).toHaveLength(2);
});

it('戻って同じ送り先を決定でき、矢印選択では最初の手順を保つ', async () => {
    await openWizard();
    fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    fireEvent.click(screen.getByRole('radio', { name: 'OBSで配信' }));
    expect(screen.queryByRole('radio', { name: 'OBSで配信' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    const from = screen.getByRole('radio', { name: 'OBSで配信' });
    const to = screen.getByRole('radio', { name: '通話（Discordなど）' });
    // JSDOMでブラウザ標準の矢印選択を再現する。
    from.focus(); fireEvent.keyDown(from, { key: 'ArrowRight' });
    to.focus(); fireEvent.click(to); fireEvent.keyUp(to, { key: 'ArrowRight' });
    expect(to).toBeChecked(); expect(from).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
});

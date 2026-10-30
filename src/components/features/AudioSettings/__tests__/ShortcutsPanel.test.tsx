import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ShortcutsPanel } from '../ShortcutsPanel';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
const initial = [{ action: 'muteToggle', shortcut: 'Alt+KeyM' }];
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); localStorage.clear(); });
function open(fail = false, bindings = initial) {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'get_shortcuts') return { bindings, errors: [] };
        if (command === 'begin_shortcut_capture') return '1';
        if (command === 'save_shortcuts') {
            if (fail) throw new Error('key conflict');
            return { bindings: (args as { bindings: unknown[] }).bindings, errors: [] };
        }
    });
    render(<ShortcutsPanel />);
}
it('キー入力で既存形式を作り、重複と OS 予約を検出し保存しない', async () => {
    open();
    const input = screen.getByRole('button', { name: 'ミュートONのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('begin_shortcut_capture'));
    fireEvent.keyDown(input, { key: 'm', code: 'KeyM', altKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('別の操作に登録');
    fireEvent.keyDown(input, { key: 'F4', code: 'F4', altKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('OS の予約操作');
    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    expect(input).toHaveTextContent('Control+Shift+KeyZ');
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await screen.findByText('キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', { bindings: [
        { action: 'muteToggle', shortcut: 'Alt+KeyM' }, { action: 'muteOn', shortcut: 'Control+Shift+KeyZ' },
    ] });
});
it('未対応キーと Escape は登録せず、取り消して既存の値を保持する', async () => {
    open();
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input); await waitFor(() => expect(invoke).toHaveBeenCalledWith('begin_shortcut_capture')); fireEvent.keyDown(input, { key: 'a', code: 'KeyA' });
    expect(screen.getByRole('status')).toHaveTextContent('対応していません');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(input).toHaveTextContent('Alt+KeyM');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
});
it('保存済みの修飾キー順が異なっても同じ組合せを重複として検出する', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_shortcuts' ? { bindings: [{ action: 'muteToggle', shortcut: 'Alt+Control+KeyM' }], errors: [] } : '1');
    render(<ShortcutsPanel />);
    const input = screen.getByRole('button', { name: 'ミュートONのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input); await waitFor(() => expect(invoke).toHaveBeenCalledWith('begin_shortcut_capture')); fireEvent.keyDown(input, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('別の操作に登録');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
});
it('内部コードを入力せず選択して保存し、解除と未保存の取り消しができる', async () => {
    open();
    const key = await screen.findByLabelText('ミュートを切り替えるの通常キー');
    await waitFor(() => expect(key).toBeEnabled());
    expect(key).toHaveValue('KeyM');
    fireEvent.change(key, { target: { value: 'KeyN' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を取り消す' }));
    expect(key).toHaveValue('KeyM');
    fireEvent.change(key, { target: { value: 'KeyN' } });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await screen.findByText('キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', { bindings: [{ action: 'muteToggle', shortcut: 'Alt+KeyN' }] });
    fireEvent.click(screen.getByRole('button', { name: '登録を解除：ミュートを切り替える' }));
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('save_shortcuts', { bindings: [] }));
});
it('保存失敗後も既存登録へ取り消せ、未完の組合せは送らない', async () => {
    open(true);
    const key = screen.getByLabelText('ミュートを切り替えるの通常キー');
    await waitFor(() => expect(key).toBeEnabled());
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    expect(screen.getByRole('status')).toHaveTextContent('両方を選択');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
    fireEvent.change(key, { target: { value: 'KeyN' } });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    expect(await screen.findByRole('status')).toHaveTextContent('保存できませんでした');
    fireEvent.click(screen.getByRole('button', { name: '変更を取り消す' }));
    expect(key).toHaveValue('KeyM');
});
it('歌と雑談は明示登録できるが自動キーはなく、9件以上は既存登録を変えない', async () => {
    // 既存8件は取得結果で準備し、境界を越える1件だけを画面から入力する。
    const actions = ['muteToggle', 'muteOn', 'muteOff', 'bypassToggle', 'bypassOn', 'bypassOff', 'gainUp', 'gainDown'];
    const bindings = actions.map((action, index) => ({ action, shortcut: `Alt+F${index + 11}` }));
    open(false, bindings);
    const singing = await screen.findByLabelText('歌にするの通常キー');
    await waitFor(() => expect(singing).toBeEnabled());
    expect(singing).toHaveRole('combobox');
    expect(singing).toHaveValue('');
    expect(screen.getByLabelText('雑談にするの通常キー')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('歌にするの修飾キー'), { target: { value: 'Alt' } });
    fireEvent.change(singing, { target: { value: 'F19' } });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    expect(screen.getByRole('status')).toHaveTextContent('8件まで');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '登録を解除：出力音量を1%下げる' }));
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await screen.findByText('キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', { bindings: [
        ...bindings.filter(binding => binding.action !== 'gainDown'),
        { action: 'singingOn', shortcut: 'Alt+F19' },
    ] });
});

it('ノイズ低減の切替は既定キーなしで明示登録し、noiseToggleとして保存する', async () => {
    open();
    const key = await screen.findByLabelText('ノイズ低減を切り替えるの通常キー');
    await waitFor(() => expect(key).toBeEnabled());
    expect(key).toHaveValue('');
    fireEvent.change(screen.getByLabelText('ノイズ低減を切り替えるの修飾キー'), { target: { value: 'Alt' } });
    fireEvent.change(key, { target: { value: 'KeyN' } });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await screen.findByText('キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', { bindings: [
        { action: 'muteToggle', shortcut: 'Alt+KeyM' },
        { action: 'noiseToggle', shortcut: 'Alt+KeyN' },
    ] });
});

it('起動時の登録エラーは言語切替で再取得せず翻訳し、OS詳細とキー名を原文で保持する', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    vi.mocked(invoke).mockResolvedValue({ bindings: initial, errors: [
        { code: 'registerFailed', shortcut: 'Alt+KeyM', detail: 'OS 1409: 予約済み' },
        { code: 'unregisterFailed', detail: 'OS 1419' },
    ] });
    render(<LocaleProvider store={store}><ShortcutsPanel /></LocaleProvider>);
    await screen.findByText(/Alt\+KeyMを登録できませんでした/);
    fireEvent.change(screen.getByLabelText('ミュートを切り替えるの通常キー'), { target: { value: 'KeyN' } });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('status')).toHaveTextContent('Could not register Alt+KeyM.');
    expect(screen.getByRole('status')).toHaveTextContent('Could not unregister a previous shortcut.');
    expect(screen.getByRole('status')).toHaveTextContent('Original detail (untranslated): OS 1409: 予約済み');
    expect(screen.getByLabelText('Toggle mute regular key')).toHaveValue('KeyN');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('get_shortcuts');
});

it.each([
    [{ code: 'invalidShortcut', shortcut: 'Unknown+KeyP' }, 'Check the shortcut format: Unknown+KeyP'],
    [{ code: 'modifierRequired' }, 'Use a modifier such as Alt, Ctrl, or Shift'],
    [{ code: 'duplicateBinding' }, 'cannot be registered twice'],
    [{ code: 'registrationConflict', detail: 'OS 1409' }, 'Check for conflicts with other apps'],
    [{ code: 'saveFailed', detail: 'disk full' }, 'Could not save shortcut settings'],
])('保存拒否 %j を英語で表示し、編集値と取り消し先を保つ', async (error, expected) => {
    const store = createLocaleStore(() => 'en', () => true);
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_shortcuts') return { bindings: initial, errors: [] };
        throw error;
    });
    render(<LocaleProvider store={store}><ShortcutsPanel /></LocaleProvider>);
    const key = screen.getByLabelText('Toggle mute regular key');
    await waitFor(() => expect(key).toBeEnabled());
    fireEvent.change(key, { target: { value: 'KeyN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key settings' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(expected));
    expect(key).toHaveValue('KeyN');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(key).toHaveValue('KeyM');
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_shortcuts')).toHaveLength(1);
});

it('保存待機中の言語切替でも要求を増やさず、成功後の解除エラーを現在の言語で表示する', async () => {
    let finish!: (value: unknown) => void;
    const store = createLocaleStore(() => 'ja', () => true);
    vi.mocked(invoke).mockImplementation(async command => command === 'get_shortcuts'
        ? { bindings: initial, errors: [] }
        : new Promise(resolve => { finish = resolve; }));
    render(<LocaleProvider store={store}><ShortcutsPanel /></LocaleProvider>);
    const save = screen.getByRole('button', { name: 'キー設定を保存' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    act(() => { store.setLocale('en'); });
    await act(async () => finish({ bindings: [{ action: 'muteToggle', shortcut: 'Alt+KeyN' }], errors: [{ code: 'unregisterFailed', detail: 'OS 1419' }] }));
    expect(screen.getByRole('status')).toHaveTextContent('Could not unregister a previous shortcut.');
    expect(screen.getByRole('status')).toHaveTextContent('Original detail (untranslated): OS 1419');
    expect(screen.getByLabelText('Toggle mute regular key')).toHaveValue('KeyN');
    expect(invoke).toHaveBeenCalledTimes(2);
});

it('登録済みキーのイベントは一致するトークンだけを入力として採用する', async () => {
    let receive!: (event: { payload: { token: string; shortcut: string } }) => void;
    vi.mocked(listen).mockImplementationOnce(async (_name, callback) => { receive = callback as typeof receive; return () => {}; });
    open();
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('begin_shortcut_capture'));
    act(() => receive({ payload: { token: 'old', shortcut: 'Alt+KeyM' } }));
    expect(input).toHaveAttribute('aria-pressed', 'true');
    act(() => receive({ payload: { token: '1', shortcut: 'Alt+KeyM' } }));
    expect(input).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('end_shortcut_capture', { token: '1' }));
});
it('開始応答待ちの入力は無視し、解除後の遅い応答も解放する', async () => {
    let finish!: (token: string) => void;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_shortcuts') return { bindings: initial, errors: [] };
        if (command === 'begin_shortcut_capture') return new Promise(resolve => { finish = resolve; });
    });
    render(<ShortcutsPanel />);
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('begin_shortcut_capture'));
    expect(input).toHaveAttribute('aria-busy', 'true');
    expect(input).toHaveTextContent('キー入力を準備しています。まだキーを押さないでください。');
    fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', altKey: true });
    fireEvent.blur(input);
    expect(input).toHaveTextContent('Alt+KeyM');
    await act(async () => finish('42'));
    expect(invoke).toHaveBeenCalledWith('end_shortcut_capture', { token: '42' });
});
it('開始失敗時は選択式を維持して案内する', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_shortcuts') return { bindings: initial, errors: [] };
        if (command === 'begin_shortcut_capture') throw new Error('unavailable');
    });
    render(<ShortcutsPanel />);
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    expect(await screen.findByRole('status')).toHaveTextContent('キー入力を開始できませんでした');
    expect(screen.getByLabelText('ミュートを切り替えるの通常キー')).toHaveValue('KeyM');
});

it('30秒経過と unmount は入力を終了してネイティブセッションを解放する', async () => {
    open();
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    vi.useFakeTimers();
    try {
        fireEvent.click(input);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        act(() => vi.advanceTimersByTime(30000));
        expect(input).toHaveAttribute('aria-pressed', 'false');
        expect(invoke).toHaveBeenCalledWith('end_shortcut_capture', { token: '1' });
        fireEvent.click(input);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        cleanup();
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'end_shortcut_capture')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
});

it.each([
    ['ja', 'ミュートを切り替えるのキーを入力', 'キー入力を準備しています。まだキーを押さないでください。', '組み合わせを押してください'],
    ['en', 'Enter keys for Toggle mute', 'Preparing key input. Please do not press a key yet.', 'Press a combination'],
])('%s では開始応答後に入力待ちへ切り替える', async (locale, label, preparing, waiting) => {
    let finish!: (token: string) => void;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_shortcuts') return { bindings: initial, errors: [] };
        if (command === 'begin_shortcut_capture') return new Promise(resolve => { finish = resolve; });
    });
    const store = createLocaleStore(() => locale as 'ja' | 'en', () => true);
    render(<LocaleProvider store={store}><ShortcutsPanel /></LocaleProvider>);
    const input = screen.getByRole('button', { name: label });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('begin_shortcut_capture'));
    expect(input).toHaveTextContent(preparing);
    expect(input).toHaveAttribute('aria-busy', 'true');
    await act(async () => finish('42'));
    expect(input).toHaveTextContent(waiting);
    expect(input).toHaveAttribute('aria-busy', 'false');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(input).toHaveAttribute('aria-pressed', 'false');
    expect(invoke).toHaveBeenCalledWith('end_shortcut_capture', { token: '42' });
});

it.each([null, '', 'invalid', '18446744073709551616'])('不正な開始応答 %j は入力開始とせず選択式へ案内する', async response => {
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_shortcuts') return { bindings: initial, errors: [] };
        if (command === 'begin_shortcut_capture') return response;
    });
    render(<ShortcutsPanel />);
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    expect(await screen.findByRole('status')).toHaveTextContent('キー入力を開始できませんでした');
    expect(input).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('ミュートを切り替えるの通常キー')).toHaveValue('KeyM');
});

it('ウィンドウが非アクティブになると入力を終了しセッションを解放する', async () => {
    open();
    const input = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input);
    await waitFor(() => expect(input).toHaveAttribute('aria-busy', 'false'));
    fireEvent.blur(window);
    expect(input).toHaveAttribute('aria-pressed', 'false');
    expect(invoke).toHaveBeenCalledWith('end_shortcut_capture', { token: '1' });
});

it.each([
    ['Alt+Control+KeyM', 'Control+Alt+KeyM'],
    ['Ctrl+KeyM', 'Control+KeyM'],
])('登録済みネイティブ入力 %s は同操作に正規化し別操作との重複を検出する', async (stored, canonical) => {
    let receive!: (event: { payload: { token: string; shortcut: string } }) => void;
    vi.mocked(listen).mockImplementation(async (_name, callback) => { receive = callback as typeof receive; return () => {}; });
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_shortcuts') return { bindings: [{ action: 'muteToggle', shortcut: stored }], errors: [] };
        if (command === 'begin_shortcut_capture') return '1';
    });
    render(<ShortcutsPanel />);
    const other = screen.getByRole('button', { name: 'ミュートONのキーを入力' });
    const own = screen.getByRole('button', { name: 'ミュートを切り替えるのキーを入力' });
    await waitFor(() => expect(other).toBeEnabled());
    fireEvent.click(other);
    await waitFor(() => expect(other).toHaveAttribute('aria-busy', 'false'));
    act(() => receive({ payload: { token: '1', shortcut: stored } }));
    expect(screen.getByRole('status')).toHaveTextContent('別の操作に登録');
    fireEvent.click(other);
    fireEvent.click(own);
    await waitFor(() => expect(own).toHaveAttribute('aria-busy', 'false'));
    act(() => receive({ payload: { token: '1', shortcut: stored } }));
    expect(own).toHaveTextContent(canonical);
    expect(own).toHaveAttribute('aria-pressed', 'false');
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(async () => () => {});
});

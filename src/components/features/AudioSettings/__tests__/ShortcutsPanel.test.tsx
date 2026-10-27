import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ShortcutsPanel } from '../ShortcutsPanel';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
const initial = [{ action: 'muteToggle', shortcut: 'Alt+KeyM' }];
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); localStorage.clear(); });
function open(fail = false) {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'get_shortcuts') return { bindings: initial, errors: [] };
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
    fireEvent.click(input); fireEvent.keyDown(input, { key: 'a', code: 'KeyA' });
    expect(screen.getByRole('status')).toHaveTextContent('対応していません');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(input).toHaveTextContent('Alt+KeyM');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
});
it('保存済みの修飾キー順が異なっても同じ組合せを重複として検出する', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_shortcuts' ? { bindings: [{ action: 'muteToggle', shortcut: 'Alt+Control+KeyM' }], errors: [] } : null);
    render(<ShortcutsPanel />);
    const input = screen.getByRole('button', { name: 'ミュートONのキーを入力' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(input); fireEvent.keyDown(input, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('別の操作に登録');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
});
it('内部コードを入力せず選択して保存し、解除と未保存の取り消しができる', async () => {
    open();
    const key = await screen.findByRole('combobox', { name: 'ミュートを切り替えるの通常キー' });
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
    const key = screen.getByRole('combobox', { name: 'ミュートを切り替えるの通常キー' });
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
    open();
    const singing = await screen.findByRole('combobox', { name: '歌にするの通常キー' });
    await waitFor(() => expect(singing).toBeEnabled());
    expect(singing).toHaveValue('');
    const labels = ['ミュートを切り替える', 'ミュートON', 'ミュートOFF', '原音比較を切り替える', '原音比較ON', '原音比較OFF', '出力ゲインを1%上げる', '出力ゲインを1%下げる', '歌にする'];
    labels.forEach((label, index) => {
        fireEvent.change(screen.getByRole('combobox', { name: `${label}の修飾キー` }), { target: { value: 'Alt' } });
        fireEvent.change(screen.getByRole('combobox', { name: `${label}の通常キー` }), { target: { value: `F${index + 11}` } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    expect(screen.getByRole('status')).toHaveTextContent('8件まで');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '登録を解除：出力ゲインを1%下げる' }));
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await screen.findByText('キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', expect.objectContaining({ bindings: expect.arrayContaining([{ action: 'singingOn', shortcut: 'Alt+F19' }]) }));
});

it('ノイズ低減の切替は既定キーなしで明示登録し、noiseToggleとして保存する', async () => {
    open();
    const key = await screen.findByRole('combobox', { name: 'ノイズ低減を切り替えるの通常キー' });
    await waitFor(() => expect(key).toBeEnabled());
    expect(key).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: 'ノイズ低減を切り替えるの修飾キー' }), { target: { value: 'Alt' } });
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
    fireEvent.change(screen.getByRole('combobox', { name: 'ミュートを切り替えるの通常キー' }), { target: { value: 'KeyN' } });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('status')).toHaveTextContent('Could not register Alt+KeyM.');
    expect(screen.getByRole('status')).toHaveTextContent('Could not unregister a previous shortcut.');
    expect(screen.getByRole('status')).toHaveTextContent('Original detail (untranslated): OS 1409: 予約済み');
    expect(screen.getByRole('combobox', { name: 'Toggle mute regular key' })).toHaveValue('KeyN');
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
    const key = screen.getByRole('combobox', { name: 'Toggle mute regular key' });
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
    expect(screen.getByRole('combobox', { name: 'Toggle mute regular key' })).toHaveValue('KeyN');
    expect(invoke).toHaveBeenCalledTimes(2);
});

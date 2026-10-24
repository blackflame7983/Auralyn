import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ShortcutsPanel } from '../ShortcutsPanel';
const initial = [{ action: 'muteToggle', shortcut: 'Alt+KeyM' }];
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });
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
        fireEvent.change(screen.getByRole('combobox', { name: `${label}の通常キー` }), { target: { value: `F${index + 1}` } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    expect(screen.getByRole('status')).toHaveTextContent('8件まで');
    expect(invoke).not.toHaveBeenCalledWith('save_shortcuts', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '登録を解除：出力ゲインを1%下げる' }));
    fireEvent.click(screen.getByRole('button', { name: 'キー設定を保存' }));
    await screen.findByText('キー設定を保存しました。');
    expect(invoke).toHaveBeenCalledWith('save_shortcuts', expect.objectContaining({ bindings: expect.arrayContaining([{ action: 'singingOn', shortcut: 'Alt+F9' }]) }));
});

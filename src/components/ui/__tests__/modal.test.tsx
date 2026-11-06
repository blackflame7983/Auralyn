import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from '../modal';
import { ConfirmDialog, useConfirmDialog } from '../confirm-dialog';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Example({ locked = false }: { locked?: boolean }) {
    const [open, setOpen] = useState(false);
    const [confirm, setConfirm] = useState(false);
    return <>
        <button onClick={() => setOpen(true)}>設定を開く</button>
        <button>背景の操作</button>
        {open && <Modal title="設定" onClose={() => setOpen(false)} dismissible={!locked}>
            <div>
                <button onClick={() => setConfirm(true)}>削除</button>
                <button onClick={() => setOpen(false)}>閉じる</button>
                <ConfirmDialog isOpen={confirm} title="削除の確認" variant="destructive" onCancel={() => setConfirm(false)} onConfirm={vi.fn()} />
            </div>
        </Modal>}
    </>;
}

it('名前・モーダル性、背景の除外、Tab循環と終了後のフォーカス復帰を保つ', async () => {
    render(<Example />);
    const trigger = screen.getByRole('button', { name: '設定を開く' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '設定' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.queryByRole('button', { name: '背景の操作' })).not.toBeInTheDocument();
    const first = screen.getByRole('button', { name: '削除' });
    const last = screen.getByRole('button', { name: '閉じる' });
    await waitFor(() => expect(first).toHaveFocus());
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
});

it('入れ子の確認はキャンセルへ初期フォーカスし、Escapeは一番手前だけ閉じる', async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }));
    const remove = screen.getByRole('button', { name: '削除' });
    remove.focus();
    fireEvent.click(remove);
    expect(screen.getByRole('alertdialog', { name: '削除の確認' })).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    const confirm = screen.getByRole('button', { name: '確認' });
    await waitFor(() => expect(cancel).toHaveFocus());
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '削除の確認' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: '設定' })).toBeInTheDocument();
    await waitFor(() => expect(remove).toHaveFocus());
});

it('処理中にEscapeで画面を閉じない', async () => {
    render(<Example locked />);
    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }));
    await act(async () => {});
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '設定' })).toBeInTheDocument();
});

it.each([false, true])('ガイドから設定へ切り替えて閉じても、最初の入口へフォーカスを戻す: 遅延読み込み=%s', async delayed => {
    function SwitchExample() {
        const [page, setPage] = useState('');
        const [ready, setReady] = useState(false);
        return <>
            <button onClick={() => setPage('guide')}>ガイドの入口</button>
            {page === 'guide' && <Modal title="ガイド" onClose={() => setPage('')}>
                <div><button onClick={() => {
                    setPage('settings');
                    if (delayed) void Promise.resolve().then(() => setReady(true));
                }}>設定へ移動</button></div>
            </Modal>}
            {page === 'settings' && (!delayed || ready) && <Modal title="設定" onClose={() => setPage('')}>
                <div><button onClick={() => setPage('')}>設定を閉じる</button></div>
            </Modal>}
        </>;
    }
    render(<SwitchExample />);
    const launcher = screen.getByRole('button', { name: 'ガイドの入口' });
    launcher.focus();
    fireEvent.click(launcher);
    const next = screen.getByRole('button', { name: '設定へ移動' });
    await waitFor(() => expect(next).toHaveFocus());
    fireEvent.click(next);
    const close = await screen.findByRole('button', { name: '設定を閉じる' });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(launcher).toHaveFocus());
});

it.each(['confirm', 'cancel', 'escape'])('確認Promiseはlocale変更で再作成せず%sを一度だけ返す', async action => {
    const resolved = vi.fn();
    const store = createLocaleStore(() => 'ja', () => true);
    function ConfirmExample() {
        const {confirm, ConfirmDialogComponent} = useConfirmDialog();
        return <><button onClick={() => {void confirm({title:'User title', description:'User detail'}).then(resolved);}}>Open</button><ConfirmDialogComponent /></>;
    }
    render(<LocaleProvider store={store}><ConfirmExample /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', {name:'Open'}));
    const dialog = screen.getByRole('alertdialog', {name:'User title'});
    const cancel = screen.getByRole('button', {name:'キャンセル'});
    await waitFor(() => expect(cancel).toHaveFocus());
    act(() => {store.setLocale('en');});
    expect(screen.getByRole('alertdialog', {name:'User title'})).toBe(dialog);
    expect(screen.getByRole('button', {name:'Cancel'})).toBe(cancel);
    expect(cancel).toHaveFocus();
    expect(resolved).not.toHaveBeenCalled();
    if(action === 'escape') fireEvent.keyDown(cancel, {key:'Escape'});
    else fireEvent.click(screen.getByRole('button', {name:action === 'confirm' ? 'Confirm' : 'Cancel'}));
    await waitFor(() => expect(resolved).toHaveBeenCalledExactlyOnceWith(action === 'confirm'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it('明示labelをlocaleで置き換えず、非表示から表示へ切り替えてもhook順序を保つ', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const confirmed = vi.fn(); const canceled = vi.fn();
    const view = (isOpen: boolean) => <LocaleProvider store={store}><ConfirmDialog isOpen={isOpen} title="Exact title" confirmLabel="KEEP" cancelLabel="BACK" onConfirm={confirmed} onCancel={canceled}/></LocaleProvider>;
    const result = render(view(false));
    result.rerender(view(true));
    act(() => {store.setLocale('en');});
    expect(screen.getByRole('button', {name:'KEEP'})).toBeVisible();
    expect(screen.getByRole('button', {name:'BACK'})).toBeVisible();
    expect(screen.queryByRole('button', {name:'Confirm'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'KEEP'}));
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(canceled).not.toHaveBeenCalled();
});

it.each(['default', 'destructive'] as const)('確認のrole・題名1つ・説明文の関連付けを公開する (%s)', variant => {
    const title = '変更を確定しますか？';
    const description = '現在の設定が置き換わります。';
    const view = render(<ConfirmDialog isOpen title={title} description={description} variant={variant}
        onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: title });
    expect(dialog).toHaveAccessibleName(title);
    expect(dialog).toHaveAccessibleDescription(description);
    expect(screen.getAllByText(title)).toHaveLength(1);
    const heading = screen.getByRole('heading', { name: title, level: 3 });
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
    expect(dialog).toHaveAttribute('aria-describedby', screen.getByText(description).id);
    view.rerender(<ConfirmDialog isOpen title={title} variant={variant} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(dialog).toHaveAccessibleDescription('');
});

it.each([true, false])('Modalは説明文があるときだけ関連付け、警告を出さない: 説明あり=%s', described => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    render(<Modal title="設定" descriptionId={described ? 'settings-description' : undefined} onClose={vi.fn()}>
        <div>{described && <p id="settings-description">接続先を選びます。</p>}<button>閉じる</button></div>
    </Modal>);
    const dialog = screen.getByRole('dialog', { name: '設定' });
    expect(dialog).toHaveAccessibleDescription(described ? '接続先を選びます。' : '');
    if (!described) expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
});

it('確認の外側を押しても閉じず、明示キャンセル後は入口にフォーカスを戻す', async () => {
    function Example() {
        const [open, setOpen] = useState(false);
        return <><button onClick={() => setOpen(true)}>削除の入口</button>
            <ConfirmDialog isOpen={open} title="削除の確認" variant="destructive"
                onConfirm={vi.fn()} onCancel={() => setOpen(false)} /></>;
    }
    render(<Example />);
    const trigger = screen.getByRole('button', { name: '削除の入口' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus());
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('alertdialog', { name: '削除の確認' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => expect(trigger).toHaveFocus());
});

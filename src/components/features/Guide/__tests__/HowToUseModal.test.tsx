import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Header } from '@/components/layout/Header';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { shortcutActions } from '@/lib/shortcutActions';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('@/components/layout/AppUpdate', () => ({ useAppUpdate: () => ({}), UpdateGuide: () => null }));
vi.mock('@/components/features/DeviceStatus/DeviceStatus', () => ({ DeviceStatus: () => null }));

beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); vi.mocked(invoke).mockResolvedValue({ bindings: [{ action: 'gainUp', shortcut: 'Alt+KeyG' }], errors: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open(locale: 'ja' | 'en' = 'ja') {
    const store = createLocaleStore(() => locale, () => true);
    const props = { onOpenSettings: vi.fn(), onOpenShortcuts: vi.fn(), onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(), onOpenWizard: vi.fn(), currentHost: '', isEngineRunning: false };
    render(<LocaleProvider store={store}><input aria-label="入力" /><Header {...props} /></LocaleProvider>);
    return { store, props };
}

it.each(['ja', 'en'] as const)('メニュー先頭から開き、節を保存し、閉じるとヘルプへ戻る（%s）', async locale => {
    open(locale);
    const trigger = screen.getByRole('button', { name: message(locale, 'header.helpOpen') });
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findAllByRole('menuitem');
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent(message(locale, 'help.title'));
    fireEvent.click(items[0]);
    const dialog = await screen.findByRole('dialog', { name: message(locale, 'help.title') });
    const terms = within(dialog).getByRole('button', { name: message(locale, 'help.section.terms') });
    fireEvent.click(terms);
    expect(terms).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(13);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.getByRole('button', { name: message(locale, 'help.section.terms') })).toHaveAttribute('aria-current', 'page');
});

it('入力中のF1で開き、Tabはダイアログ内に留まり、閉じると入力へ戻る', async () => {
    open();
    const input = screen.getByRole('textbox'); input.focus();
    fireEvent.keyDown(input, { key: 'F1' });
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: '閉じる' });
    close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(close);
    await waitFor(() => expect(input).toHaveFocus());
});

it('ホットキーは共通定義と現在の割り当てから表示し、節の往復や言語変更では再取得しない', async () => {
    const { store, props } = open(); fireEvent.keyDown(window, { key: 'F1' });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作' }));
    await screen.findByText('Alt + G');
    for (const label of Object.values(shortcutActions)) expect(screen.getByText(message('ja', label))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ホームの見方' }));
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作' }));
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog', { name: 'How to use' })).toBeInTheDocument();
    expect(screen.getByText(message('en', shortcutActions.gainUp))).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('get_shortcuts');
    fireEvent.click(screen.getByRole('button', { name: 'Open hotkey settings' }));
    expect(props.onOpenShortcuts).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('localStorageも割り当て取得も使えない場合に閲覧と案内を保つ', async () => {
    open();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.mocked(invoke).mockRejectedValue(new Error('offline'));
    fireEvent.keyDown(window, { key: 'F1' });
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作' }));
    expect(await screen.findByText('設定のホットキーで確認できます。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['setup', 'trouble', 'obs', 'discord'] as const)('既存の入口へ移る（%s）', target => {
    const { props } = open(); fireEvent.keyDown(window, { key: 'F1' });
    fireEvent.click(screen.getByRole('button', { name: target === 'setup' ? 'はじめの設定' : '困ったとき' }));
    const names = { setup: 'セットアップを開く', trouble: '音のトラブルを診断', obs: message('ja', 'header.obs'), discord: message('ja', 'header.discord') };
    fireEvent.click(screen.getAllByRole('button', { name: names[target] })[0]);
    const callbacks = { setup: props.onOpenWizard, trouble: props.onOpenTroubleshoot, obs: props.onOpenOBSGuide, discord: props.onOpenDiscordGuide };
    expect(callbacks[target]).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('修飾キー付きF1と処理済みのキーを奪わない', () => {
    open();
    fireEvent.keyDown(window, { key: 'F1', ctrlKey: true });
    const event = new KeyboardEvent('keydown', { key: 'F1', cancelable: true }); event.preventDefault();
    window.dispatchEvent(event);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

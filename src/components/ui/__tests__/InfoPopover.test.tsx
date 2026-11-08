import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { getUserDocUrl } from '@/lib/userDocs';
import { afterEach, expect, it } from 'vitest';
import { InfoPopover } from '../InfoPopover';

afterEach(cleanup);

it('説明をキーボードで開き、Escape で閉じてフォーカスを戻す', async () => {
    render(<InfoPopover label="説明">補足内容</InfoPopover>);
    const button = screen.getByRole('button', { name: '説明' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(await screen.findByText('補足内容')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByText('補足内容')).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
});

it.each(['ja', 'en'] as const)('詳しくは表示言語のドキュメントを既存のopenerで開く（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><InfoPopover label="説明" docName="home.noise-reduction">補足内容</InfoPopover></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '説明' }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(message(locale, 'help.learnMore')) }));
    expect(openUrl).toHaveBeenLastCalledWith(getUserDocUrl('home.noise-reduction', locale));
});

it('対応先の指定がない情報ボタンには詳しくを出さない', () => {
    render(<InfoPopover label="説明">補足内容</InfoPopover>);
    fireEvent.click(screen.getByRole('button', { name: '説明' }));
    expect(screen.queryByRole('button', { name: /詳しく|Learn more/ })).not.toBeInTheDocument();
});

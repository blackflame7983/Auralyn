import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../LocaleProvider';
import { LanguageSelector } from '../LanguageSelector';
import { createLocaleStore } from '../locale';
import { projectLocale } from '../nativeLocale';

vi.mock('../nativeLocale', () => ({ projectLocale: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function deferred() {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(yes => { resolve = yes; });
    return { promise, resolve };
}

it.each([false, true])('言語同期の応答まで処理中を公開し、失敗時は翻訳済み案内を表示する: %s', async accepted => {
    const held = deferred();
    vi.mocked(projectLocale).mockReturnValue(held.promise);
    const write = vi.fn(() => true);
    const store = createLocaleStore(() => 'ja', write);
    const { container } = render(<LocaleProvider store={store}><LanguageSelector /></LocaleProvider>);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'en' } });
    expect(store.getSnapshot()).toBe('en');
    expect(container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('combobox')).toBe(select);
    expect(projectLocale).toHaveBeenCalledWith('en', true);
    expect(write).toHaveBeenCalledExactlyOnceWith('en');
    await act(async () => held.resolve(accepted));
    expect(container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    if (accepted) expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    else expect(screen.getByRole('alert')).toHaveTextContent('tray');
});

it('古い切替の失敗では最新の処理中・表示言語を戻さない', async () => {
    const first = deferred(); const second = deferred();
    vi.mocked(projectLocale).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = createLocaleStore(() => 'ja', () => true);
    const { container } = render(<LocaleProvider store={store}><LanguageSelector /></LocaleProvider>);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ja' } });
    await act(async () => first.resolve(false));
    expect(store.getSnapshot()).toBe('ja');
    expect(container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => second.resolve(true));
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

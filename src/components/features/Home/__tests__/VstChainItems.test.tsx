import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { VstChainItems } from '../VstChainItems';

afterEach(cleanup);
it.each(['ja', 'en'] as const)('無効VSTの見える名前と読み上げ名は名前とオフ状態にする (%s)', locale => {
    const toggle = vi.fn();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <VstChainItems plugins={[{ id: 'a', name: 'LoudMax', enabled: false, muted: true, hasEditor: true, path: '', vendor: '', version: '', gain: 1 }]}
            onToggle={toggle} onEdit={vi.fn()} />
    </LocaleProvider>);
    const button = screen.getByRole('button', { name: `LoudMax ${message(locale, 'chain.vstOff')} ${message(locale, 'chain.vstMuted')}` });
    expect(button).toHaveTextContent(`LoudMax${message(locale, 'chain.vstOff')}`);
    expect(button).not.toHaveTextContent('VST');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith('a', true);
    expect(screen.getByRole('button', { name: message(locale, 'chain.vstEdit', { name: 'LoudMax' }) })).toBeDisabled();
});

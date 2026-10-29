import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createLocaleStore } from '@/i18n/locale';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { message } from '@/i18n/messages';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { DisplayPurposeSelector } from '../DisplayPurposeSelector';

afterEach(() => { cleanup(); localStorage.clear(); });

it.each(['ja', 'en'] as const)('表示用途を切り替えても、セットアップの音声用途は変えない (%s)', locale => {
    localStorage.setItem('vst_host_setup_goal', 'obs');
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><DisplayPurposeSelector /></LocaleProvider>);
    const select = screen.getByRole('combobox', { name: message(locale, 'purpose.label') });
    expect(select).toHaveValue('voice');
    expect(select).toHaveAccessibleDescription(message(locale, 'purpose.hint'));
    fireEvent.change(select, { target: { value: 'music' } });
    expect(readDisplayPurpose()).toBe('music');
    expect(select).toHaveValue('music');
    expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
});

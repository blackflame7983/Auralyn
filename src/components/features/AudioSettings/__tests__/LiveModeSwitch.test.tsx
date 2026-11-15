import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveModeSwitch } from '../LiveModeBar';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { liveSnapshot } from '@/hooks/__tests__/liveModesFixture';
import type { LiveMode } from '@/api/liveModes';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

const config = { active: true, preset: 'broadcast' as const, amount: 0.7, singing: null, reverb: null };
const model = (phase: 'custom' | 'settled', applied: LiveMode | null) => {
    const select = vi.fn();
    return {
        value: {
            snapshot: liveSnapshot({
                phase, applied, running: true,
                definitions: { schemaVersion: 1, version: '1', singing: config, talk: config },
            }),
            error: '', busy: false, changesBlocked: false, select,
        } as unknown as LiveModesModel,
        select,
    };
};

afterEach(() => cleanup());

it.each(['ja', 'en'] as const)('上の帯の切替にいまの調整は無く、当たっていないときはどちらも選ばれない (%s)', locale => {
    const { value } = model('custom', null);
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveModeSwitch model={value} /></LocaleProvider>);
    const group = screen.getByRole('radiogroup', { name: message(locale, 'liveBar.mode') });
    expect(group).not.toHaveTextContent(message(locale, 'liveBar.custom'));
    expect(screen.queryByRole('radio', { name: message(locale, 'liveBar.custom') })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: message(locale, 'liveBar.singing') })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: message(locale, 'liveBar.talk') })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
});

it('登録した歌が当たっているときだけ、その選択肢を選ぶ', () => {
    const custom = model('custom', null);
    const view = render(<LiveModeSwitch model={custom.value} />);
    fireEvent.click(screen.getByRole('radio', { name: '歌' }));
    expect(custom.select).toHaveBeenCalledWith('singing');
    const settled = model('settled', 'singing');
    view.rerender(<LiveModeSwitch model={settled.value} />);
    expect(screen.getByRole('radio', { name: '歌' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '雑談' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('radio', { name: '雑談' }));
    expect(settled.select).toHaveBeenCalledWith('talk');
});

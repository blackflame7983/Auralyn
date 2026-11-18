import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomePanels } from '../HomePanels';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

vi.mock('../../LevelMeter/MeterContext', () => ({ useInputMeterState: () => 'live' }));
afterEach(cleanup);

const fixture = (): PreparationModel => ({ context: { ...context, usage: 'obs' }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn().mockResolvedValue(undefined), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });

const renderPanels = (model: PreparationModel, locale: 'ja' | 'en') => render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
    <HomePanels model={model} audioReady pinnedOpen onOpenSettings={vi.fn()} onListen={vi.fn()} onOpenOBSSettings={vi.fn()} />
</LocaleProvider>);

// 受け側への到達は Auralyn からは分からない。未確認の間は「確認が要る」と読ませず、中立の案内にする。
it.each(['ja', 'en'] as const)('受け側が未確認の間は注意色にせず、受け側のメーターで確かめる中立の案内を出す（%s）', locale => {
    renderPanels(fixture(), locale);
    const flow = screen.getByRole('region', { name: message(locale, 'flow.diagram') });
    const hint = within(flow).getByText(message(locale, 'flow.receiverCheckHint'));
    expect(hint).toHaveClass('text-muted-foreground');
    expect(hint).not.toHaveClass('text-warning');
    expect(within(flow).queryByText(message(locale, 'flow.receiverUnknown'))).not.toBeInTheDocument();
    expect(flow.querySelector('.text-warning')).toBeNull();
});

it.each(['ja', 'en'] as const)('受け側の確認が失効したときだけ注意色で確認を求める（%s）', locale => {
    const model = fixture();
    model.records.receiver = { at: 1, target: 'OBS', key: 'old', expired: true };
    renderPanels(model, locale);
    const flow = screen.getByRole('region', { name: message(locale, 'flow.diagram') });
    const warning = within(flow).getByText(message(locale, 'flow.receiverUnknown'));
    expect(warning).toHaveClass('text-warning');
    expect(within(flow).queryByText(message(locale, 'flow.receiverCheckHint'))).not.toBeInTheDocument();
});

it('受け側を確認済みなら、案内も注意も出さない', () => {
    const model = fixture();
    model.records.receiver = { at: 1, target: 'OBS', key: model.observation.keys?.receiver ?? '', expired: false };
    renderPanels(model, 'ja');
    const flow = screen.getByRole('region', { name: message('ja', 'flow.diagram') });
    expect(within(flow).queryByText(message('ja', 'flow.receiverCheckHint'))).not.toBeInTheDocument();
    expect(within(flow).queryByText(message('ja', 'flow.receiverUnknown'))).not.toBeInTheDocument();
});

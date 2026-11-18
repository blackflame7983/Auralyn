import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomePanels } from '../HomePanels';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { saveDisplayPurpose } from '@/hooks/useDisplayPurpose';

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

const destinationLabels = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other' } as const;

it.each(['ja', 'en'] as const)('図の送り先は、上の帯と同じ形で受け側の名前を添える（%s、#763）', locale => {
    for (const usage of ['obs', 'discord', 'other'] as const) {
        const model = fixture();
        model.context = { ...model.context, usage, receiver: 'My OBS' };
        const { unmount } = renderPanels(model, locale);
        const flow = screen.getByRole('region', { name: message(locale, 'flow.diagram') });
        expect(within(flow).getByText(`${message(locale, destinationLabels[usage])} · My OBS`)).toBeInTheDocument();
        unmount();
    }
});

it('受け側の名前が無いときと、自分の声を聴くときは、名前を添えない（#763）', () => {
    const none = fixture();
    none.context = { ...none.context, receiver: '' };
    const { unmount } = renderPanels(none, 'ja');
    expect(within(screen.getByRole('region', { name: message('ja', 'flow.diagram') })).getByText(message('ja', 'prep.obs'), { exact: true })).toBeInTheDocument();
    unmount();
    const listening = fixture();
    listening.context = { ...listening.context, usage: 'listening', receiver: 'My OBS' };
    renderPanels(listening, 'ja');
    const flow = screen.getByRole('region', { name: message('ja', 'flow.diagram') });
    expect(within(flow).getByText(message('ja', 'prep.local'), { exact: true })).toBeInTheDocument();
    expect(flow).not.toHaveTextContent('My OBS');
});

// ミュートの解除の入口は右の列の札だけ。接続の確認は、誤った主ボタンも、同じ入口の重ねも出さない（#766）。
it.each(['ja', 'en'] as const)('ミュート中の接続の確認は、主ボタンも確認ボタンも出さず、入出力の変更だけを残す（%s、#766）', locale => {
    const model = fixture();
    model.observation = { ...model.observation, availability: 'muted' };
    renderPanels(model, locale);
    const check = screen.getByRole('region', { name: message(locale, 'prep.title') });
    expect(within(check).queryByRole('button', { name: (locale === 'ja' ? 'ミュート・出力音量を確認' : 'Check mute and output level') })).not.toBeInTheDocument();
    expect(within(check).queryByRole('button', { name: message(locale, 'shell.configure') })).not.toBeInTheDocument();
    expect(check.querySelector('button.bg-primary')).toBeNull();
    expect(within(check).getByRole('button', { name: message(locale, 'home.changeDevices') })).toBeVisible();
    expect(check).not.toHaveTextContent(message(locale, 'prep.muted'));
});

it.each(['ja', 'en'] as const)('音楽鑑賞の図の終点は、ヘッドホンで聴く人に合う「聴く機器」の言葉で示す（%s、#767）', locale => {
    saveDisplayPurpose('music');
    try {
        renderPanels(fixture(), locale);
        const flow = screen.getByRole('region', { name: message(locale, 'flow.diagram') });
        expect(within(flow).getByText(message(locale, 'flow.musicReceiver'))).toBeInTheDocument();
        expect(within(flow).queryByText(message(locale, 'prep.localReceiver'))).not.toBeInTheDocument();
        expect(within(flow).queryByText(message(locale, 'live.destination'))).not.toBeInTheDocument();
    } finally { saveDisplayPurpose('voice'); }
});

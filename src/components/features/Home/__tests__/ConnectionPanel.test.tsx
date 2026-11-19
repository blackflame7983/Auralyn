import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomePanels } from '../HomePanels';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation, type Availability, type PreparationUse } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message, type MessageKey } from '@/i18n/messages';
import { saveDisplayPurpose } from '@/hooks/useDisplayPurpose';

// 接続の確認の開いた中は、いまの経路を読むことと本番中に使う入口だけにする。
// 手順の確認と低頻度の操作は、閉じた「詳しい状態と履歴」へ置く。

vi.mock('../../LevelMeter/MeterContext', () => ({ useInputMeterState: () => 'live' }));
afterEach(() => { cleanup(); saveDisplayPurpose('voice'); });

type Locale = 'ja' | 'en';
const fixture = (usage: PreparationUse | '' = 'obs', output = 'CABLE Input'): PreparationModel => {
    const ctx = { ...context, usage, receiver: '' };
    const state = { ...audioState, config: audioState.config && { ...audioState.config, output } };
    return { context: ctx, observation: buildPreparationObservation(state, runtime(), liveStatus, ctx), records: {}, checking: false, confirming: false,
        confirm: vi.fn().mockResolvedValue(undefined), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() };
};
const withAvailability = (model: PreparationModel, availability: Availability) => { model.observation = { ...model.observation, availability }; return model; };

interface Extra { audioReady?: boolean; stoppedInStrip?: boolean; homeActionInStrip?: boolean; destinationRequest?: number; onSetup?: () => void; onOpenSettings?: () => void }
const tree = (model: PreparationModel, locale: Locale, extra: Extra = {}) => <LocaleProvider store={createLocaleStore(() => locale, () => true)}>
    <HomePanels model={model} host="WASAPI" sampleRate={48000} audioReady={extra.audioReady ?? true} pinnedOpen stoppedInStrip={extra.stoppedInStrip} homeActionInStrip={extra.homeActionInStrip}
        destinationRequest={extra.destinationRequest} onSetup={extra.onSetup ?? vi.fn()} onOpenSettings={extra.onOpenSettings ?? vi.fn()} onListen={vi.fn()} onOpenOBSSettings={vi.fn()} />
</LocaleProvider>;
const renderPanels = (model: PreparationModel, locale: Locale, extra: Extra = {}) => render(tree(model, locale, extra));
const m = (locale: Locale, key: MessageKey, args?: Record<string, string | number>) => message(locale, key, args);
const panel = (locale: Locale) => screen.getByRole('region', { name: m(locale, 'prep.title') });
const historySummary = (locale: Locale) => within(panel(locale)).getByText(m(locale, 'prep.details'));
const openHistory = (locale: Locale) => { fireEvent.click(historySummary(locale)); const details = historySummary(locale).closest('details'); if (details && !details.open) details.open = true; };
const visibleButtons = (locale: Locale) => within(panel(locale)).queryAllByRole('button', { hidden: true }).filter(button => button.checkVisibility?.() !== false && !button.closest('details:not([open])'));
const buttonName = (button: HTMLElement) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';

it.each(['ja', 'en'] as const)('同じ名前のボタンを2つ出さず、確認のチェックボックスと次の手順の札は閉じた欄を開くまで見えない（%s）', locale => {
    for (const purpose of ['voice', 'music'] as const) {
        saveDisplayPurpose(purpose);
        const { unmount } = renderPanels(fixture('obs'), locale);
        const names = visibleButtons(locale).map(buttonName);
        expect(names.length).toBeGreaterThan(0);
        expect(new Set(names).size, `${purpose} の重複: ${names.join(' / ')}`).toBe(names.length);
        for (const hidden of [m(locale, 'shell.sound'), m(locale, 'wizard.musicSound'), m(locale, 'header.setupOpen'), m(locale, 'music.listenTitle')]) {
            expect(names, `${purpose}: ${hidden}`).not.toContain(hidden);
        }
        const checkbox = within(panel(locale)).queryByRole('checkbox', { hidden: true });
        if (checkbox) expect(checkbox).not.toBeVisible();
        unmount();
    }
});

it.each(['ja', 'en'] as const)('「詳しい状態と履歴」を開くと、確認のチェックボックスが目的の文の左に並び、次の手順の札とセットアップを開くがある（%s）', locale => {
    const onSetup = vi.fn();
    const model = fixture('obs');
    renderPanels(model, locale, { onSetup });
    openHistory(locale);
    const check = within(panel(locale));
    const checkbox = check.getByRole('checkbox', { name: m(locale, 'prep.ackSound') });
    expect(checkbox).toBeVisible();
    expect(checkbox).toHaveAccessibleDescription(m(locale, 'prep.ackPurpose'));
    const purpose = check.getByText(m(locale, 'prep.ackPurpose'));
    expect(checkbox.compareDocumentPosition(purpose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checkbox.closest('label, [data-ack-row]')).toBe(purpose.closest('label, [data-ack-row]'));
    fireEvent.click(checkbox);
    expect(model.confirm).toHaveBeenCalledWith('sound');
    fireEvent.click(check.getByRole('button', { name: m(locale, 'shell.sound') }));
    fireEvent.click(check.getByRole('button', { name: m(locale, 'header.setupOpen') }));
    expect(onSetup).toHaveBeenCalledOnce();
});

it.each(['ja', 'en'] as const)('音楽鑑賞の「音が届いているか確かめる」は接続の確認に置かず、「WASAPI · 48 kHz」は閉じた欄の中にある（%s）', locale => {
    saveDisplayPurpose('music');
    const model = fixture('obs');
    renderPanels(model, locale);
    expect(within(panel(locale)).queryByRole('button', { name: m(locale, 'music.listenTitle'), hidden: true })).not.toBeInTheDocument();
    const values = within(panel(locale)).getByText(/WASAPI/, { exact: false });
    expect(values).not.toBeVisible();
    expect(values.closest('details')).not.toBeNull();
    openHistory(locale);
    expect(values).toBeVisible();
});

const availabilities: Array<{ availability: Availability; stoppedInStrip?: boolean }> = [
    { availability: 'ready' }, { availability: 'muted' }, { availability: 'unconfigured' }, { availability: 'stopped' }, { availability: 'stopped', stoppedInStrip: true },
    { availability: 'failed' }, { availability: 'unknown' }, { availability: 'pending' },
];
it.each(['ja', 'en'] as const)('「入出力を変更」は状態によらず1つで、図のすぐ下の同じ位置にある（%s）', locale => {
    for (const purpose of ['voice', 'music'] as const) for (const usage of ['obs', ''] as const) {
        saveDisplayPurpose(purpose);
        for (const { availability, stoppedInStrip } of availabilities) {
            const model = withAvailability(fixture(usage), availability);
            const { unmount } = renderPanels(model, locale, { stoppedInStrip, audioReady: availability === 'ready' || availability === 'muted', homeActionInStrip: stoppedInStrip });
            const buttons = within(panel(locale)).getAllByRole('button', { name: m(locale, 'home.changeDevices'), hidden: true });
            expect(buttons, `${purpose}/${usage}/${availability}`).toHaveLength(1);
            const row = buttons[0]?.closest('[data-connection-actions]');
            expect(row, `${purpose}/${usage}/${availability}: 操作の行`).not.toBeNull();
            expect(within(row?.previousElementSibling as HTMLElement).getByRole('region', { name: m(locale, 'flow.diagram') })).toBeInTheDocument();
            unmount();
        }
    }
});

it.each(['ja', 'en'] as const)('準備に問題があるときだけ、直す操作が見える（%s）', locale => {
    const cases: Array<{ availability: Availability; stoppedInStrip?: boolean; fix: MessageKey | null }> = [
        { availability: 'unconfigured', fix: 'shell.configure' }, { availability: 'stopped', fix: 'shell.configure' }, { availability: 'failed', fix: 'shell.configure' },
        { availability: 'unknown', fix: 'prep.refresh' },
        { availability: 'ready', fix: null }, { availability: 'muted', fix: null }, { availability: 'stopped', stoppedInStrip: true, fix: null },
    ];
    for (const { availability, stoppedInStrip, fix } of cases) {
        const onOpenSettings = vi.fn();
        const model = withAvailability(fixture('obs'), availability);
        const { unmount } = renderPanels(model, locale, { stoppedInStrip, audioReady: false, onOpenSettings });
        for (const name of [m(locale, 'shell.configure'), m(locale, 'prep.refresh')]) {
            const found = within(panel(locale)).queryAllByRole('button', { name });
            expect(found, `${availability}${stoppedInStrip ? '(帯)' : ''}: ${name}`).toHaveLength(fix !== null && name === m(locale, fix) ? 1 : 0);
            if (found[0]) expect(found[0]).toBeVisible();
        }
        unmount();
    }
});

it('問題のときの直す操作は、状態に合う操作を実行する', () => {
    const onOpenSettings = vi.fn();
    const failed = withAvailability(fixture('obs'), 'failed');
    const view = renderPanels(failed, 'ja', { onOpenSettings });
    fireEvent.click(within(panel('ja')).getByRole('button', { name: m('ja', 'shell.configure') }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    view.unmount();
    const unknown = withAvailability(fixture('obs'), 'unknown');
    renderPanels(unknown, 'ja', { onOpenSettings });
    fireEvent.click(within(panel('ja')).getByRole('button', { name: m('ja', 'prep.refresh') }));
    expect(unknown.refresh).toHaveBeenCalledOnce();
});

it.each(['ja', 'en'] as const)('送り先の「変更」で小さなメニューが開き、4つから選べて、経路が変わらない旨の1行が出る（%s）', async locale => {
    const model = fixture('obs');
    renderPanels(model, locale);
    expect(within(panel(locale)).queryByRole('radiogroup')).not.toBeInTheDocument();
    const diagram = within(panel(locale)).getByRole('region', { name: m(locale, 'flow.diagram') });
    const change = within(diagram).getByRole('button', { name: m(locale, 'prep.changeDestinationLabel') });
    expect(change).toHaveTextContent(m(locale, 'prep.changeDestination'));
    change.focus();
    fireEvent.keyDown(change, { key: 'ArrowDown' });
    const items = await screen.findAllByRole('menuitemradio');
    expect(items).toHaveLength(4);
    expect(screen.getByText(m(locale, 'prep.destinationNote'))).toBeVisible();
    expect(items.find(item => item.getAttribute('aria-checked') === 'true')).toHaveTextContent(m(locale, 'prep.obs'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: m(locale, 'prep.call') }));
    expect(model.changeContext).toHaveBeenCalledWith({ usage: 'discord', receiver: '' });
});

it('いまの送り先を選び直しても、受け側の名前を消さない', async () => {
    const model = fixture('obs');
    renderPanels(model, 'ja');
    const change = screen.getByRole('button', { name: m('ja', 'prep.changeDestinationLabel') });
    change.focus();
    fireEvent.keyDown(change, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: m('ja', 'prep.obs') }));
    expect(model.changeContext).not.toHaveBeenCalled();
});

it('音楽鑑賞には送り先の変更を出さない', () => {
    saveDisplayPurpose('music');
    renderPanels(fixture('obs'), 'ja');
    expect(within(panel('ja')).queryByRole('button', { name: m('ja', 'prep.changeDestinationLabel') })).not.toBeInTheDocument();
    expect(within(panel('ja')).queryByRole('radiogroup')).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('送り先が未選択のときは、4択をパネルの中にそのまま開いて出し、変更のボタンは出さない（%s）', locale => {
    const model = fixture('');
    renderPanels(model, locale);
    const group = within(panel(locale)).getByRole('radiogroup', { name: m(locale, 'prep.destinationPrompt') });
    expect(group.closest('details')).toBeNull();
    expect(group).toBeVisible();
    expect(within(group).getAllByRole('radio').map(radio => radio.getAttribute('value'))).toEqual(['obs', 'discord', 'listening', 'other']);
    expect(within(panel(locale)).queryByRole('button', { name: m(locale, 'prep.changeDestinationLabel') })).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: m(locale, 'prep.call') }));
    expect(model.changeContext).toHaveBeenCalledWith({ usage: 'discord', receiver: '' });
});

it('「送り先を選ぶ」の要求で、開いた4択のラジオへフォーカスが移り、選んだあとは「変更」へ戻る', () => {
    const model = fixture('');
    const view = renderPanels(model, 'ja', { destinationRequest: 0 });
    view.rerender(tree(model, 'ja', { destinationRequest: 1 }));
    const group = within(panel('ja')).getByRole('radiogroup', { name: m('ja', 'prep.destinationPrompt') });
    expect(within(group).getAllByRole('radio')[0]).toHaveFocus();
    const call = within(group).getByRole('radio', { name: m('ja', 'prep.call') });
    fireEvent.click(call);
    model.context = { ...model.context, usage: 'discord' };
    view.rerender(tree(model, 'ja', { destinationRequest: 1 }));
    expect(screen.getByRole('button', { name: m('ja', 'prep.changeDestinationLabel') })).toHaveFocus();
});

it.each(['ja', 'en'] as const)('出力先が対の名前の分かる VB-CABLE で、送り先が OBS・通話・その他のときだけ、受け側で選ぶ名前を1行出す（%s）', locale => {
    const hint = m(locale, 'settings.connection.receiverHint', { name: 'CABLE Output' });
    for (const usage of ['obs', 'discord', 'other'] as const) {
        const { unmount } = renderPanels(fixture(usage, 'CABLE Input'), locale);
        expect(within(panel(locale)).getByText(hint), usage).toBeVisible();
        unmount();
    }
    for (const [usage, output] of [['listening', 'CABLE Input'], ['obs', 'スピーカー'], ['obs', 'CABLE-A Input (VB-Audio Cable A)'], ['', 'CABLE Input']] as const) {
        const { unmount } = renderPanels(fixture(usage, output), locale);
        if (output.startsWith('CABLE-A')) expect(within(panel(locale)).getByText(m(locale, 'settings.connection.receiverHint', { name: 'CABLE-A Output' }))).toBeVisible();
        else expect(within(panel(locale)).queryByText(/CABLE Output/), `${usage}/${output}`).not.toBeInTheDocument();
        unmount();
    }
    saveDisplayPurpose('music');
    renderPanels(fixture('obs', 'CABLE Input'), locale);
    expect(within(panel(locale)).queryByText(hint)).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('「受け側のメーターで確かめてください」は音声が動いているときだけ出す（%s）', locale => {
    const running = renderPanels(fixture('obs'), locale, { audioReady: true });
    expect(within(panel(locale)).getByText(m(locale, 'flow.receiverCheckHint'))).toBeVisible();
    running.unmount();
    renderPanels(withAvailability(fixture('obs'), 'stopped'), locale, { audioReady: false, stoppedInStrip: true });
    expect(within(panel(locale)).queryByText(m(locale, 'flow.receiverCheckHint'))).not.toBeInTheDocument();
});

it('受け側の確認が失効した注意は、停止中も残す', () => {
    const model = withAvailability(fixture('obs'), 'stopped');
    model.records.receiver = { at: 1, target: 'OBS', key: 'old', expired: true };
    renderPanels(model, 'ja', { audioReady: false, stoppedInStrip: true });
    expect(within(panel('ja')).getByText(m('ja', 'flow.receiverUnknown'))).toBeVisible();
});

it('入出力の変更を押すと設定を開く', () => {
    const onOpenSettings = vi.fn();
    renderPanels(fixture('obs'), 'ja', { onOpenSettings });
    fireEvent.click(within(panel('ja')).getByRole('button', { name: m('ja', 'home.changeDevices') }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
});

it('畳める窓でも、「送り先を選ぶ」の要求で接続の詳細が開き、4択のラジオへフォーカスが移る', () => {
    const model = fixture('');
    const props = { model, host: 'WASAPI', sampleRate: 48000, audioReady: true, onOpenSettings: vi.fn(), onListen: vi.fn(), onOpenOBSSettings: vi.fn() } as const;
    const view = render(<LocaleProvider store={createLocaleStore(() => 'ja', () => true)}><HomePanels {...props} homeActionInStrip /></LocaleProvider>);
    const toggle = screen.getByRole('button', { name: m('ja', 'prep.steps') });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    view.rerender(<LocaleProvider store={createLocaleStore(() => 'ja', () => true)}><HomePanels {...props} homeActionInStrip destinationRequest={1} /></LocaleProvider>);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radio', { name: m('ja', 'prep.obs') })).toHaveFocus();
});

it('送り先が未選択のあいだは、確かめる相手がいないので「受け側のメーターで確かめてください」を出さない', () => {
    renderPanels(fixture(''), 'ja', { audioReady: true });
    expect(within(panel('ja')).queryByText(m('ja', 'flow.receiverCheckHint'))).not.toBeInTheDocument();
});

// 未選択の4択は、矢印キーでは焦点が動くだけで、クリックか Enter・Space で決める。メニューの操作とそろえる。
it('未選択の4択は、矢印キーでは確定せず、Enter とクリックで確定する', () => {
    const model = fixture('');
    renderPanels(model, 'ja');
    const group = within(panel('ja')).getByRole('radiogroup', { name: m('ja', 'prep.destinationPrompt') });
    const [first, second] = within(group).getAllByRole('radio');
    if (!first || !second) throw new Error('4択がありません');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    fireEvent.click(second);
    expect(model.changeContext).not.toHaveBeenCalled();
    expect(group).toBeVisible();
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(model.changeContext).toHaveBeenCalledOnce();
    expect(model.changeContext).toHaveBeenCalledWith({ usage: 'discord', receiver: '' });
});

it('未選択の4択は、Space でも確定する', () => {
    const model = fixture('');
    renderPanels(model, 'ja');
    const radio = within(panel('ja')).getByRole('radio', { name: m('ja', 'prep.other') });
    radio.focus();
    fireEvent.keyDown(radio, { key: ' ' });
    expect(model.changeContext).toHaveBeenCalledWith({ usage: 'other', receiver: '' });
});

// 音楽鑑賞の直す操作は、マイクと出力先ではなく、再生元と聴く機器の言葉にする。
it.each(['ja', 'en'] as const)('音楽鑑賞の直す操作は、再生元と聴く機器の言葉で出す（%s）', locale => {
    saveDisplayPurpose('music');
    for (const availability of ['unconfigured', 'failed', 'stopped'] as const) {
        const { unmount } = renderPanels(withAvailability(fixture('obs'), availability), locale, { audioReady: false });
        expect(within(panel(locale)).getByRole('button', { name: m(locale, 'music.configure') }), availability).toBeVisible();
        expect(within(panel(locale)).queryByRole('button', { name: m(locale, 'shell.configure') })).not.toBeInTheDocument();
        unmount();
    }
    const unknown = renderPanels(withAvailability(fixture('obs'), 'unknown'), locale, { audioReady: false });
    expect(within(panel(locale)).getByRole('button', { name: m(locale, 'prep.refresh') })).toBeVisible();
    unknown.unmount();
});

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PreparationPanel } from '../PreparationPanel';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

afterEach(cleanup);
const fixture = (): PreparationModel => ({ context: { ...context }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn().mockResolvedValue(undefined), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });
const callbacks = () => ({ onSettings: vi.fn(), onSound: vi.fn(), onListen: vi.fn(), onObs: vi.fn(), onCall: vi.fn(), onTroubleshoot: vi.fn(), audioReady: true });
const expand = (locale: 'ja' | 'en' = 'ja') => fireEvent.click(screen.getByRole('button', { name: message(locale, 'prep.steps') }));
const checked = (model: PreparationModel, stage: 'sound' | 'listen') => { model.records[stage] = { at: 1, target: 'Mic', key: model.observation.keys![stage], expired: false }; };

it.each(['ja', 'en'] as const)('会場の再生注意は閉じた条件パネルの外にあり、次の操作・明示確認を分ける (%s)', locale => {
    const model = fixture(); model.context.location = 'venue'; model.context.signal = 'mixed';
    const props = callbacks();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><PreparationPanel model={model} {...props} /></LocaleProvider>);
    expand(locale);
    const warning = screen.getByText(message(locale, 'prep.venueWarning'));
    expect(warning.closest('details')).toBeNull();
    expect(screen.getByText(message(locale, 'prep.mixedWarning')).closest('details')).toBeNull();
    const action = screen.getByRole('button', { name: message(locale, 'shell.sound') });
    fireEvent.click(action); expect(props.onSound).toHaveBeenCalledOnce();
    expect(model.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: message(locale, 'prep.ackSound') }));
    expect(model.confirm).toHaveBeenCalledWith('sound');
});
it('対象入力がなければ受け側確認を記録できず、推奨操作で条件を開き入力へフォーカスする', () => {
    const model = fixture(); checked(model, 'sound'); checked(model, 'listen'); model.context.receiver = '';
    render(<PreparationPanel model={model} {...callbacks()} />);
    expand();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'prep.targetAction') }));
    expect(screen.getByRole('textbox', { name: message('ja', 'prep.target') })).toHaveFocus();
});
it('未対応のOBS検査は成功扱いせず、手動の実マイク確認と区別する', () => {
    const model = fixture(); model.context.usage = 'obs'; model.observation.obs = { reached: 'unsupported' };
    render(<PreparationPanel model={model} {...callbacks()} />);
    expand();
    fireEvent.click(screen.getByText(message('ja', 'prep.details')));
    expect(screen.getByText(new RegExp(message('ja', 'prep.unsupported')))).toBeInTheDocument();
    expect(screen.queryByText(message('ja', 'prep.userConfirmed'))).not.toBeInTheDocument();
});
it('通話ではOBS操作を出さず、ローカル試聴の記録を配信到達と呼ばない', () => {
    const model = fixture(); checked(model, 'sound'); checked(model, 'listen'); const props = callbacks();
    const view = render(<PreparationPanel model={model} {...props} />);
    expand();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'prep.checkReceiver') }));
    expect(props.onCall).toHaveBeenCalledOnce(); expect(props.onObs).not.toHaveBeenCalled();
    act(() => { model.context.usage = 'listening'; });
    view.rerender(<PreparationPanel model={model} {...props} />);
    expect(screen.getByRole('checkbox', { name: message('ja', 'prep.ackLocal') })).toBeEnabled();
    expect(within(screen.getByRole('region')).queryByRole('textbox')).not.toBeInTheDocument();
});
it('用途は条件パネルの外の1か所で選び、選んだ後も同じ欄にフォーカスを残す', () => {
    const model = fixture(); model.context.usage = '';
    const view = render(<PreparationPanel model={model} {...callbacks()} />);
    const select = screen.getByRole('combobox', { name: message('ja', 'prep.usage') });
    expect(select.closest('details')).toBeNull();
    expect(screen.getAllByRole('combobox', { name: message('ja', 'prep.usage') })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: message('ja', 'prep.chooseUse') })).not.toBeInTheDocument();
    expect(view.container.querySelector('details')).not.toHaveAttribute('open');
    select.focus();
    fireEvent.change(select, { target: { value: 'discord' } });
    expect(model.changeContext).toHaveBeenCalledWith({ usage: 'discord', receiver: '' });
    model.context.usage = 'discord';
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    expect(screen.getByRole('combobox', { name: message('ja', 'prep.usage') })).toBe(select);
    expect(select).toHaveFocus();
});
it('正常時は手順を畳んで状態と警告だけを残し、問題が起きたら開き直す', () => {
    const model = fixture(); model.context.location = 'venue';
    const view = render(<PreparationPanel model={model} {...callbacks()} signalSummary={<p>summary</p>} />);
    const toggle = screen.getByRole('button', { name: message('ja', 'prep.steps') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('summary')).toBeInTheDocument();
    expect(screen.getByText(message('ja', 'prep.venueWarning'))).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox', { name: message('ja', 'prep.usage') })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    model.observation = { ...model.observation, availability: 'failed' };
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: message('ja', 'shell.configure') })).toBeInTheDocument();
});
it.each(['unconfigured', 'stopped', 'unknown'] as const)('%sでは最初から手順を開く', availability => {
    const model = fixture(); model.observation = { ...model.observation, availability };
    render(<PreparationPanel model={model} {...callbacks()} />);
    expect(screen.getByRole('button', { name: message('ja', 'prep.steps') })).toHaveAttribute('aria-expanded', 'true');
});
it('ミュート・音量ゼロでは手順を開き、直す入口を見せる', () => {
    const model = fixture(); model.observation = { ...model.observation, availability: 'muted' };
    render(<PreparationPanel model={model} {...callbacks()} />);
    expect(screen.getByRole('button', { name: message('ja', 'prep.steps') })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: message('ja', 'shell.configure') })).toBeInTheDocument();
});
it('起動時の状態不明から正常になったら、操作していなければ畳む', () => {
    const model = fixture(); model.observation = { ...model.observation, availability: 'unknown' };
    const view = render(<PreparationPanel model={model} {...callbacks()} />);
    const toggle = screen.getByRole('button', { name: message('ja', 'prep.steps') });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    model.observation = { ...model.observation, availability: 'ready' };
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
it('手順内を操作した後は、状態不明を経て正常に戻っても開いたままでフォーカスを保つ', () => {
    const model = fixture(); const ready = model.observation;
    model.observation = { ...ready, availability: 'unknown' };
    const view = render(<PreparationPanel model={model} {...callbacks()} />);
    const refresh = screen.getByRole('button', { name: message('ja', 'prep.refresh') });
    refresh.focus();
    fireEvent.click(refresh);
    expect(model.refresh).toHaveBeenCalledOnce();
    model.observation = ready;
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    const toggle = screen.getByRole('button', { name: message('ja', 'prep.steps') });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const select = screen.getByRole('combobox', { name: message('ja', 'prep.usage') });
    select.focus();
    model.observation = { ...ready, availability: 'unknown' };
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    model.observation = ready;
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(select).toHaveFocus();
});
it('問題中に閉じても、別の問題へ変わったら開き直す', () => {
    const model = fixture(); model.observation = { ...model.observation, availability: 'unknown' };
    const view = render(<PreparationPanel model={model} {...callbacks()} />);
    const toggle = screen.getByRole('button', { name: message('ja', 'prep.steps') });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    model.observation = { ...model.observation, availability: 'failed' };
    view.rerender(<PreparationPanel model={model} {...callbacks()} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
});it('ミュート中に閉じた手順は、反映待ちを挟んで同じミュートに戻っても閉じたまま', () => {
    const model = fixture(); const ready = model.observation;
    model.observation = { ...ready, availability: 'muted' };
    const view = render(<PreparationPanel model={model} {...callbacks()} />);
    const toggle = screen.getByRole('button', { name: message('ja', 'prep.steps') });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const availability of ['pending', 'muted'] as const) {
        model.observation = { ...ready, availability };
        view.rerender(<PreparationPanel model={model} {...callbacks()} />);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
});
it('ミュートで開いている手順は、反映待ちの間も閉じない', () => {
    const model = fixture(); const ready = model.observation;
    model.observation = { ...ready, availability: 'muted' };
    const view = render(<PreparationPanel model={model} {...callbacks()} />);
    const toggle = screen.getByRole('button', { name: message('ja', 'prep.steps') });
    for (const availability of ['pending', 'muted'] as const) {
        model.observation = { ...ready, availability };
        view.rerender(<PreparationPanel model={model} {...callbacks()} />);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
});
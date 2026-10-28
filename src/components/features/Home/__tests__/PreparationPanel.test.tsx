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
const checked = (model: PreparationModel, stage: 'sound' | 'listen') => { model.records[stage] = { at: 1, target: 'Mic', key: model.observation.keys![stage], expired: false }; };

it.each(['ja', 'en'] as const)('会場の再生注意は閉じた条件パネルの外にあり、次の操作・明示確認を分ける (%s)', locale => {
    const model = fixture(); model.context.location = 'venue'; model.context.signal = 'mixed';
    const props = callbacks();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><PreparationPanel model={model} {...props} /></LocaleProvider>);
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
    expect(screen.getByRole('checkbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'prep.targetAction') }));
    expect(screen.getByRole('textbox', { name: message('ja', 'prep.target') })).toHaveFocus();
});
it('未対応のOBS検査は成功扱いせず、手動の実マイク確認と区別する', () => {
    const model = fixture(); model.context.usage = 'obs'; model.observation.obs = { reached: 'unsupported' };
    render(<PreparationPanel model={model} {...callbacks()} />);
    fireEvent.click(screen.getByText(message('ja', 'prep.details')));
    expect(screen.getByText(new RegExp(message('ja', 'prep.unsupported')))).toBeInTheDocument();
    expect(screen.queryByText(message('ja', 'prep.userConfirmed'))).not.toBeInTheDocument();
});
it('通話ではOBS操作を出さず、ローカル試聴の記録を配信到達と呼ばない', () => {
    const model = fixture(); checked(model, 'sound'); checked(model, 'listen'); const props = callbacks();
    const view = render(<PreparationPanel model={model} {...props} />);
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

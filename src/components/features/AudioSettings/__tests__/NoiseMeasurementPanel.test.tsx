import { listen } from '@tauri-apps/api/event';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noiseMeasurementApi, type NoiseMeasurementSnapshot } from '@/api/noiseMeasurement';
import { NoiseMeasurementPanel } from '../NoiseMeasurementPanel';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

import { noiseMeasurementFixture as fixture } from '@/__tests__/fixtures/noiseMeasurement';
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const settle = () => act(async () => {});

it.each(['ja', 'en'] as const)('測定完了だけでは採用せず、無言確認と明示採用を必要とする (%s)', async locale => {
    let value = fixture();
    const request = vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(async req => {
        if (req.action === 'start') value = fixture('capturing', '1');
        if (req.action === 'approve') value = fixture('approved', '1');
        return value;
    });
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><NoiseMeasurementPanel /></LocaleProvider>);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'settings.AudioSettingsModal.121') })); await settle();
    expect(request).toHaveBeenCalledWith({ action: 'start', epoch: 'measurement-engine', generation: '0' });
    value = fixture('review', '1');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const use = screen.getByRole('button', { name: message(locale, 'measurement.use') });
    expect(use).toBeDisabled();
    expect(request.mock.calls.some(([r]) => r.action === 'approve')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: message(locale, 'measurement.quiet') }));
    fireEvent.click(use); await settle();
    expect(request).toHaveBeenCalledWith({ action: 'approve', epoch: 'measurement-engine', generation: '1', acknowledgedQuiet: true });
    expect(screen.getByText(message(locale, 'measurement.approved'))).toBeInTheDocument();
});

it('無入力・clip等の不正測定を採用できず、取得失敗で以前の成功を残さない', async () => {
    let value = { ...fixture('invalid', '2'), quality: ['silent', 'clipped'] };
    const request = vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(async () => value);
    render(<NoiseMeasurementPanel />); await settle();
    expect(screen.getByText(message('ja', 'measurement.silent'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message('ja', 'measurement.use') })).not.toBeInTheDocument();
    value = { ...fixture('approved', '3'), quality: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText(message('ja', 'measurement.approved'))).toBeInTheDocument();
    request.mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText(message('ja', 'measurement.error'))).toBeInTheDocument();
    expect(screen.queryByText(message('ja', 'measurement.approved'))).not.toBeInTheDocument();
});

it('画面を閉じた後に開始応答が戻ったら、その世代だけを取消する', async () => {
    let finish!: (value: NoiseMeasurementSnapshot) => void;
    const request = vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(req => req.action === 'start'
        ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(fixture()));
    const view = render(<NoiseMeasurementPanel />); await settle();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'settings.AudioSettingsModal.121') }));
    view.unmount();
    await act(async () => { finish(fixture('capturing', '42')); });
    expect(request).toHaveBeenCalledWith({ action: 'cancel', epoch: 'measurement-engine', generation: '42' });
    expect(vi.getTimerCount()).toBe(0);
});

it('別の測定世代への確認チェックを引き継がず、非表示化では所有する測定を取り消す', async () => {
    let value = fixture();
    const request = vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(async req => {
        if (req.action === 'start') value = fixture('capturing', '1');
        return value;
    });
    render(<NoiseMeasurementPanel />); await settle();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'settings.AudioSettingsModal.121') })); await settle();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange'))); await settle();
    expect(request).toHaveBeenCalledWith({ action: 'cancel', epoch: 'measurement-engine', generation: '1' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('自分の開始と採用がHost条件通知を発生しても、測定を自己取消せず最新状態を読み戻す', async () => {
    let value = fixture();
    const notify = () => { for (const [event, callback] of vi.mocked(listen).mock.calls) if (event === 'audio-conditions-changed') callback({ event, id: 1, payload: null }); };
    const request = vi.spyOn(noiseMeasurementApi, 'request').mockImplementation(async req => {
        if (req.action === 'start') { notify(); value = fixture('capturing', '1'); notify(); }
        if (req.action === 'approve') { notify(); value = fixture('approved', '1'); notify(); }
        return value;
    });
    render(<NoiseMeasurementPanel />); await settle();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'settings.AudioSettingsModal.121') })); await settle();
    expect(request.mock.calls.some(([r]) => r.action === 'cancel')).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'measurement.capturing'));
    value = fixture('review', '1'); await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(screen.getByRole('checkbox', { name: message('ja', 'measurement.quiet') }));
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'measurement.use') })); await settle();
    expect(screen.getByText(message('ja', 'measurement.approved'))).toBeInTheDocument();
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { peakProtectionApi, type PeakStatus } from '@/api/peakProtection';
import { PeakProtectionPanel } from '../PeakProtectionPanel';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
const fixture = (enabled = false): PeakStatus => ({ config: { enabled, ceilingDb: -3, releaseMs: 150 }, running: true, pending: false, revision: '2', reductionDb: 0, addedLatencySamples: 0 });
function summaryClass(root: HTMLElement, title: string) {
    const summary = [...root.querySelectorAll('summary')].find(item => item.textContent === title);
    expect(summary).toBeInstanceOf(HTMLElement);
    if (!(summary instanceof HTMLElement)) throw new Error(title);
    return summary.className;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('読取りでは有効化せず、保持値を編集へ読み込み、明示操作だけで適用する', async () => {
    const request = vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => ({ ...fixture(), config: config ?? fixture().config }));
    render(<PeakProtectionPanel />); await act(async () => {});
    expect(request).toHaveBeenCalledWith();
    expect(request.mock.calls.every(args => args.length === 0)).toBe(true);
    // 天井は詳しい設定へ移した。閉じた初期状態でも、読み込んだ値は残る。
    expect(screen.getByText(message('ja', 'peak.details')).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('spinbutton', { name: message('ja', 'peak.ceiling') })).toHaveValue(-3);
    // ON と OFF は見出し横のスイッチ1つ。ON はいまの値で適用する。
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'peak.title') })); await act(async () => {});
    expect(request).toHaveBeenCalledWith({ enabled: true, ceilingDb: -3, releaseMs: 150 });
    fireEvent.change(screen.getByRole('spinbutton', { name: message('ja', 'peak.ceiling') }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'peak.title') })); await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({ enabled: false, ceilingDb: -3, releaseMs: 150 });
});
it.each(['ja', 'en'] as const)('音楽鑑賞の音量の保護は配信の話をせず、配信の表示はこれまでの文のまま（%s）', async locale => {
    vi.spyOn(peakProtectionApi, 'request').mockResolvedValue(fixture());
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><PeakProtectionPanel /></LocaleProvider>);
    await act(async () => {});
    const voice = screen.getByRole('region', { name: message(locale, 'peak.title') });
    expect(voice).toHaveTextContent(message(locale, 'peak.lead'));
    expect(voice).toHaveTextContent(message(locale, 'peak.scope'));
    expect(voice).toHaveTextContent(message(locale, 'peak.limits'));
    expect(voice).toHaveTextContent(message(locale, 'peak.limitsTitle'));
    expect(summaryClass(voice, message(locale, 'peak.limitsTitle'))).toBe(summaryClass(voice, message(locale, 'peak.details')));
    if (locale === 'ja') expect(voice).toHaveTextContent('配信');
    await act(async () => { view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><PeakProtectionPanel music /></LocaleProvider>); });
    const music = screen.getByRole('region', { name: message(locale, 'peak.title') });
    expect(music).toHaveTextContent(message(locale, 'peak.leadMusic'));
    expect(music).toHaveTextContent(message(locale, 'peak.scopeMusic'));
    expect(music).toHaveTextContent(message(locale, 'peak.limitsMusic'));
    expect(music).toHaveTextContent(message(locale, 'peak.limitsTitle'));
    expect(summaryClass(music, message(locale, 'peak.limitsTitle'))).toBe(summaryClass(music, message(locale, 'peak.details')));
    expect(music).not.toHaveTextContent(message(locale, 'peak.lead'));
    expect(music).not.toHaveTextContent(message(locale, 'peak.scope'));
    expect(music).not.toHaveTextContent('配信');
    expect(music).not.toHaveTextContent('OBS');
    expect(music).not.toHaveTextContent('stream');
});
it('守る対象は開かずに読め、数値の詳細では詳しい設定が開き、適用はONにしない', async () => {
    const request = vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => ({ ...fixture(), config: config ?? fixture().config }));
    const view = render(<PeakProtectionPanel />); await act(async () => {});
    expect(screen.getByText(message('ja', 'peak.lead'))).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'peak.apply') })); await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({ enabled: false, ceilingDb: -3, releaseMs: 150 });
    await act(async () => { view.rerender(<PeakProtectionPanel numericDetails />); });
    expect(screen.getByText(message('ja', 'peak.details')).closest('details')).toHaveAttribute('open');
});
it('失敗や停止通知より古い適用応答で確認済みに戻さない', async () => {
    let resolve!: (value: PeakStatus) => void;
    vi.spyOn(peakProtectionApi, 'request').mockImplementation(config => config ? new Promise(done => { resolve = done; }) : Promise.resolve(fixture()));
    render(<PeakProtectionPanel />); await act(async () => {});
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'peak.title') }));
    act(() => { for (const [event, callback] of vi.mocked(listen).mock.calls) if (event === 'audio-error') callback({ event, id: 1, payload: 'failure' }); });
    await act(async () => resolve(fixture(true)));
    expect(screen.getByText(message('ja', 'peak.unknown'))).toBeInTheDocument();
    // 状態を確認できないときは、スイッチで ON にできない。
    expect(screen.getByRole('switch', { name: message('ja', 'peak.title') })).toBeDisabled();
});
it('本番保護の間はスイッチ・数値・適用を止めて理由を示し、解除すると書き込める', async () => {
    const request = vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => ({ ...fixture(), config: config ?? fixture().config }));
    const view = render(<PeakProtectionPanel locked />); await act(async () => {});
    const reason = screen.getByText(message('ja', 'peak.liveLocked'));
    const toggle = screen.getByRole('switch', { name: message('ja', 'peak.title') });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-describedby', reason.id);
    expect(screen.getByRole('spinbutton', { name: message('ja', 'peak.ceiling') })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: message('ja', 'peak.release') })).toBeDisabled();
    const apply = screen.getByRole('button', { name: message('ja', 'peak.apply') });
    expect(apply).toBeDisabled();
    // ON と OFF はスイッチだけが示す。稼働中で反映待ちでも停止でもないときは、状態の行を出さない（#589）。
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(apply);
    await act(async () => {});
    expect(request.mock.calls.every(args => args.length === 0)).toBe(true);
    await act(async () => { view.rerender(<PeakProtectionPanel locked={false} />); });
    expect(screen.queryByText(message('ja', 'peak.liveLocked'))).not.toBeInTheDocument();
    const unlocked = screen.getByRole('switch', { name: message('ja', 'peak.title') });
    expect(unlocked).toBeEnabled();
    expect(unlocked).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('spinbutton', { name: message('ja', 'peak.ceiling') })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: message('ja', 'peak.release') })).toBeEnabled();
    const applyAgain = screen.getByRole('button', { name: message('ja', 'peak.apply') });
    expect(applyAgain).toBeEnabled();
    fireEvent.click(unlocked); await act(async () => {});
    expect(request).toHaveBeenCalledWith({ enabled: true, ceilingDb: -3, releaseMs: 150 });
    fireEvent.click(applyAgain); await act(async () => {});
    expect(request.mock.calls.filter(args => args.length > 0)).toHaveLength(2);
});
it('ONとOFFの文字は出さず、数値と抑制量は数値の詳細のときだけ、状態の行は読めない・反映途中・停止のときだけ出す', async () => {
    const request = vi.spyOn(peakProtectionApi, 'request').mockResolvedValue(fixture(true));
    const view = render(<PeakProtectionPanel />); await act(async () => {});
    const region = screen.getByRole('region', { name: message('ja', 'peak.title') });
    // 守る対象の「既定はOFF」は残す。状態の行には ON も OFF も出さない。
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(region).not.toHaveTextContent('dBFS /');
    expect(region).not.toHaveTextContent(message('ja', 'peak.reduction', { db: '0.0' }));
    await act(async () => { view.rerender(<PeakProtectionPanel numericDetails />); });
    expect(screen.getByText('-3.0 dBFS / 150 ms')).toBeInTheDocument();
    expect(screen.getByText(message('ja', 'peak.reduction', { db: '0.0' }))).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    request.mockResolvedValue({ ...fixture(true), pending: true, running: false, reductionDb: 1.2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(`${message('ja', 'peak.pending')} · ${message('ja', 'peak.stopped')}`);
    expect(status).not.toHaveTextContent('ON');
    expect(status).not.toHaveTextContent('OFF');
    expect(screen.getByText(message('ja', 'peak.reduction', { db: '1.2' }))).toBeInTheDocument();
    request.mockRejectedValue(new Error('down'));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'peak.unknown'));
    expect(screen.queryByText(/dBFS \//)).not.toBeInTheDocument();
    expect(screen.queryByText(message('ja', 'peak.reduction', { db: '1.2' }))).not.toBeInTheDocument();
});

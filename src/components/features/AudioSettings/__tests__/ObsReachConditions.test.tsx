import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { ObsConnectionSettings } from '../ObsConnectionSettings';
import type { ObsAudioReachResult } from '@/api/obs';

vi.mock('../ObsSafeSetup', () => ({ ObsSafeSetup: () => null }));
vi.mock('../ObsModeRoutingSettings', () => ({ ObsModeRoutingSettings: () => null }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const events = new Map<string, () => void>();
const success: ObsAudioReachResult = {
    reached: true, peakDb: -25,
    verification: {
        operationId: '42', checkedAtUnixMs: 1_700_000_000_000, source: 'Auralyn マイク',
        connectionGeneration: 3, setupGeneration: 4, sourceGeneration: 5, targetSettingsGeneration: 8,
        audioEngineEpoch: 6, audioConditionsRevision: 7,
        config: { host: 'WASAPI', input: 'Exact input', output: 'Exact output', sample_rate: 48000, buffer_size: null },
    },
};
let confirm: (() => void) | undefined;
let current = true;
beforeEach(() => {
    current = true; confirm = undefined; events.clear();
    vi.mocked(listen).mockImplementation(async (event, listener) => {
        events.set(event, () => listener({ event, id: 0, payload: undefined }));
        return () => { events.delete(event); };
    });
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'obs_connection_status') return true;
        if (command === 'obs_check_audio_reach') return success;
        if (command === 'obs_audio_reach_current') return current;
    });
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.useRealTimers(); vi.mocked(invoke).mockReset(); vi.mocked(listen).mockReset(); localStorage.clear(); vi.restoreAllMocks(); });
function open(strict = false) {
    const store = createLocaleStore(() => 'ja', () => true);
    const content = <LocaleProvider store={store}><ObsConnectionSettings showConfirm={request => { confirm = request.onConfirm; }} onClose={vi.fn()} /></LocaleProvider>;
    const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
    return { ...view, store };
}
async function check() {
    const button = await screen.findByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await act(async () => { confirm?.(); });
}
async function checkWithClock() {
    // RTLの非同期待機を実時計で完了させ、pollの予約前からだけ仮想時計にする。
    const button = await screen.findByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') });
    await waitFor(() => expect(button).toBeEnabled());
    vi.useFakeTimers();
    fireEvent.click(button);
    await act(async () => { await confirm?.(); });
}

it.each(['obs://timing-invalidated', 'obs://reach-invalidated', 'audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'global-bypass-changed', 'audio-conditions-changed', 'profile-fx-applied'])('%sで以前の成功をstaleへ変え、時刻と実対象を保持する', async event => {
    open(); await check();
    expect(screen.getByText(message('ja', 'obsReach.confirmed'))).toBeVisible();
    current = false;
    await act(async () => { if (event === 'profile-fx-applied') window.dispatchEvent(new Event(event)); else events.get(event)?.(); });
    expect(screen.getByText(message('ja', 'obsReach.stale'))).toBeVisible();
    expect(screen.queryByText(message('ja', 'obsReach.confirmed'))).not.toBeInTheDocument();
    expect(screen.getByText(/Auralyn マイク/)).toBeVisible();
    expect(screen.getByText(/Exact input/)).toBeVisible();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(1);
});

it('自己tone通知の遅着はnative終了後witnessで再照合し、localeだけで接続・購読・draftを変更しない', async () => {
    const view = open(); await check();
    await act(async () => { events.get('audio-conditions-changed')?.(); });
    expect(screen.getByText(message('ja', 'obsReach.confirmed'))).toBeVisible();
    const host = screen.getByRole('textbox', { name: message('ja', 'settings.ObsConnectionSettings.281') });
    const calls = vi.mocked(invoke).mock.calls.length;
    const subscriptions = vi.mocked(listen).mock.calls.length;
    act(() => { view.store.setLocale('en'); });
    expect(screen.getByRole('textbox', { name: message('en', 'settings.ObsConnectionSettings.281') })).toBe(host);
    expect(host).toHaveValue('localhost');
    expect(screen.getByText(message('en', 'obsReach.confirmed'))).toBeVisible();
    expect(invoke).toHaveBeenCalledTimes(calls); expect(listen).toHaveBeenCalledTimes(subscriptions);
});

it('確認中の外部変更後に届いた成功はcurrentにせず、旧DTOにも成功を推定しない', async () => {
    let resolve!: (result: ObsAudioReachResult) => void;
    vi.mocked(invoke).mockImplementation(command => {
        if (command === 'obs_connection_status') return Promise.resolve(true);
        if (command === 'obs_check_audio_reach') return new Promise(done => { resolve = done; });
        return Promise.resolve(false);
    });
    open(); await check();
    act(() => { events.get('audio-conditions-changed')?.(); });
    await act(async () => { resolve(success); });
    expect(screen.getByText(message('ja', 'obsReach.stale'))).toBeVisible();
    await check();
    await act(async () => { resolve({ reached: true, peakDb: -10 }); });
    expect(screen.getByText(message('ja', 'obsReach.stale'))).toBeVisible();
});

it.each(['hidden', 'unmount'])('%s後の遅い応答を公開せず、自動再確認しない', async action => {
    let resolve!: (result: ObsAudioReachResult) => void;
    vi.mocked(invoke).mockImplementation(command => command === 'obs_connection_status' ? Promise.resolve(true) : command === 'obs_check_audio_reach' ? new Promise(done => { resolve = done; }) : Promise.resolve(true));
    const view = open(); await check();
    if (action === 'unmount') view.unmount();
    else { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
    await act(async () => { resolve(success); });
    expect(screen.queryByText(message('ja', 'obsReach.confirmed'))).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_audio_reach_current')).toHaveLength(0);
});

it('古い再照合応答は後続の失効を巻き戻さない', async () => {
    open(); await check();
    let resolve!: (value: boolean) => void;
    vi.mocked(invoke).mockImplementation(command => command === 'obs_audio_reach_current' ? new Promise(done => { resolve = done; }) : Promise.resolve());
    act(() => { events.get('audio-conditions-changed')?.(); });
    const old = resolve;
    act(() => { events.get('obs://timing-invalidated')?.(); });
    await act(async () => { resolve(false); old(true); });
    expect(screen.getByText(message('ja', 'obsReach.stale'))).toBeVisible();
});

it('StrictModeの遅い購読失敗は確認を許可せず、localeで再購読しない', async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(listen).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const view = open(true);
    await screen.findByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') });
    await act(async () => { reject(new Error('listener unavailable')); });
    expect(screen.getByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') })).toBeDisabled();
    expect(screen.getByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') })).toHaveAccessibleDescription(message('ja', 'obsReach.monitorUnavailable'));
    const calls = vi.mocked(listen).mock.calls.length;
    act(() => { view.store.setLocale('en'); });
    expect(listen).toHaveBeenCalledTimes(calls);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(0);
});

it.each(['ja', 'en'] as const)('到達確認中の操作禁止理由を切断と確認へ関連付ける (%s)', async locale => {
    let finish!: (result: ObsAudioReachResult) => void;
    vi.mocked(invoke).mockImplementation(command => {
        if (command === 'obs_connection_status') return Promise.resolve(true);
        if (command === 'obs_check_audio_reach') return new Promise(resolve => { finish = resolve; });
        return Promise.resolve(true);
    });
    const view = open();
    const button = await screen.findByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') });
    await waitFor(() => expect(button).toBeEnabled());
    act(() => { view.store.setLocale(locale); });
    fireEvent.click(button);
    act(() => { confirm?.(); });
    const reason = message(locale, 'settings.obs.operationBusy');
    const disconnect = screen.getByRole('button', { name: message(locale, 'settings.ObsConnectionSettings.292') });
    const checking = screen.getByRole('button', { name: message(locale, 'settings.ObsConnectionSettings.299') });
    expect(disconnect).toBeDisabled(); expect(disconnect).toHaveAccessibleDescription(reason);
    expect(checking).toBeDisabled(); expect(checking).toHaveAccessibleDescription(reason);
    expect(screen.getAllByText(reason)).toHaveLength(2);
    await act(async () => { finish(success); });
});

it('切断・再接続後も以前のrecordを現在の成功へ戻さない', async () => {
    open(); await check();
    fireEvent.click(screen.getByRole('button', { name: '切断' }));
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    expect(await screen.findByText(message('ja', 'obsReach.stale'))).toBeVisible();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(1);
});

it('確認dialogを開いた後に条件が変われば古い確定callbackから開始しない', async () => {
    open();
    const button = await screen.findByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    act(() => { events.get('audio-stopped')?.(); });
    await act(async () => { confirm?.(); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(0);
});

it('unmount後に登録完了したlistenerも必ず解除する', async () => {
    const pending: ((stop: () => void) => void)[] = [];
    const stop = vi.fn();
    vi.mocked(listen).mockImplementation(() => new Promise(done => { pending.push(done); }));
    const view = open();
    view.unmount();
    await act(async () => { pending.forEach(done => done(stop)); });
    expect(stop).toHaveBeenCalledTimes(pending.length);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(0);
});

it('通知のない変更をactive pollで失効し、値が戻っても旧成功を復活させない。localeはpoll周期を作り直さない', async () => {
    const view = open(); await act(async () => {});
    await checkWithClock();
    const count = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_audio_reach_current').length;
    const first = count();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const host = screen.getByRole('textbox', { name: message('ja', 'settings.ObsConnectionSettings.281') });
    act(() => { view.store.setLocale('en'); });
    expect(screen.getByRole('textbox', { name: message('en', 'settings.ObsConnectionSettings.281') })).toBe(host);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(count()).toBe(first + 1);
    current = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText(message('en', 'obsReach.stale'))).toBeVisible();
    const expired = count(); current = true;
    await act(async () => { events.get('obs://reach-invalidated')?.(); await vi.advanceTimersByTimeAsync(9000); });
    expect(count()).toBe(expired);
    expect(screen.queryByText(message('en', 'obsReach.confirmed'))).not.toBeInTheDocument();
});

it('遅いpollのtrueは後発通知によるfalseを巻き戻さない', async () => {
    open(); await act(async () => {}); await checkWithClock();
    const pending: ((current: boolean) => void)[] = [];
    vi.mocked(invoke).mockImplementation(command => command === 'obs_audio_reach_current' ? new Promise(done => pending.push(done)) : Promise.resolve());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    act(() => { events.get('obs://timing-invalidated')?.(); });
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1](false); pending[0](true); });
    expect(screen.getByText(message('ja', 'obsReach.stale'))).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(pending).toHaveLength(2);
});

it.each(['hidden', 'unmount'])('%sはpollを停止し、進行中pollの遅いtrueも無効にする', async action => {
    const view = open(); await act(async () => {}); await checkWithClock();
    const before = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_audio_reach_current').length;
    let resolve!: (current: boolean) => void;
    vi.mocked(invoke).mockImplementation(command => command === 'obs_audio_reach_current' ? new Promise(done => { resolve = done; }) : Promise.resolve());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    if (action === 'unmount') view.unmount();
    else { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
    await act(async () => { resolve(true); await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.queryByText(message('ja', 'obsReach.confirmed'))).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_audio_reach_current')).toHaveLength(before + 1);
});

it('既存成功から再確認dialogを開き、正常pollが完了しても明示confirmを1回受理する', async () => {
    open(); await act(async () => {}); await checkWithClock();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') }));
    const retry = confirm;
    const before = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_audio_reach_current').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_audio_reach_current')).toHaveLength(before + 2);
    await act(async () => { await retry?.(); await retry?.(); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(2);
});

it.each(['falsePoll', 'event', 'readFailure'])('%sは再確認dialogの古いconfirmを拒否する', async change => {
    open(); await act(async () => {}); await checkWithClock();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'settings.ObsConnectionSettings.300') }));
    const retry = confirm;
    if (change === 'event') await act(async () => { events.get('audio-conditions-changed')?.(); });
    else {
        if (change === 'falsePoll') current = false;
        else vi.mocked(invoke).mockImplementation(command => command === 'obs_audio_reach_current' ? Promise.reject(new Error('read unavailable')) : Promise.resolve());
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    }
    await act(async () => { await retry?.(); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'obs_check_audio_reach')).toHaveLength(1);
});

it('接続が失われた通知後は入力を開き、再接続できる', async () => {
    open();
    const summary = await screen.findByText(/接続先：localhost:4455/);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    vi.mocked(invoke).mockImplementation(async command => command === 'obs_connection_status' ? false : undefined);
    await act(async () => { events.get('obs://timing-invalidated')?.(); });
    expect(screen.getByRole('textbox', { name: 'OBSホスト名' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '接続' })).toBeEnabled();
});

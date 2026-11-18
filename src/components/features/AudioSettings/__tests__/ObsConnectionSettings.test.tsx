import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ObsConnectionSettings } from '../ObsConnectionSettings';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { obsConnectionFailure, obsConnectionFailureNotice } from '@/lib/obsConnectionPreferences';
import { toast } from 'sonner';
vi.mock('../ObsSafeSetup', () => ({ ObsSafeSetup: () => null }));
vi.mock('sonner',()=>({toast:{info:vi.fn(),success:vi.fn(),error:vi.fn()}}));
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); localStorage.clear(); });
const open = () => render(<ObsConnectionSettings showConfirm={vi.fn()} onClose={vi.fn()} />);
it.each(['ja', 'en'] as const)('OBS連携の最初の見出しは、接続ページと同じ名前にしない（%s）', locale => {
    vi.mocked(invoke).mockResolvedValue(false);
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><ObsConnectionSettings showConfirm={vi.fn()} onClose={vi.fn()} /></LocaleProvider>);
    const heading = screen.getByRole('heading', { name: message(locale, 'obs.section.connect') });
    expect(heading).toHaveTextContent(locale === 'ja' ? 'OBSへの接続' : 'Connect to OBS');
    expect(heading.closest('section')).toHaveAttribute('aria-label', message(locale, 'obs.section.connect'));
    expect(screen.queryByRole('heading', { name: locale === 'ja' ? /^接続$/ : /^Connection$/ })).not.toBeInTheDocument();
});
it('保存済みの接続先を使い、失敗時に秘密を含むエラーを転記しない', async () => {
    localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: 'studio-pc', port: 5544 }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_obs_credentials') return {host:'studio-pc',port:5544};
        if (command === 'obs_connection_status') return false;
        if (command === 'connect_obs') throw new Error('connection refused secret');
    });
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: '接続' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'OBSホスト名' })).toHaveValue('studio-pc');
    fireEvent.click(screen.getByRole('button', { name: '接続' }));
    expect(await screen.findByText(/接続が拒否されました/)).toHaveTextContent('5544');
    expect(invoke).toHaveBeenCalledWith('connect_obs', { host: 'studio-pc', port: 5544, password: null, remember: true });
    expect(errorLog).not.toHaveBeenCalled();
    expect(screen.queryByText(/connection refused secret/)).not.toBeInTheDocument();
});
it('接続応答待ちと接続中は入力を固定し、切断後に編集できる', async () => {
    let resolve!: () => void;
    vi.mocked(invoke).mockImplementation(command => {
        if (command === 'obs_connection_status') return Promise.resolve(false);
        if (command === 'connect_obs') return new Promise<void>(done => { resolve = done; });
        return Promise.resolve();
    });
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: '接続' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '接続' }));
    await act(async () => {});
    expect(screen.getByRole('spinbutton', { name: 'OBSポート' })).toBeDisabled();
    await act(async () => resolve());
    const summary = screen.getByText(/接続先：localhost:4455/);
    expect(summary).toHaveAttribute('role', 'status');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(screen.getByRole('spinbutton', { name: 'OBSポート' })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith('disconnect_obs');
    fireEvent.click(screen.getByRole('button', { name: '切断' }));
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'OBSポート' })).toBeEnabled());
});

it.each(['ja','en'] as const)('接続開始locale=%sのtoastを保ち、pending/失敗中のlocaleで入力やIPCを作り直さない',async startedLocale=>{
    const currentLocale=startedLocale==='ja'?'en':'ja';
    const store=createLocaleStore(()=>startedLocale,()=>true);
    localStorage.setItem('vst_host_obs_config',JSON.stringify({host:'exact-studio',port:5544}));
    let reject!: (error:unknown)=>void;
    vi.mocked(invoke).mockImplementation(command=>command==='obs_connection_status'?Promise.resolve(false):command==='connect_obs'?new Promise<void>((_,fail)=>{reject=fail;}):Promise.resolve());
    const guide=vi.fn();const view=render(<LocaleProvider store={store}><ObsConnectionSettings showConfirm={vi.fn()} onClose={vi.fn()} onOpenOBSGuide={guide}/></LocaleProvider>);
    const connect=await screen.findByRole('button',{name:message(startedLocale,'settings.ObsConnectionSettings.290')});
    await waitFor(()=>expect(connect).toBeEnabled());
    const host=screen.getByRole('textbox',{name:message(startedLocale,'settings.ObsConnectionSettings.281')});
    const port=screen.getByRole('spinbutton',{name:message(startedLocale,'settings.ObsConnectionSettings.283')});
    const password=screen.getByLabelText(message(startedLocale,'settings.ObsConnectionSettings.285'));
    fireEvent.change(password,{target:{value:'OBS_SECRET_CANARY'}});
    fireEvent.click(connect);await act(async()=>{});
    const calls=vi.mocked(invoke).mock.calls.length;
    act(()=>{store.setLocale(currentLocale);});
    expect(screen.getByRole('textbox',{name:message(currentLocale,'settings.ObsConnectionSettings.281')})).toBe(host);
    expect(host).toHaveValue('exact-studio');expect(port).toHaveValue(5544);expect(port).toBeDisabled();expect(password).toHaveValue('OBS_SECRET_CANARY');
    expect(invoke).toHaveBeenCalledTimes(calls);
    const failure=new Error('timed out OBS_SECRET_CANARY password=do-not-copy');
    await act(async()=>{reject(failure);});
    const notice=obsConnectionFailureNotice(failure,5544);
    const hint=screen.getByText(message(currentLocale,notice.key,notice.args));
    expect(hint).toBeVisible();expect(view.container.textContent).not.toContain('OBS_SECRET_CANARY');
    const toastCall=vi.mocked(toast.error).mock.lastCall!;
    expect(toastCall[0]).toBe(message(startedLocale,'settings.ObsConnectionSettings.268'));
    expect(toastCall[1]?.description).toBe(message(startedLocale,notice.key,notice.args));
    expect(JSON.stringify(toastCall)).not.toContain('OBS_SECRET_CANARY');
    expect(JSON.stringify(toastCall)).not.toContain('do-not-copy');
    expect(localStorage.getItem('vst_host_obs_config')).toBe(JSON.stringify({host:'exact-studio',port:5544}));
    act(()=>{store.setLocale('ja');});
    expect(hint).toHaveTextContent(obsConnectionFailure(failure,5544));expect(invoke).toHaveBeenCalledTimes(calls);
    expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='connect_obs')).toHaveLength(1);
});

it('接続済みの再表示は要約を閉じて表示し、手動で開いた状態は再描画で維持する', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'obs_connection_status' ? true : undefined);
    const view = open();
    const summary = await screen.findByText(/接続先：localhost:4455/);
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    view.rerender(<ObsConnectionSettings showConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(details).toHaveAttribute('open');
});

const guideLabel = { ja: 'OBS連携ガイドを開く', en: 'Open OBS guide' } as const;
const renderIn = (locale: 'ja' | 'en', onOpenOBSGuide?: () => void) => render(
    <LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <ObsConnectionSettings showConfirm={vi.fn()} onClose={vi.fn()} onOpenOBSGuide={onOpenOBSGuide} />
    </LocaleProvider>,
);
const headingRow = (locale: 'ja' | 'en') => {
    const row = screen.getByRole('heading', { name: message(locale, 'obs.section.connect') }).parentElement;
    if (!row) throw new Error('見出しの行が無い');
    return row;
};

it.each([
    ['ja', { checking: '確認中', disconnected: '未接続', connecting: '接続中', connected: '接続済み', failed: '接続に失敗', unknown: '確認できません' }],
    ['en', { checking: 'Checking', disconnected: 'Not connected', connecting: 'Connecting', connected: 'Connected', failed: 'Connection failed', unknown: 'Cannot check' }],
] as const)('OBSへの接続の見出しの横に、接続の状態の札を出す（%s）', async (locale, labels) => {
    const statusReplies: ((connected: boolean) => void)[] = [];
    let finishConnect!: () => void;
    vi.mocked(invoke).mockImplementation(command => {
        if (command === 'obs_connection_status') return new Promise<boolean>(done => { statusReplies.push(done); });
        if (command === 'connect_obs') return new Promise<void>(done => { finishConnect = done; });
        return Promise.resolve(undefined);
    });
    const view = renderIn(locale);
    await waitFor(() => expect(statusReplies.length).toBeGreaterThan(0));
    expect(within(headingRow(locale)).getByText(labels.checking)).toBeInTheDocument();
    await act(async () => statusReplies.forEach(reply => reply(false)));
    const status = within(headingRow(locale)).getByText(labels.disconnected);
    expect(status.closest('[role="status"]')).not.toBeNull();
    const connect = screen.getByRole('button', { name: message(locale, 'settings.ObsConnectionSettings.290') });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await act(async () => {});
    expect(within(headingRow(locale)).getByText(labels.connecting)).toBeInTheDocument();
    await act(async () => finishConnect());
    expect(within(headingRow(locale)).getByText(labels.connected)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'settings.ObsConnectionSettings.292') }));
    await waitFor(() => expect(within(headingRow(locale)).getByText(labels.disconnected)).toBeInTheDocument());
    view.unmount();

    vi.mocked(invoke).mockImplementation(command => command === 'obs_connection_status' ? Promise.resolve(false) : command === 'connect_obs' ? Promise.reject(new Error('timed out')) : Promise.resolve(undefined));
    const failing = renderIn(locale);
    const retry = await screen.findByRole('button', { name: message(locale, 'settings.ObsConnectionSettings.290') });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(within(headingRow(locale)).getByText(labels.failed)).toBeInTheDocument());
    failing.unmount();

    vi.mocked(invoke).mockImplementation(command => command === 'obs_connection_status' ? Promise.reject(new Error('status')) : Promise.resolve(undefined));
    renderIn(locale);
    await waitFor(() => expect(within(headingRow(locale)).getByText(labels.unknown)).toBeInTheDocument());
    expect(within(headingRow(locale)).queryByText(labels.disconnected)).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('OBS連携ガイドの入口は、見出しの近くで入力欄より前にある（%s）', async locale => {
    vi.mocked(invoke).mockImplementation(command => Promise.resolve(command === 'obs_connection_status' ? false : undefined));
    const guide = vi.fn();
    renderIn(locale, guide);
    const entrance = await screen.findByRole('button', { name: guideLabel[locale] });
    expect(headingRow(locale)).toContainElement(entrance);
    const host = screen.getByRole('textbox', { name: message(locale, 'settings.ObsConnectionSettings.281') });
    expect(entrance.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(entrance);
    expect(guide).toHaveBeenCalledTimes(1);
});

it('ガイドを開く操作が無いときは入口を出さず、接続の失敗でも入口は1つだけにする', async () => {
    vi.mocked(invoke).mockImplementation(command => command === 'obs_connection_status' ? Promise.resolve(false) : command === 'connect_obs' ? Promise.reject(new Error('timed out')) : Promise.resolve(undefined));
    const view = renderIn('ja');
    await screen.findByRole('button', { name: '接続' });
    expect(screen.queryByRole('button', { name: guideLabel.ja })).not.toBeInTheDocument();
    view.unmount();
    renderIn('ja', vi.fn());
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await screen.findByText(/接続に失敗しました。次を確認してください。/);
    expect(screen.getAllByRole('button', { name: guideLabel.ja })).toHaveLength(1);
});

type StatusReply = () => Promise<boolean>;
const staleLabels = { failed: '接続に失敗', unknown: '確認できません', disconnected: '未接続', connected: '接続済み' } as const;
const plan = (reply: { status: StatusReply; connect?: () => Promise<void>; credentials?: () => Promise<unknown> }) => vi.mocked(invoke).mockImplementation(command => {
    if (command === 'obs_connection_status') return reply.status();
    if (command === 'connect_obs') return reply.connect?.() ?? Promise.resolve();
    if (command === 'get_obs_credentials') return reply.credentials?.() ?? Promise.resolve(null);
    return Promise.resolve(undefined);
});
const badge = () => within(headingRow('ja')).getByRole('status');
const hideAndShow = async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};
const timingInvalidated = async () => {
    const callbacks = vi.mocked(listen).mock.calls.filter(([event]) => event === 'obs://timing-invalidated').map(([, callback]) => callback);
    await act(async () => { callbacks.forEach(callback => callback({ event: 'obs://timing-invalidated', id: 1, payload: null })); });
};
const failConnect = async () => {
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(badge()).toHaveTextContent(staleLabels.failed));
};

it.each([
    ['未接続と分かった', () => Promise.resolve(false), staleLabels.disconnected],
    ['取得に失敗した', () => Promise.reject(new Error('status')), staleLabels.unknown],
] as [string, StatusReply, string][])('接続に失敗したあとアプリを隠して戻り、再取得で%sら、古い「接続に失敗」を残さない', async (_name, second, label) => {
    let reply: StatusReply = () => Promise.resolve(false);
    plan({ status: () => reply(), connect: () => Promise.reject(new Error('timed out')) });
    vi.mocked(listen).mockClear();
    renderIn('ja');
    await failConnect();
    reply = second;
    await hideAndShow();
    await waitFor(() => expect(badge()).toHaveTextContent(label));
    expect(badge()).not.toHaveTextContent(staleLabels.failed);
});

it('接続に失敗したあと再取得で接続済みになり、その後に切断しても「接続に失敗」へ戻らない', async () => {
    let reply: StatusReply = () => Promise.resolve(false);
    plan({ status: () => reply(), connect: () => Promise.reject(new Error('timed out')) });
    vi.mocked(listen).mockClear();
    renderIn('ja');
    await failConnect();
    reply = () => Promise.resolve(true);
    await timingInvalidated();
    await waitFor(() => expect(badge()).toHaveTextContent(staleLabels.connected));
    fireEvent.click(screen.getByRole('button', { name: '切断' }));
    await waitFor(() => expect(badge()).toHaveTextContent(staleLabels.disconnected));
    expect(badge()).not.toHaveTextContent(staleLabels.failed);
});

it.each(['再表示', '接続の通知'])('取得に失敗したあと再取得が成功したら、「確認できません」と案内を残さない（%s）', async how => {
    let reply: StatusReply = () => Promise.reject(new Error('status'));
    plan({ status: () => reply() });
    vi.mocked(listen).mockClear();
    renderIn('ja');
    await waitFor(() => expect(badge()).toHaveTextContent(staleLabels.unknown));
    expect(screen.getByText(/接続状態を確認できませんでした/)).toBeInTheDocument();
    reply = () => Promise.resolve(false);
    if (how === '再表示') await hideAndShow(); else await timingInvalidated();
    await waitFor(() => expect(badge()).toHaveTextContent(staleLabels.disconnected));
    expect(badge()).not.toHaveTextContent(staleLabels.unknown);
    expect(screen.queryByText(/接続状態を確認できませんでした/)).not.toBeInTheDocument();
});

it('接続の取得に失敗し、並列の保存済み資格情報の失敗が案内を上書きしても「確認できません」のまま', async () => {
    let failCredentials!: () => void;
    plan({
        status: () => Promise.reject(new Error('status')),
        credentials: () => new Promise<unknown>((_, fail) => { failCredentials = () => fail(new Error('credentials')); }),
    });
    renderIn('ja');
    await waitFor(() => expect(badge()).toHaveTextContent(staleLabels.unknown));
    await act(async () => failCredentials());
    await screen.findByText(/保存済みパスワードを確認できません/);
    expect(badge()).toHaveTextContent(staleLabels.unknown);
    expect(badge()).not.toHaveTextContent(staleLabels.disconnected);
});

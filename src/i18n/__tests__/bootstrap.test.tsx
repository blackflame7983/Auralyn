import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
const mocks = vi.hoisted(() => ({render: vi.fn(), migration: vi.fn(), bridge: vi.fn(), session: vi.fn()}));
vi.mock('react-dom/client', () => ({default: {createRoot: () => ({render: mocks.render})}}));
vi.mock('../../api/migration', () => ({bootstrapMigration: mocks.migration}));
vi.mock('../nativeLocale', () => ({initializeLocaleBridge: mocks.bridge}));
vi.mock('../../lib/temporarySession', () => ({initializeTemporarySession: mocks.session}));
vi.mock('../../App', () => ({default: () => <div>App content</div>}));
let root: Root | undefined;
beforeEach(() => {vi.resetModules(); vi.clearAllMocks(); mocks.session.mockResolvedValue(undefined); localStorage.clear(); document.body.innerHTML = '<div id="root"></div>'; document.documentElement.lang = 'ja';});
afterEach(async () => {if (root) {await act(async () => root?.unmount()); root = undefined;} vi.restoreAllMocks();});
it('移行完了までlocale初期化・描画・native同期を始めず、完了後に保存言語を読む', async () => {
    let finish!: () => void;
    mocks.migration.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
    localStorage.setItem('vst_host_locale', 'en');
    await import('../../main');
    expect(document.documentElement.lang).toBe('ja'); expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.bridge).not.toHaveBeenCalled();
    finish(); await waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    expect(document.documentElement.lang).toBe('en'); expect(mocks.bridge).toHaveBeenCalledOnce();
});
it.each(['getItem', 'setItem'] as const)('migration失敗＋storage.%s拒否でも失敗案内が表示され、native/保存へ進まない', async method => {
    localStorage.setItem('vst_host_locale', 'en');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    if (method === 'getItem') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {throw new Error('storage denied');});
    else write.mockImplementation(() => {throw new Error('quota');});
    mocks.migration.mockRejectedValueOnce(new Error('migration unavailable'));
    await import('../../main'); await waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
    root = actual.createRoot(document.getElementById('root')!);
    await act(async () => root?.render(mocks.render.mock.calls[0][0]));
    const english = method === 'setItem';
    expect(screen.getByRole('heading', {name: english ? 'Could not verify the migrated settings' : '移行した設定を確認できませんでした'})).toBeVisible();
    expect(screen.getByRole('button', {name: english ? 'Retry' : '再試行'})).toBeEnabled();
    expect(mocks.bridge).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});


it('移行固定errorは表示時localeで解決し、切替でbootstrap/nativeを再実行しない', async()=>{
    localStorage.setItem('vst_host_locale','en');
    const {FixedClientError}=await import('../../lib/clientError');
    const error=new FixedClientError('migration.invalidLocale');mocks.migration.mockRejectedValueOnce(error);
    await import('../../main');await waitFor(()=>expect(mocks.render).toHaveBeenCalledOnce());
    const actual=await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
    root=actual.createRoot(document.getElementById('root')!);
    await act(async()=>root?.render(mocks.render.mock.calls[0][0]));
    const alert=screen.getByRole('alert');expect(alert).toHaveTextContent('The display language setting is invalid.');
    const {localeStore}=await import('../locale');act(()=>{localeStore.setLocale('ja');});
    expect(screen.getByRole('alert')).toBe(alert);expect(alert).toHaveTextContent('表示言語の設定が不正です');
    expect(error.message).toBe('表示言語の設定が不正です');expect(mocks.migration).toHaveBeenCalledOnce();expect(mocks.bridge).not.toHaveBeenCalled();
});

it('保存領域の判定が失敗したら移行・アプリ描画・音声初期化へ進まない', async () => {
    mocks.session.mockRejectedValueOnce(new Error('isolation unavailable'));
    await import('../../main'); await waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    expect(mocks.migration).not.toHaveBeenCalled(); expect(mocks.bridge).not.toHaveBeenCalled();
});

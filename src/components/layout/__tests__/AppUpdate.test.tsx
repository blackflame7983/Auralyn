import { PluginClientError } from '@/lib/pluginNotice';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { UpdateGuide, useAppUpdate } from '../AppUpdate';
import { Header } from '../Header';
import { AvailableUpdateDialog } from '../AvailableUpdateDialog';
import { act } from '@testing-library/react';
import { saveUpdatePolicy } from '@/hooks/useUpdates';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: {
    loading: vi.fn(), dismiss: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(),
} }));

function Harness() {
    const update = useAppUpdate();
    return <>
        <button disabled={update.busy} onClick={() => void update.checkUpdates()}>{update.label}</button>
        {update.showGuide && <UpdateGuide onClose={update.closeGuide} />}
        {update.showAvailable && update.available && <AvailableUpdateDialog update={update.available} downloaded={update.downloaded} busy={update.busy} onClose={update.closeAvailable} onDownload={update.download} onInstall={update.install} />}
    </>;
}

beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

it('MSIXでは通常版の更新を問い合わせず、Storeと直接配布の更新方法を分ける', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'msix' : undefined);
    render(<Harness />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_distribution'));
    expect(invoke).not.toHaveBeenCalledWith('check_update');
    fireEvent.click(screen.getByRole('button', { name: '更新方法を確認' }));
    expect(await screen.findByRole('dialog', { name: 'MSIX版の更新方法' })).toBeInTheDocument();
    expect(screen.getByText(/Storeからは更新されません/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Microsoft Storeの更新画面を開く' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_desktop_settings', { target: 'storeUpdates' }));
    expect(invoke).not.toHaveBeenCalledWith('check_update');
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('実際のヘルプメニューが閉じた後もMSIX更新案内を操作できる', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'msix' : undefined);
    const noop = () => {};
    render(<Header onOpenSettings={noop} onOpenOBSGuide={noop} onOpenDiscordGuide={noop}
        onOpenTroubleshoot={noop} onOpenWizard={noop}
        onToggleLargeMeter={noop} isLargeMeterOpen={false}
        currentHost="Wasapi" isEngineRunning={false} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ヘルプメニューを開く' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /更新方法を確認/ }));
    await screen.findByRole('dialog', { name: 'MSIX版の更新方法' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Microsoft Storeの更新画面を開く' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_desktop_settings', { target: 'storeUpdates' }));
    expect(invoke).not.toHaveBeenCalledWith('check_update');
});

it.each(['unknown', null])('配布形式が%sなら通常版更新と最新版の表示へ進まない', async result => {
    vi.mocked(invoke).mockImplementation(async () => {
        if (result === null) throw new Error('IPC取得失敗');
        return result;
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '更新方法を確認' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('更新方法を確認できませんでした', expect.anything()));
    expect(invoke).not.toHaveBeenCalledWith('check_update');
    expect(toast.success).not.toHaveBeenCalled();
});

it('Store起動に失敗しても手動の案内を残し再試行できる', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('Storeなし').mockResolvedValue(undefined);
    render(<UpdateGuide onClose={vi.fn()} />);
    const open = screen.getByRole('button', { name: 'Microsoft Storeの更新画面を開く' });
    fireEvent.click(open);
    expect(await screen.findByRole('alert')).toHaveTextContent('スタートメニュー');
    fireEvent.click(open);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it('通常版は確認とダウンロードを分け、状態保存と明示承認の後だけ適用する', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'standalone'
        : command === 'check_update' ? { version: '1.2.0', canInstall: true } : undefined);
    const save = vi.fn((event: Event) => (event as CustomEvent).detail.resolve());
    window.addEventListener('auralyn-save-session', save);
    try {
        render(<Harness />);
        fireEvent.click(await screen.findByRole('button', { name: 'アップデートを確認' }));
        await screen.findByRole('dialog', { name: 'アップデート' });
        expect(invoke).not.toHaveBeenCalledWith('download_update', expect.anything());
        fireEvent.click(screen.getByRole('button', { name: 'ダウンロード' }));
        const install = await screen.findByRole('button', { name: '保存して更新を適用' });
        expect(install).toBeDisabled();
        expect(invoke).toHaveBeenCalledWith('download_update', { version: '1.2.0' });
        expect(invoke).not.toHaveBeenCalledWith('install_update', expect.anything());
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(install);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('install_update', { version: '1.2.0' }));
        expect(save).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('auralyn-save-session', save); }
});

it('Portableの更新通知からインストールへ進まない', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'standalone'
        : command === 'check_update' ? { version: '1.2.0', canInstall: false } : undefined);
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'アップデートを確認' }));
    await screen.findByText(/Portable版または/);
    expect(screen.queryByRole('button', { name: 'ダウンロード' })).not.toBeInTheDocument();
});

it('通常版の更新取得失敗を最新版とせず、従来の配布ページを案内する', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_distribution') return 'standalone';
        if (command === 'check_update') throw new Error('オフライン');
    });
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'アップデートを確認' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('更新情報を取得できませんでした', expect.anything()));
    expect(toast.success).not.toHaveBeenCalled();
});

it.each(['standalone', 'msix'])('自動確認・任意の取得は%sの所有する経路だけを使い、自動適用しない', async distribution => {
    vi.useFakeTimers();
    saveUpdatePolicy({ automatic: true, download: true });
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? distribution
        : command === 'check_update' ? { version: '1.2.0', canInstall: true } : undefined);
    render(<Harness />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
    if (distribution === 'standalone') {
        expect(invoke).toHaveBeenCalledWith('check_update');
        expect(invoke).toHaveBeenCalledWith('download_update', { version: '1.2.0' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } else expect(invoke).not.toHaveBeenCalledWith('check_update');
    expect(invoke).not.toHaveBeenCalledWith('install_update', expect.anything());
});

it('自動確認OFFと長時間試験では定期処理を起動しない', async () => {
    vi.useFakeTimers();
    saveUpdatePolicy({ automatic: false, download: false });
    vi.mocked(invoke).mockResolvedValue('standalone');
    render(<Harness />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000); });
    expect(invoke).not.toHaveBeenCalledWith('check_update');
});

it.each([false, true])('localeだけで10秒/24hタイマーを再生成せず重複確認・downloadしない（自動取得=%s）', async download => {
    vi.useFakeTimers(); saveUpdatePolicy({ automatic: true, download });
    const store = createLocaleStore(() => 'ja', () => true);
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'standalone'
        : command === 'check_update' ? { version: '1.2.0', canInstall: true } : undefined);
    render(<LocaleProvider store={store}><Harness /></LocaleProvider>);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    act(() => { store.setLocale('en'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'check_update')).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'download_update')).toHaveLength(download ? 1 : 0);
    await act(async () => { await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 10002); });
    act(() => { store.setLocale('ja'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'check_update')).toHaveLength(download ? 1 : 2);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'download_update')).toHaveLength(download ? 1 : 0);
    expect(invoke).not.toHaveBeenCalledWith('install_update', expect.anything());
});

it('開始localeを非同期toastへ固定し、dialogは現在localeと配布元原文を表示する', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    let finish!: (update: unknown) => void;
    vi.mocked(invoke).mockImplementation(command => command === 'get_distribution' ? Promise.resolve('standalone')
        : command === 'check_update' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    render(<LocaleProvider store={store}><Harness /></LocaleProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'アップデートを確認' }));
    await act(async () => {});
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(vi.mocked(invoke).mock.calls).toHaveLength(calls);
    await act(async () => { finish({ version: '2.0.0-beta+001', body: '配布元の原文そのまま', canInstall: true }); });
    expect(toast.info).toHaveBeenCalledWith('v2.0.0-beta+001 が利用可能です', expect.objectContaining({ action: expect.objectContaining({ label: '更新内容を確認' }) }));
    expect(screen.getByRole('dialog', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByText('Update to v2.0.0-beta+001')).toBeInTheDocument();
    expect(screen.getByText('配布元の原文そのまま')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open release page' })).toHaveAttribute('href', 'https://github.com/blackflame7983/Auralyn-Releases/releases');
});

it('確認済みdialogとbusyをlocaleで保持し、保存完了後だけ同versionをinstallする', async () => {
    const store = createLocaleStore(() => 'en', () => true);
    const order: string[] = []; let finishSave!: () => void; let finishInstall!: () => void;
    vi.mocked(invoke).mockImplementation(command => {
        if (command === 'get_distribution') return Promise.resolve('standalone');
        if (command === 'check_update') return Promise.resolve({ version: '1.2.0', canInstall: true });
        if (command === 'install_update') { order.push('install'); return new Promise<void>(resolve => { finishInstall = resolve; }); }
        return Promise.resolve();
    });
    const save = vi.fn((event: Event) => { order.push('save-request'); finishSave = () => { order.push('save-complete'); (event as CustomEvent).detail.resolve(); }; });
    window.addEventListener('auralyn-save-session', save);
    try {
        render(<LocaleProvider store={store}><Harness /></LocaleProvider>);
        fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));
        const dialog = await screen.findByRole('dialog', { name: 'Update' });
        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await screen.findByRole('button', { name: 'Save and apply update' });
        const checkbox = screen.getByRole('checkbox'); fireEvent.click(checkbox);
        act(() => { store.setLocale('ja'); });
        expect(screen.getByRole('dialog', { name: 'アップデート' })).toBe(dialog);
        expect(screen.getByRole('checkbox')).toBe(checkbox); expect(checkbox).toBeChecked();
        fireEvent.click(screen.getByRole('button', { name: '保存して更新を適用' }));
        await act(async () => {});
        const calls = vi.mocked(invoke).mock.calls.length;
        act(() => { store.setLocale('en'); });
        expect(vi.mocked(invoke).mock.calls).toHaveLength(calls);
        expect(checkbox).toBeChecked(); expect(checkbox).toBeDisabled();
        expect(order).toEqual(['save-request']);
        expect(screen.getByRole('button', { name: 'Save and apply update' })).toBeDisabled();
        await act(async () => { finishSave(); });
        expect(order).toEqual(['save-request', 'save-complete', 'install']);
        expect(invoke).toHaveBeenCalledWith('install_update', { version: '1.2.0' });
        await act(async () => { finishInstall(); });
        expect(save).toHaveBeenCalledOnce();
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'download_update')).toHaveLength(1);
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'install_update')).toHaveLength(1);
    } finally { window.removeEventListener('auralyn-save-session', save); }
});

it('Storeを開く待機中のlocale変更でdialogや要求を作り直さず、失敗は現在localeで案内する', async () => {
    const store = createLocaleStore(() => 'ja', () => true); let fail!: () => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('Store unavailable')); }));
    render(<LocaleProvider store={store}><UpdateGuide onClose={vi.fn()} /></LocaleProvider>);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Microsoft Storeの更新画面を開く' }));
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Open Microsoft Store updates' })).toBeDisabled();
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { fail(); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open the Store');
    expect(screen.getByRole('button', { name: 'Open Microsoft Store updates' })).toBeEnabled();
});


it('保存失敗のPluginClientErrorは操作開始localeで通知し、更新のinstallへ進まない', async()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);const error=new PluginClientError('saveProtected');
    vi.mocked(invoke).mockImplementation(async command=>command==='get_distribution'?'standalone':command==='check_update'?{version:'9.0.0',canInstall:true}:undefined);
    let fail!:()=>void;const save=(event:Event)=>{fail=()=>(event as CustomEvent).detail.reject(error);};
    window.addEventListener('auralyn-save-session',save);
    try{
        render(<LocaleProvider store={store}><Harness/></LocaleProvider>);
        fireEvent.click(await screen.findByRole('button',{name:'アップデートを確認'}));
        fireEvent.click(await screen.findByRole('button',{name:'ダウンロード'}));
        await screen.findByRole('button',{name:'保存して更新を適用'});fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button',{name:'保存して更新を適用'}));await act(async()=>{});
        act(()=>{store.setLocale('en');});await act(async()=>{fail();});
        expect(toast.error).toHaveBeenCalledWith('更新を適用できませんでした',expect.objectContaining({description:error.message}));
        expect(invoke).not.toHaveBeenCalledWith('install_update',expect.anything());
    }finally{window.removeEventListener('auralyn-save-session',save);}
});

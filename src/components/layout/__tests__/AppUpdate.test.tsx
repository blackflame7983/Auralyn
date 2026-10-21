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
        onOpenTroubleshoot={noop} onOpenWizard={noop} onToggleGlobalBypass={noop}
        isGlobalBypassed={false} onToggleLargeMeter={noop} isLargeMeterOpen={false}
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
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('自動更新情報を取得できませんでした', expect.anything()));
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

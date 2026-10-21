import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import { UpdateGuide, useAppUpdate } from '../AppUpdate';
import { Header } from '../Header';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: {
    loading: vi.fn(), dismiss: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(),
} }));

function Harness() {
    const update = useAppUpdate();
    return <>
        <button disabled={update.busy} onClick={() => void update.checkUpdates()}>{update.label}</button>
        {update.showGuide && <UpdateGuide onClose={update.closeGuide} />}
    </>;
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

it('MSIXでは通常版の更新を問い合わせず、Storeと直接配布の更新方法を分ける', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'msix' : undefined);
    render(<Harness />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_distribution'));
    expect(check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更新方法を確認' }));
    expect(await screen.findByRole('dialog', { name: 'MSIX版の更新方法' })).toBeInTheDocument();
    expect(screen.getByText(/Storeからは更新されません/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Microsoft Storeの更新画面を開く' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_desktop_settings', { target: 'storeUpdates' }));
    expect(check).not.toHaveBeenCalled();
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
    expect(check).not.toHaveBeenCalled();
});

it.each(['unknown', null])('配布形式が%sなら通常版更新と最新版の表示へ進まない', async result => {
    vi.mocked(invoke).mockImplementation(async () => {
        if (result === null) throw new Error('IPC取得失敗');
        return result;
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '更新方法を確認' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('更新方法を確認できませんでした', expect.anything()));
    expect(check).not.toHaveBeenCalled();
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

it('通常版だけはユーザー操作で更新確認し、承認ボタンから適用・再起動する', async () => {
    vi.mocked(invoke).mockResolvedValue('standalone');
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: '1.2.0', downloadAndInstall } as unknown as Awaited<ReturnType<typeof check>>);
    render(<Harness />);
    const open = await screen.findByRole('button', { name: 'アップデートを確認' });
    expect(check).not.toHaveBeenCalled();
    fireEvent.click(open);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('v1.2.0 が利用可能です', expect.anything()));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    const calls = vi.mocked(toast.info).mock.calls;
    const options = calls[calls.length - 1][1]!;
    const action = options.action as unknown as { onClick: () => Promise<void> };
    await action.onClick();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
});

it('通常版の更新取得失敗を最新版とせず、従来の配布ページを案内する', async () => {
    vi.mocked(invoke).mockResolvedValue('standalone');
    vi.mocked(check).mockRejectedValue('オフライン');
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'アップデートを確認' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('自動更新情報を取得できませんでした', expect.anything()));
    expect(toast.success).not.toHaveBeenCalled();
});

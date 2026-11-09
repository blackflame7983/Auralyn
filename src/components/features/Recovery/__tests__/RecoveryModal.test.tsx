import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryModal } from '../RecoveryModal';
import type { AudioEngineExit } from '@/lib/audioEngineExit';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';

const suspectedPlugin = 'C:\\test\\broken.vst3';
beforeEach(() => localStorage.setItem('vst_host_detected_crash_plugin', suspectedPlugin));
afterEach(() => { cleanup(); localStorage.clear(); });
function Example({ onClose, onRecover = async () => {}, onWithoutPlugins = async () => {}, onKeepStopped = async () => {}, exit, onOpenDeviceSettings }: {
    onClose: () => void;
    onRecover?: (safeMode: boolean, excludePath?: string) => Promise<void>;
    onWithoutPlugins?: () => Promise<void>;
    onKeepStopped?: () => Promise<void>;
    exit?: AudioEngineExit;
    onOpenDeviceSettings?: () => void;
}) {
    const [open, setOpen] = useState(true);
    return <RecoveryModal isOpen={open} error="テスト用の停止通知" onRecover={onRecover} onWithoutPlugins={onWithoutPlugins} onKeepStopped={onKeepStopped}
        exit={exit} onOpenDeviceSettings={onOpenDeviceSettings} onClose={() => { onClose(); setOpen(false); }} />;
}
const dialog = () => screen.getByRole('dialog', { name: '音声エンジンが停止しました' });
const escape = async () => { await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); }); };

it('待機中にEscを押しても復旧手段と原因候補を失わない', async () => {
    const close = vi.fn();
    render(<Example onClose={close} />);
    await escape();
    expect(close).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByText(suspectedPlugin)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'このVSTを除いて再試行' })).toBeEnabled();
});

it.each([true, false])('復旧処理中もEscで閉じず、明示した復旧の成功後に閉じる（除外=%s）', async safeMode => {
    const close = vi.fn();
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<Example onClose={close} onRecover={recover} />);
    fireEvent.click(screen.getByRole('button', { name: safeMode ? 'このVSTを除いて再試行' : '全セッションを再読み込み' }));
    expect(recover).toHaveBeenCalledWith(safeMode, safeMode ? suspectedPlugin : undefined);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await escape();
    expect(dialog()).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['without', 'stop'])('原因pathがなくても%sを明示選択でき、ACK成功時だけ閉じる', async choice => {
    localStorage.clear();
    const close = vi.fn(); const without = vi.fn(async () => {}); const stop = vi.fn(async () => {});
    render(<Example onClose={close} onWithoutPlugins={without} onKeepStopped={stop} />);
    expect(screen.queryByRole('button', { name: 'このVSTを除いて再試行' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: choice === 'without' ? '保存済み構成を保持してVSTなしで再開' : '停止したままにする' }));
    await act(async () => {});
    expect(choice === 'without' ? without : stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it.each(['without', 'stop', 'restore'])('%sの拒否は画面に残り再試行できる', async choice => {
    const close = vi.fn(); const reject = vi.fn().mockRejectedValueOnce(new Error('no ACK')).mockResolvedValue(undefined);
    render(<Example onClose={close} onWithoutPlugins={reject} onKeepStopped={reject} onRecover={reject} />);
    const name = choice === 'without' ? '保存済み構成を保持してVSTなしで再開' : choice === 'stop' ? '停止したままにする' : '全セッションを再読み込み';
    fireEvent.click(screen.getByRole('button', { name })); await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('保存済み構成は保持'); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name })); await act(async () => {}); expect(close).toHaveBeenCalledOnce();
});

it.each(['ja', 'en'] as const)('%sの機器復旧は停止を先頭の主ボタンにし、残存VSTを表示しない', async locale => {
    const close = vi.fn(); const stop = vi.fn(async () => {});
    localStorage.setItem('vst_host_pending_plugin', 'pending.vst3');
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <Example onClose={close} onKeepStopped={stop} exit={{ cause: 'device_open', phase: 'settling' }} onOpenDeviceSettings={vi.fn()} />
    </LocaleProvider>);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(button => button.textContent?.trim())).toEqual(locale === 'ja' ? [
        '機器を開かずに止めたままにする', '別の機器を選ぶ', '全セッションを再読み込み', '保存済み構成を保持してVSTなしで再開',
    ] : [
        'Keep audio stopped without opening the device', 'Choose another device', 'Reload the saved session', 'Resume without VSTs and keep the saved session',
    ]);
    expect(buttons[0]).toHaveClass('bg-primary');
    expect(buttons[0]).toHaveFocus();
    for (const button of buttons.slice(1)) expect(button).not.toHaveClass('bg-primary');
    expect(screen.queryByText(suspectedPlugin)).toBeNull();
    expect(localStorage.getItem('vst_host_pending_plugin')).toBe('pending.vst3');
    fireEvent.click(buttons[0]); await act(async () => {});
    expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it('別の機器を選ぶ前に停止を確定し、成功後だけ設定へ移る', async () => {
    const close = vi.fn(); const settings = vi.fn();
    let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<Example onClose={close} onKeepStopped={stop} exit={{ cause: 'device_open' }} onOpenDeviceSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: '別の機器を選ぶ' }));
    expect(stop).toHaveBeenCalledOnce(); expect(settings).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await escape(); expect(dialog()).toBeInTheDocument();
    await act(async () => finish());
    expect(settings).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it('停止の拒否では設定へ移らず、機器の復旧画面で再試行できる', async () => {
    const close = vi.fn(); const settings = vi.fn();
    render(<Example onClose={close} onKeepStopped={vi.fn().mockRejectedValue(new Error('no ACK'))} exit={{ cause: 'device_open' }} onOpenDeviceSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: '別の機器を選ぶ' })); await act(async () => {});
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(settings).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});

it.each([undefined, { cause: 'unknown' }, { cause: 'vst_operation' }] as const)('機器以外の終了では従来のボタン順と主ボタンを維持する: %j', exit => {
    render(<Example onClose={vi.fn()} exit={exit} onOpenDeviceSettings={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(button => button.textContent?.trim())).toEqual([
        'このVSTを除いて再試行', '全セッションを再読み込み', '保存済み構成を保持してVSTなしで再開', '停止したままにする',
    ]);
    expect(buttons[0]).toHaveClass('bg-primary');
    expect(buttons[3]).not.toHaveClass('bg-primary');
});

it('原因候補がない従来の終了では再読み込みを主ボタンにする', () => {
    localStorage.clear();
    render(<Example onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: '全セッションを再読み込み' })).toHaveClass('bg-primary');
});

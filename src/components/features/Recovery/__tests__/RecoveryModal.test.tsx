import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryModal } from '../RecoveryModal';

const suspectedPlugin = 'C:\\test\\broken.vst3';
beforeEach(() => localStorage.setItem('vst_host_detected_crash_plugin', suspectedPlugin));
afterEach(() => { cleanup(); localStorage.clear(); });
function Example({ onClose, onRecover = async () => {}, onWithoutPlugins = async () => {}, onKeepStopped = async () => {} }: {
    onClose: () => void;
    onRecover?: (safeMode: boolean, excludePath?: string) => Promise<void>;
    onWithoutPlugins?: () => Promise<void>;
    onKeepStopped?: () => Promise<void>;
}) {
    const [open, setOpen] = useState(true);
    return <RecoveryModal isOpen={open} error="テスト用の停止通知" onRecover={onRecover} onWithoutPlugins={onWithoutPlugins} onKeepStopped={onKeepStopped}
        onClose={() => { onClose(); setOpen(false); }} />;
}
const dialog = () => screen.getByRole('dialog', { name: 'オーディオエンジンが停止しました' });
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

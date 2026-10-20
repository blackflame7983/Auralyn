import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryModal } from '../RecoveryModal';

const suspectedPlugin = 'C:\\test\\broken.vst3';
beforeEach(() => localStorage.setItem('vst_host_detected_crash_plugin', suspectedPlugin));
afterEach(() => { cleanup(); localStorage.clear(); });
function Example({ onClose, onRecover = async () => {}, onClear = () => {} }: {
    onClose: () => void;
    onRecover?: (safeMode: boolean, excludePath?: string) => Promise<void>;
    onClear?: () => void;
}) {
    const [open, setOpen] = useState(true);
    return <RecoveryModal isOpen={open} error="テスト用の停止通知" onRecover={onRecover} onClear={onClear}
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
    expect(screen.getByRole('button', { name: '原因のプラグインを除外して復旧 (推奨)' })).toBeEnabled();
});

it.each([true, false])('復旧処理中もEscで閉じず、明示した復旧の成功後に閉じる（除外=%s）', async safeMode => {
    const close = vi.fn();
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<Example onClose={close} onRecover={recover} />);
    fireEvent.click(screen.getByRole('button', { name: safeMode ? '原因のプラグインを除外して復旧 (推奨)' : '全セッションを再読み込み' }));
    expect(recover).toHaveBeenCalledWith(safeMode, safeMode ? suspectedPlugin : undefined);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await escape();
    expect(dialog()).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('明示したセッション破棄の操作で閉じる', () => {
    const close = vi.fn();
    const clear = vi.fn();
    render(<Example onClose={close} onClear={clear} />);
    fireEvent.click(screen.getByRole('button', { name: 'セッションを破棄して開始' }));
    expect(clear).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

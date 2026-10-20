import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TemplateWizardModal } from '../TemplateWizardModal';

afterEach(cleanup);
it('外部VSTの準備と設定値の手動調整を明示し、内蔵処理へ進める', () => {
    const settings = vi.fn();
    render(<TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={[]} onApplyTemplate={vi.fn()}
        onScan={vi.fn()} isScanning={false} onOpenSoundSettings={settings} />);
    expect(screen.getByText(/各VSTの設定値は自動調整しません/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '外部VSTを使わず、内蔵処理を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
});

it('適用が失敗したら成功扱いで画面を閉じない', async () => {
    const close = vi.fn();
    render(<TemplateWizardModal isOpen onClose={close} availablePlugins={[
        { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
    ]} onApplyTemplate={async () => false} onScan={vi.fn()} isScanning={false} />);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const apply = screen.getByRole('button', { name: 'VST構成を置き換える' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toBeEnabled());
    expect(close).not.toHaveBeenCalled();
});

it('適用中は画面移動・閉じる・構成変更を止め、失敗後に操作を戻す', async () => {
    const close = vi.fn();
    const settings = vi.fn();
    let finish!: (value: boolean) => void;
    const applyTemplate = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    render(<TemplateWizardModal isOpen onClose={close} availablePlugins={[
        { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
    ]} onApplyTemplate={applyTemplate} onScan={vi.fn()} isScanning={false} onOpenSoundSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const apply = screen.getByRole('button', { name: 'VST構成を置き換える' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    const blocked = ['閉じる', 'キャンセル', '← 戻る', '外部VSTを使わず、内蔵処理を設定する'];
    for (const name of blocked) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        fireEvent.click(button);
    }
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(applyTemplate).toHaveBeenCalledOnce();
    await act(async () => { finish(false); });
    for (const name of blocked) expect(screen.getByRole('button', { name })).toBeEnabled();
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeEnabled();
    expect(apply).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: blocked[3] }));
    expect(settings).toHaveBeenCalledOnce();
});

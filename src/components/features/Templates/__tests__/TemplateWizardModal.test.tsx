import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
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

it('localeだけでtemplate元objectと手動割当を保ち、自動割当やscan/applyを再実行しない', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const scan = vi.fn(); const apply = vi.fn(async () => false);
    const plugins = [
        { id: 'auto', name: 'Comp', vendor: '実メーカー', path: 'auto-comp', version: '', category: 'Fx' },
        { id: 'manual', name: 'My voice tool', vendor: '実メーカー', path: 'manual', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limit', version: '', category: 'Fx' },
    ];
    render(<LocaleProvider store={store}><TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={plugins} onApplyTemplate={apply} onScan={scan} isScanning={false} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const compressor = screen.getByRole('combobox', { name: 'コンプレッサーに使うVST' });
    fireEvent.change(compressor, { target: { value: 'manual' } });
    const dialog = screen.getByRole('dialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('combobox', { name: 'VST for Compressor' })).toBe(compressor);
    expect(compressor).toHaveValue('manual'); expect(scan).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace the VST chain' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(expect.objectContaining({ '1': plugins[1], '2': plugins[2] })));
});

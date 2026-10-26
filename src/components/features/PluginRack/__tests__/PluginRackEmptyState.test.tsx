import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { PluginRackEmptyState } from '../PluginRackEmptyState';
import { PluginList } from '../PluginList';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));

afterEach(cleanup);

it.each([false, true])('稼働確認=%sでVST追加の優先度を変えても、すべての入口は操作できる', audioReady => {
    const add = vi.fn();
    const templates = vi.fn();
    const wizard = vi.fn();
    render(<PluginRackEmptyState audioReady={audioReady} onAddClick={add} onOpenTemplates={templates} onOpenWizard={wizard} />);
    const addButton = screen.getByRole('button', { name: 'VSTを追加' });
    expect(addButton).toBeEnabled();
    if (audioReady) expect(addButton).toHaveClass('bg-primary');
    else { expect(addButton).toHaveClass('border-input'); expect(addButton).not.toHaveClass('bg-primary'); }
    fireEvent.click(addButton);
    expect(add).toHaveBeenCalledOnce();
    expect(wizard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'VST構成テンプレート' }));
    expect(templates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'セットアップを開く' }));
    expect(wizard).toHaveBeenCalledOnce();
});


it.each(['ja', 'en'] as const)('空状態の説明は音づくりへの経路だけを補い、見出しと操作名を維持する（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><PluginRackEmptyState onAddClick={vi.fn()} onOpenTemplates={vi.fn()} onOpenWizard={vi.fn()} /></LocaleProvider>);
    expect(screen.getByRole('heading', { name: message(locale, 'rack.empty.title') })).toBeVisible();
    expect(screen.getByRole('button', { name: message(locale, 'rack.empty.addVst') })).toBeEnabled();
    expect(screen.getByText(locale === 'ja' ? 'ノイズ低減と内蔵ボイスチェーンは「設定 → 音づくり」で調整します。' : 'Adjust noise reduction and the built-in voice chain in Settings → Sound.')).toBeVisible();
});


it.each([false, true])('ラック経由でも稼働確認=%sを空状態へ引き継ぐ', audioReady => {
    render(<PluginList plugins={[]} audioReady={audioReady} onAddClick={vi.fn()} onToggle={vi.fn()}
        onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()}
        onOpenPresets={vi.fn()} onOpenWizard={vi.fn()} onOpenTemplates={vi.fn()} />);
    const add = screen.getByRole('button', { name: 'VSTを追加' });
    expect(add).toBeEnabled();
    expect(add.classList.contains('bg-primary')).toBe(audioReady);
});

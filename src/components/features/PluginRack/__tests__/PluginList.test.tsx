import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginList } from '../PluginList';
class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverMock);
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
it.each(['true', 'false'])('並べ替えのフォーカスとキー処理が同じボタンにあり日本語で中断を通知する: simple=%s', async simple => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    localStorage.setItem('vst_host_simple_mode', simple);
    const reorder = vi.fn();
    render(<PluginList plugins={[{ id: 'first', name: 'EQ', path: 'eq', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1 }]}
        onAddClick={vi.fn()} onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} onReorder={reorder} onOpenPresets={vi.fn()} onOpenTemplates={vi.fn()} />);
    const handle = screen.getByRole('button', { name: 'EQを並べ替え' });
    expect(handle.tagName).toBe('BUTTON');
    expect(handle).toHaveAccessibleDescription(/Spaceキーで開始/);
    expect(screen.queryByText(/To pick up a draggable item/)).not.toBeInTheDocument();
    handle.focus();
    fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('EQの並べ替えを開始しました'));
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('並べ替えを中止しました'));
    expect(reorder).not.toHaveBeenCalled();
});

it('キー並べ替え中の言語切替はdragを再開始・確定せず、次の通知を新localeで解決する', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const reorder = vi.fn();
    render(<LocaleProvider store={store}><PluginList plugins={[{ id: 'first', name: 'EQ', path: 'eq', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1 }]}
        onAddClick={vi.fn()} onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} onReorder={reorder} onOpenPresets={vi.fn()} onOpenTemplates={vi.fn()} /></LocaleProvider>);
    const handle = screen.getByRole('button', { name: 'EQを並べ替え' });
    handle.focus(); fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('EQの並べ替えを開始しました'));
    act(() => { store.setLocale('en'); });
    expect(handle).toBe(screen.getByRole('button', { name: /Reorder EQ/ }));
    expect(handle).toHaveAccessibleDescription(/Press Space to start/);
    expect(reorder).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cancelled reordering EQ'));
    expect(reorder).not.toHaveBeenCalled();
});

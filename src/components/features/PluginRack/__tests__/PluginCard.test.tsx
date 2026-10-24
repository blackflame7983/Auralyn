import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginCard } from '../PluginCard';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([false, true])('詳細・かんたん表示で操作名と有効状態を公開する（かんたん=%s）', simpleMode => {
    const onToggle = vi.fn();
    const onMute = vi.fn();
    render(<PluginCard simpleMode={simpleMode}
        plugin={{ id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: true, gain: 1 }}
        onToggle={onToggle} onMute={onMute} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByRole('slider', { name: 'OTTのゲイン' })).toHaveAttribute('aria-valuetext', '0.0 dB');
    const toggle = screen.getByRole('switch', { name: 'OTTを有効にする' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith('1', false);
    expect(screen.getByRole('button', { name: 'OTTを削除' })).toBeInTheDocument();
    {
        const mute = screen.getByRole('button', { name: 'OTTをミュート' });
        expect(mute).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(mute);
        expect(onMute).toHaveBeenCalledWith('1', false);
    }
});

it('削除確認中のlocale変更は同じdialogと実名を保持し、明示確定時だけ同IDを削除する', () => {
    const store = createLocaleStore(() => 'ja', () => true); const remove = vi.fn();
    render(<LocaleProvider store={store}><PluginCard simpleMode
        plugin={{ id: 'actual-1', name: '実名OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: true, gain: 1 }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={remove} onEdit={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '実名OTTを削除' }));
    const dialog = screen.getByRole('dialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('heading', { name: 'Remove 実名OTT' })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledExactlyOnceWith('actual-1');
});

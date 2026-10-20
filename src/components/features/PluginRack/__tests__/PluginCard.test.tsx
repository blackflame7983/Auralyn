import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

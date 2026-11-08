import { cleanup, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { message } from '@/i18n/messages';
import { RuntimeStatsContext } from '@/components/layout/RuntimeStatsContext';
import { PluginCard } from '@/components/features/PluginRack/PluginCard';
import type { EngineRuntimeStats } from '@/api/audio';
import { usePluginHealthNotices } from '../usePluginHealthNotices';

const holder = vi.hoisted(() => ({ stats: null as EngineRuntimeStats | null }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useRuntimeStats', () => ({ useRuntimeStats: () => holder.stats }));

const plugins = [{ id: '1', name: 'OTT' }];
const isolated = { pluginHealth: [{ id: '1', state: 'isolated', invalidBlocks: 3 }] } as EngineRuntimeStats;
const resumed = { pluginHealth: [] } as unknown as EngineRuntimeStats;
const plugin = { id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1 };
const toastText = message('ja', 'rack.card.isolatedToast', { arg0: 'OTT' });

beforeEach(() => { holder.stats = null; vi.mocked(toast.warning).mockClear(); });
afterEach(() => cleanup());

it('ラックを出していない間の停止を一度知らせる', () => {
    const view = renderHook(() => usePluginHealthNotices(plugins));
    expect(toast.warning).not.toHaveBeenCalled();
    holder.stats = isolated;
    view.rerender();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(toastText);
    view.rerender();
    expect(toast.warning).toHaveBeenCalledTimes(1);
});

it('カードを付け直しても同じ停止を知らせ直さない', () => {
    holder.stats = isolated;
    const notices = renderHook(() => usePluginHealthNotices(plugins));
    const card = (key: string) => (
        <RuntimeStatsContext.Provider value={{ stats: isolated, running: true }}>
            <PluginCard key={key} plugin={plugin} onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />
        </RuntimeStatsContext.Provider>
    );
    const view = render(card('a'));
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'rack.card.isolatedDetail'));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    view.unmount();
    render(card('b'));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    notices.unmount();
});

it('統計が欠測して戻っても同じ停止を知らせ直さない', () => {
    holder.stats = isolated;
    const view = renderHook(() => usePluginHealthNotices(plugins));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    holder.stats = null;
    view.rerender();
    holder.stats = isolated;
    view.rerender();
    expect(toast.warning).toHaveBeenCalledTimes(1);
});

it('再開で停止が消えたあと、再び停止したら知らせる', () => {
    holder.stats = isolated;
    const view = renderHook(() => usePluginHealthNotices(plugins));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    holder.stats = resumed;
    view.rerender();
    holder.stats = isolated;
    view.rerender();
    expect(toast.warning).toHaveBeenCalledTimes(2);
});

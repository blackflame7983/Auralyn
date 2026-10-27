import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginCard } from '../PluginCard';
import { RuntimeStatsContext } from '@/components/layout/RuntimeStatsContext';
import type { EngineRuntimeStats } from '@/api/audio';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('遅延申告は現在の世代とIDが一致した値だけを表示し、0と未取得を区別する', () => {
    const stats = { queueDiagnostics: { state: 'running', epoch: 'e1' }, latencyMetadata: { schemaVersion: 1, streamRunning: true,
        stageBreakdown: { schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: 'e1', nr: { enabled: true },
            builtinVoiceEnabled: false, builtinReverbEnabled: false, globalBypass: false,
            vst: [{ id: '1', state: 'active', declaredSamples: 0 }] } } } as unknown as EngineRuntimeStats;
    const card = <PluginCard simpleMode plugin={{ id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: true, muted: false, gain: 1 }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />;
    const view = render(<RuntimeStatsContext.Provider value={{ stats, running: true }}>{card}</RuntimeStatsContext.Provider>);
    expect(screen.getByText('遅延申告：0 sample')).toBeInTheDocument();
    stats.queueDiagnostics!.epoch = 'other';
    view.rerender(<RuntimeStatsContext.Provider value={{ stats, running: true }}>{card}</RuntimeStatsContext.Provider>);
    expect(screen.getByText('遅延申告：未取得')).toBeInTheDocument();
    expect(screen.queryByText('遅延申告：0 sample')).not.toBeInTheDocument();
});
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
        if (simpleMode) expect(mute).toHaveTextContent('ミュート');
        expect(mute).not.toHaveTextContent('ミュート解除');
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

import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginCard } from '../PluginCard';
import { RuntimeStatsContext } from '@/components/layout/RuntimeStatsContext';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { message } from '@/i18n/messages';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it.each([true, false])('数値の詳細OFFではカード形式によらずVST遅延を表示しない (%s)', simpleMode => {
    render(<PluginCard simpleMode={simpleMode} plugin={{ id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1 }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.queryByText(message('ja', 'rack.latencyUnknown'))).not.toBeInTheDocument();
});
it('遅延申告は現在の世代とIDが一致した値だけを表示し、0と未取得を区別する', () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    const stats = { queueDiagnostics: { state: 'running', epoch: 'e1' }, latencyMetadata: { schemaVersion: 1, streamRunning: true,
        stageBreakdown: { schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: 'e1', nr: { enabled: true },
            builtinVoiceEnabled: false, builtinReverbEnabled: false, globalBypass: false,
            vst: [{ id: '1', state: 'active', declaredSamples: 0 }] } } } as unknown as EngineRuntimeStats;
    const card = <PluginCard simpleMode plugin={{ id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: true, muted: false, gain: 1 }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />;
    const view = render(<RuntimeStatsContext.Provider value={{ stats, running: true }}>{card}</RuntimeStatsContext.Provider>);
    expect(screen.getByText(message('ja', 'rack.latencyReported', { samples: 0 }))).toBeInTheDocument();
    stats.queueDiagnostics!.epoch = 'other';
    view.rerender(<RuntimeStatsContext.Provider value={{ stats, running: true }}>{card}</RuntimeStatsContext.Provider>);
    expect(screen.getByText(message('ja', 'rack.latencyUnknown'))).toBeInTheDocument();
    expect(screen.queryByText(message('ja', 'rack.latencyReported', { samples: 0 }))).not.toBeInTheDocument();
});
it.each([false, true])('詳細・かんたん表示で操作名と有効状態を公開する（かんたん=%s）', simpleMode => {
    const onToggle = vi.fn();
    const onMute = vi.fn();
    render(<PluginCard simpleMode={simpleMode}
        plugin={{ id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: true, gain: 1 }}
        onToggle={onToggle} onMute={onMute} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByRole('slider', { name: 'OTTのゲイン' })).toHaveAttribute('aria-valuetext', '100%');
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

it.each([true, false])('モノラルは文字で示し、混ぜ方と片側・逆相の説明を残す（かんたん=%s）', simpleMode => {
    render(<PluginCard simpleMode={simpleMode}
        plugin={{ id: '1', name: 'MonoEQ', path: 'eq', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1, channelLayout: 'mono' }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    const badge = screen.getByTitle(message('ja', 'rack.card.monoDescription'));
    expect(badge).toHaveTextContent('モノラル');
    expect(badge).toHaveTextContent('片側だけの音は約 -6 dB');
    expect(screen.queryByText('モノラル入力')).not.toBeInTheDocument();
});

it('モノラル入力は別の文字で示し、ステレオのカードには出さない', () => {
    const { rerender } = render(<PluginCard simpleMode
        plugin={{ id: '1', name: 'Widen', path: 'w', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1, channelLayout: 'monoToStereo' }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByTitle(message('ja', 'rack.card.monoInputDescription'))).toHaveTextContent('モノラル入力');
    rerender(<PluginCard simpleMode
        plugin={{ id: '1', name: 'Widen', path: 'w', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1, channelLayout: 'stereo' }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.queryByText('モノラル入力')).not.toBeInTheDocument();
    expect(screen.queryByText('モノラル')).not.toBeInTheDocument();
});

it('削除確認中のlocale変更は同じdialogと実名を保持し、明示確定時だけ同IDを削除する', () => {
    const store = createLocaleStore(() => 'ja', () => true); const remove = vi.fn();
    render(<LocaleProvider store={store}><PluginCard simpleMode
        plugin={{ id: 'actual-1', name: '実名OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: true, gain: 1 }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={remove} onEdit={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '実名OTTを削除' }));
    const dialog = screen.getByRole('alertdialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(screen.getByRole('heading', { name: 'Remove 実名OTT' })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledExactlyOnceWith('actual-1');
});

const plugin = { id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: false, muted: false, gain: 1 };
const isolatedStats = { pluginHealth: [{ id: '1', state: 'isolated', invalidBlocks: 3 }] } as EngineRuntimeStats;

it.each([false, true])('停止中は理由と再開を出し、カード自体は知らせない（かんたん=%s）', simpleMode => {
    vi.mocked(toast.warning).mockClear();
    vi.spyOn(audioApi, 'resumePlugin').mockResolvedValue(undefined);
    const card = <PluginCard simpleMode={simpleMode} plugin={plugin}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />;
    const first = render(<RuntimeStatsContext.Provider value={{ stats: isolatedStats, running: true }}>{card}</RuntimeStatsContext.Provider>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(message('ja', 'rack.card.isolated'));
    expect(status).toHaveTextContent(message('ja', 'rack.card.isolatedDetail'));
    expect(status).toHaveTextContent('このVSTから後段へ渡す音声を無音にしています');
    expect(status.querySelector('svg')).toBeTruthy();
    expect(toast.warning).not.toHaveBeenCalled();
    first.unmount();
    const view = render(<RuntimeStatsContext.Provider value={{ stats: isolatedStats, running: true }}>{card}</RuntimeStatsContext.Provider>);
    expect(toast.warning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'rack.card.resumeAccessible', { arg0: 'OTT' }) }));
    expect(audioApi.resumePlugin).toHaveBeenCalledWith('1');
    const cleared = { pluginHealth: [] } as unknown as EngineRuntimeStats;
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: cleared, running: true }}>{card}</RuntimeStatsContext.Provider>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OTTをミュート' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OTTを削除' })).toBeInTheDocument();
});

it('配信ラックには主経路の停止を出さない', () => {
    vi.mocked(toast.warning).mockClear();
    render(<RuntimeStatsContext.Provider value={{ stats: isolatedStats, running: true }}>
        <PluginCard rackKind="broadcast" plugin={plugin} onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />
    </RuntimeStatsContext.Provider>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
});

it('再開に失敗したらその旨を知らせる', async () => {
    vi.spyOn(audioApi, 'resumePlugin').mockRejectedValueOnce(new Error('offline'));
    vi.mocked(toast.error).mockClear();
    render(<RuntimeStatsContext.Provider value={{ stats: isolatedStats, running: true }}>
        <PluginCard plugin={plugin} onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />
    </RuntimeStatsContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'rack.card.resumeAccessible', { arg0: 'OTT' }) }));
    await act(async () => { await Promise.resolve(); });
    expect(toast.error).toHaveBeenCalledWith(message('ja', 'rack.card.resumeFailed'));
});

it('U04: かんたん表示では主操作行（有効/無効スイッチ・ON/OFFバッジ・設定画面）と出力行（ゲイン・ミュート）を分離し誤操作を防ぐ', () => {
    const view = render(<PluginCard simpleMode
        plugin={{ id: '1', name: 'OTT', path: 'ott', vendor: '', version: '', enabled: true, hasEditor: true, muted: false, gain: 1 }}
        onToggle={vi.fn()} onMute={vi.fn()} onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} />);
    const primaryRow = view.container.querySelector('[data-plugin-row="primary"]')!;
    const outputRow = view.container.querySelector('[data-plugin-row="output"]')!;
    expect(primaryRow).toBeTruthy();
    expect(outputRow).toBeTruthy();
    expect(primaryRow.querySelector('[data-plugin-bypass-state="active"]')).toHaveTextContent('ON');
    expect(primaryRow.contains(screen.getByRole('switch', { name: 'OTTを有効にする' }))).toBe(true);
    expect(primaryRow.contains(screen.getByRole('button', { name: 'OTTをミュート' }))).toBe(false);
    expect(outputRow.contains(screen.getByRole('button', { name: 'OTTをミュート' }))).toBe(true);
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EngineRuntimeStats } from '@/api/audio';
import type { AppPage } from '@/hooks/useUIState';
import { AppShell } from '../AppShell';
import { OutputGainControl } from '../OutputGainControl';
import { context, audioState, runtimeWith, liveStatus } from '@/__tests__/fixtures/preparation';
import { buildPreparationObservation } from '@/lib/preparation';

vi.mock('../AppUpdate', () => ({ useAppUpdate: () => ({ busy: false, label: '更新の確認', description: '', checkUpdates: vi.fn() }), UpdateGuide: () => null }));
vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: () => null }));
vi.mock('../../features/Home/VoiceQuickControls', () => ({
    useVoiceQuick: () => ({ stats: {}, noiseOn: true, chainOn: true, preset: 'broadcast', shownAmount: 50 }),
    NoiseSwitch: () => null, NoiseQuick: () => null, BuiltinSwitch: () => null, BuiltinQuick: () => null,
    BuiltinAmount: () => null, BuiltinPresets: () => null, ToneGuide: () => null,
}));

// 札の表示と移動先は、準備の観測（usePreparation）の同じスナップショットで決める。
// 右の列の統計（runtimeStats）は別の購読なので、未取得・古い値でも移動先を変えてはならない（#766）。
const snapshot = vi.hoisted(() => ({ muted: false, outputGain: 1, pushed: null as EngineRuntimeStats | null }));
vi.mock('@/hooks/usePreparation', async () => {
    const { buildPreparationObservation: build } = await import('@/lib/preparation');
    const fixtures = await import('@/__tests__/fixtures/preparation');
    return {
        usePreparation: () => {
            const stats = fixtures.runtimeWith({ muted: snapshot.muted, outputGain: snapshot.outputGain });
            return { context: fixtures.context, observation: build(fixtures.audioState, stats, fixtures.liveStatus, fixtures.context), records: {}, checking: false, confirming: false,
                confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() };
        },
    };
});
vi.mock('../MasterBar', () => ({
    MasterBar: ({ onCheckOutput, onStatsChange }: { onCheckOutput?: (anchor: HTMLButtonElement) => void; onStatsChange?: (stats: EngineRuntimeStats | null) => void }) => <>
        <button type="button" onClick={event => onCheckOutput?.(event.currentTarget)}>札</button>
        <button type="button" onClick={() => onStatsChange?.(snapshot.pushed)}>統計を届ける</button>
        <OutputGainControl />
    </>,
}));

afterEach(() => { cleanup(); snapshot.muted = false; snapshot.outputGain = 1; snapshot.pushed = null; });

const staleStats = (muted: boolean, outputGain: number): EngineRuntimeStats => runtimeWith({ muted, outputGain });
const shell = (page: AppPage) => <AppShell page={page} onOpenOBSSettings={vi.fn()} onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
    onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
    currentHost="WASAPI" currentInput="Mic" currentOutput="Out" isEngineRunning engineProcessReady><p>rack</p></AppShell>;
const renderShell = (page: AppPage = 'home') => render(shell(page));
const jump = () => { fireEvent.click(screen.getByRole('button', { name: '札' })); };
const slider = () => document.querySelector<HTMLElement>('#master-output-gain [role="slider"]');

it('前提：緊急ミュートも音量ゼロも、準備の観測ではミュート・音量ゼロになる', () => {
    expect(buildPreparationObservation(audioState, staleStats(true, 1), liveStatus, context).availability).toBe('muted');
    expect(buildPreparationObservation(audioState, staleStats(false, 0), liveStatus, context).availability).toBe('muted');
});

it.each([
    { name: '右の列の統計が未取得', pushed: null },
    { name: '右の列の統計が古い値（ミュートでなく音量1）', pushed: staleStats(false, 1) },
])('音量ゼロの札は、$name でも出力音量へ移る', ({ pushed }) => {
    snapshot.outputGain = 0;
    renderShell();
    if (pushed) { snapshot.pushed = pushed; fireEvent.click(screen.getByRole('button', { name: '統計を届ける' })); }
    jump();
    expect(slider()).toHaveFocus();
    expect(document.getElementById('emergency-mute')).not.toHaveFocus();
});

it.each([
    { name: '右の列の統計が未取得', pushed: null },
    { name: '右の列の統計が古い値（ミュートでなく音量ゼロ）', pushed: staleStats(false, 0) },
])('緊急ミュートの札は、$name でも緊急ミュートの解除へ移る', ({ pushed }) => {
    snapshot.muted = true;
    renderShell();
    if (pushed) { snapshot.pushed = pushed; fireEvent.click(screen.getByRole('button', { name: '統計を届ける' })); }
    jump();
    expect(document.getElementById('emergency-mute')).toHaveFocus();
    expect(slider()).not.toHaveFocus();
});

it('緊急ミュートと音量ゼロが同時のときは、緊急ミュートの解除を先にする', () => {
    snapshot.muted = true;
    snapshot.outputGain = 0;
    renderShell();
    jump();
    expect(document.getElementById('emergency-mute')).toHaveFocus();
});

it('移動先は札を描いたのと同じスナップショットで決まり、原因が変われば移動先も変わる', () => {
    snapshot.outputGain = 0;
    const view = renderShell();
    jump();
    expect(slider()).toHaveFocus();
    snapshot.outputGain = 1;
    snapshot.muted = true;
    act(() => { view.rerender(shell('home')); });
    jump();
    expect(document.getElementById('emergency-mute')).toHaveFocus();
});

// ホーム以外のページには LiveStrip が無い。右の列の見えない通知の領域が、同じ状態を伝える（#766）。
const column = () => screen.getByRole('complementary', { name: '本番中の操作' });
const announcement = () => column().querySelector<HTMLElement>('[role="status"].sr-only');
const strip = () => screen.queryByRole('region', { name: 'いまの状態' });

it.each(['sound', 'vst', 'connect', 'settings'] as const)('ホーム以外のページ（%s）で音量ゼロになると、右の列の通知の領域に文が入り、解除すると消える', page => {
    const view = renderShell(page);
    const region = announcement();
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
    expect(strip()).not.toBeInTheDocument();
    snapshot.outputGain = 0;
    act(() => { view.rerender(shell(page)); });
    // 内容が変わる前から存在していた同じ領域に入る。
    expect(announcement()).toBe(region);
    expect(region).toHaveTextContent('出力ミュート・音量ゼロ');
    snapshot.outputGain = 1;
    act(() => { view.rerender(shell(page)); });
    expect(announcement()).toBe(region);
    expect(region).toBeEmptyDOMElement();
});

it('緊急ミュートでも、ホーム以外のページでは右の列の通知の領域に文が入る', () => {
    snapshot.muted = true;
    renderShell('sound');
    expect(announcement()).toHaveTextContent('出力ミュート・音量ゼロ');
});

it('ホームでは右の列の通知の領域は空で、「音を送っていません」の通知だけになる', () => {
    const view = renderShell('home');
    const region = announcement();
    expect(region).toBeEmptyDOMElement();
    snapshot.outputGain = 0;
    act(() => { view.rerender(shell('home')); });
    expect(announcement()).toBe(region);
    expect(region).toBeEmptyDOMElement();
    const live = screen.getAllByRole('status').filter(node => /音を送っていません|出力ミュート・音量ゼロ/.test(node.textContent ?? ''));
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent('音を送っていません');
    expect(strip()).toContainElement(live[0]);
});

it('ホームからほかのページへ移ると、通知は領域に移り、二重にならない', () => {
    snapshot.outputGain = 0;
    const view = renderShell('home');
    const region = announcement();
    expect(region).toBeEmptyDOMElement();
    act(() => { view.rerender(shell('sound')); });
    expect(announcement()).toBe(region);
    expect(region).toHaveTextContent('出力ミュート・音量ゼロ');
    expect(screen.getAllByRole('status').filter(node => /音を送っていません|出力ミュート・音量ゼロ/.test(node.textContent ?? ''))).toHaveLength(1);
});
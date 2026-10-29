import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EngineRuntimeStats } from '@/api/audio';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { createLocaleStore } from '@/i18n/locale';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { message } from '@/i18n/messages';
import { RuntimeStatsContext } from '@/components/layout/RuntimeStatsContext';
import { SoundChain } from '../SoundChain';
import { VstChainItems } from '../VstChainItems';

vi.mock('../VoiceQuickControls', () => ({
    useVoiceQuick: (_running: boolean, enabled: boolean) => ({ stats: enabled ? {} : null }),
    NoiseSwitch: () => <span>noise-switch</span>, NoiseQuick: () => <span>noise-quick</span>,
    BuiltinSwitch: () => <span>builtin-switch</span>, BuiltinQuick: () => <span>builtin-quick</span>,
}));

const stats = (): EngineRuntimeStats => ({ queueDiagnostics: { state: 'running', epoch: 'stream1' }, latencyMetadata: {
    schemaVersion: 1, streamRunning: true, processingContext: 'monitor', stageBreakdown: {
        schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: 'stream1',
        nr: { enabled: true }, builtinVoiceEnabled: false, builtinReverbEnabled: true, globalBypass: false,
        vst: [{ id: 'one', name: 'EQ', state: 'active', declaredSamples: 0 }],
    },
} } as unknown as EngineRuntimeStats);
const model = (): PreparationModel => ({ context: { ...context, usage: 'obs' }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });
const props = () => ({ model: model(), audioReady: false, isEngineRunning: true, listenOpen: false, onListen: vi.fn(), onListenClose: vi.fn(),
    onOpenSettings: vi.fn(), onOpenOBSSettings: vi.fn(), onOpenSoundSettings: vi.fn(), onOpenVst: vi.fn() });
afterEach(() => { cleanup(); localStorage.clear(); });

it.each(['ja', 'en'] as const)('5段を固定順に並べ、操作できない間は各段の設定状態を表示する (%s)', locale => {
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}>
        <SoundChain {...props()} />
    </RuntimeStatsContext.Provider></LocaleProvider>);
    const chain = screen.getByRole('list', { name: message(locale, 'flow.title') });
    const rows = within(chain).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    const labels = locale === 'ja' ? ['入力', 'ノイズ低減', '内蔵ボイスチェーン', 'VST', '出力先'] : ['Input', 'Noise reduction', 'Built-in voice chain', 'VST', 'Output'];
    labels.forEach((label, i) => expect(rows[i]).toHaveTextContent(label));
    expect(rows[1]).toHaveTextContent(message(locale, 'flow.enabled'));
    expect(rows[2]).toHaveTextContent(message(locale, 'flow.partial'));
    expect(rows[2]).toHaveTextContent(message(locale, 'flow.builtinParts', { voice: message(locale, 'flow.disabled'), reverb: message(locale, 'flow.enabled') }));
    // 範囲の説明は常設せず、見出し横の情報ボタンから読む。
    expect(screen.queryByText(message(locale, 'flow.scope'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'flow.info') }));
    expect(screen.getByRole('dialog')).toHaveTextContent(message(locale, 'flow.scope'));
    expect(screen.getByRole('dialog')).toHaveTextContent(message(locale, 'flow.monitorPath'));
});

it('音声処理中は声の段にその場の操作を出し、設定状態の文字は重ねない', () => {
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider>);
    const rows = screen.getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('noise-switch'); expect(rows[1]).toHaveTextContent('noise-quick');
    expect(rows[1]).not.toHaveTextContent('設定 ON');
    expect(rows[2]).toHaveTextContent('builtin-switch'); expect(rows[2]).toHaveTextContent('builtin-quick');
    expect(screen.queryByText(message('ja', 'home.soundAfterSetup'))).not.toBeInTheDocument();
});

it('音楽鑑賞では声向けの操作を出さず、状態の表示にとどめる', () => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider>);
    expect(screen.getByRole('region', { name: '音を整える' })).toBeInTheDocument();
    expect(screen.queryByText('noise-quick')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OBS連携' })).not.toBeInTheDocument();
    // 声の処理の設定へは誘導せず、VST 構成で整えることを常に見える文で示す。
    expect(screen.queryByRole('button', { name: '詳しく調整' })).not.toBeInTheDocument();
    expect(screen.getByText(message('ja', 'music.soundHint'))).toBeVisible();
});

it('現在の世代と不一致または停止時は処理の設定を OFF と推測しない', () => {
    const stale = stats(); stale.queueDiagnostics!.epoch = 'other';
    const view = render(<RuntimeStatsContext.Provider value={{ stats: stale, running: true }}><SoundChain {...props()} /></RuntimeStatsContext.Provider>);
    const rows = screen.getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('未確認'); expect(rows[2]).toHaveTextContent('未確認'); expect(rows[3]).toHaveTextContent('未確認');
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: stats(), running: false }}><SoundChain {...props()} /></RuntimeStatsContext.Provider>);
    expect(screen.queryByText('設定 OFF')).not.toBeInTheDocument();
});

it('入力・出力は機器の設定、VSTの一覧は VST 構成を開き、見出しから聴き比べと詳しい調整へ進める', () => {
    const p = props();
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...p} audioReady vst={<span>vst-items</span>} /></RuntimeStatsContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: '入力 稼働中' }));
    fireEvent.click(screen.getByRole('button', { name: '出力先 稼働中' }));
    expect(p.onOpenSettings).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '一覧' })); expect(p.onOpenVst).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('listitem')[3]).toHaveTextContent('vst-items');
    fireEvent.click(screen.getByRole('button', { name: '録音して聴き比べる' })); expect(p.onListen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'OBS連携' })); expect(p.onOpenOBSSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '詳しく調整' })); expect(p.onOpenSoundSettings).toHaveBeenCalledOnce();
});

it('VST段は押してオン・オフし、エディタは有効なときだけアイコンから開く', () => {
    const toggle = vi.fn(); const edit = vi.fn(); const add = vi.fn();
    const plugin = { path: '', vendor: '', version: '', gain: 1 };
    render(<VstChainItems plugins={[{ ...plugin, id: 'a', name: 'EQ', enabled: true, hasEditor: true, muted: true }, { ...plugin, id: 'b', name: 'Gate', enabled: false, hasEditor: true, muted: false }]}
        onToggle={toggle} onEdit={edit} onAdd={add} />);
    const eq = screen.getByRole('button', { name: /^EQ\s*ミュート中$/ });
    expect(eq).toHaveAttribute('aria-pressed', 'true');
    expect(eq).toHaveTextContent('ミュート中');
    fireEvent.click(eq); expect(toggle).toHaveBeenCalledWith('a', false);
    fireEvent.click(screen.getByRole('button', { name: 'Gate' })); expect(toggle).toHaveBeenLastCalledWith('b', true);
    fireEvent.click(screen.getByRole('button', { name: 'EQの画面を開く' })); expect(edit).toHaveBeenCalledWith('a');
    expect(screen.getByRole('button', { name: 'Gateの画面を開く' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '追加' })); expect(add).toHaveBeenCalledOnce();
});

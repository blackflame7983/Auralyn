import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EngineRuntimeStats } from '@/api/audio';
import { createLocaleStore } from '@/i18n/locale';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { RuntimeStatsContext } from '@/components/layout/RuntimeStatsContext';
import { SignalFlow } from '../SignalFlow';

const stats = (): EngineRuntimeStats => ({ queueDiagnostics: { state: 'running', epoch: 'stream1' }, latencyMetadata: {
    schemaVersion: 1, streamRunning: true, processingContext: 'monitor', stageBreakdown: {
        schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: 'stream1',
        nr: { enabled: true }, builtinVoiceEnabled: false, builtinReverbEnabled: true, globalBypass: false,
        vst: [{ id: 'one', name: 'EQ', state: 'active', declaredSamples: 0 }],
    },
} } as unknown as EngineRuntimeStats);
afterEach(cleanup);

it.each(['ja', 'en'] as const)('両言語で5段を固定順にし、現在の設定と枝の範囲を表示する (%s)', locale => {
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SignalFlow /></RuntimeStatsContext.Provider></LocaleProvider>);
    const flow = screen.getByRole('region', { name: locale === 'ja' ? '音の流れ' : 'Signal flow' });
    const rows = within(flow).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    const labels = locale === 'ja' ? ['入力', 'ノイズ低減', '内蔵ボイスチェーン', 'VST', '出力先'] : ['Input', 'Noise reduction', 'Built-in voice chain', 'VST', 'Output'];
    labels.forEach((label, i) => expect(rows[i]).toHaveTextContent(label));
    expect(rows[1]).toHaveTextContent(locale === 'ja' ? '設定 ON' : 'Configured ON');
    expect(rows[2]).toHaveTextContent(locale === 'ja' ? '設定 一部ON' : 'Partly configured ON');
    expect(flow).toHaveTextContent(locale === 'ja' ? '自分用と配信側を分離すると経路が分かれます' : 'Monitor and broadcast paths can split');
});

it('現在の世代と不一致または停止時は処理の設定を OFF と推測しない', () => {
    const stale = stats(); stale.queueDiagnostics!.epoch = 'other';
    const view = render(<RuntimeStatsContext.Provider value={{ stats: stale, running: true }}><SignalFlow /></RuntimeStatsContext.Provider>);
    const rows = screen.getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('未確認'); expect(rows[2]).toHaveTextContent('未確認'); expect(rows[3]).toHaveTextContent('未確認');
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: stats(), running: false }}><SignalFlow /></RuntimeStatsContext.Provider>);
    expect(screen.queryByText('設定 OFF')).not.toBeInTheDocument();
});

it('各段は音声を切り替えず対応する調整先を開き、内蔵の内訳がある', () => {
    const actions = Array.from({length: 5}, () => vi.fn());
    render(<RuntimeStatsContext.Provider value={{stats: stats(), running: true}}><SignalFlow onInput={actions[0]} onNoise={actions[1]} onBuiltin={actions[2]} onVst={actions[3]} onOutput={actions[4]} /></RuntimeStatsContext.Provider>);
    const buttons = screen.getAllByRole('listitem').map(row => within(row).getByRole('button'));
    buttons.forEach((button, index) => { fireEvent.click(button); expect(actions[index]).toHaveBeenCalledOnce(); });
    expect(buttons[2]).toHaveAttribute('title', expect.stringContaining('残響: 設定 ON'));
});

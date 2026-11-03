import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { ProcessInputPanel } from '../ProcessInputPanel';
import { MixingDiagnostics } from '../MixingDiagnostics';
import { MixingConfigurationDiff } from '@/components/features/Presets/MixingConfigurationDiff';
import { mixingApi } from '@/api/mixing';
import { postMixApi } from '@/api/postMix';
import type { BundleMixingSummary } from '@/api/bundles';
import { MixingError, framesToMs } from '../mixingUi';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const English = ({ children }: { children: React.ReactNode }) => <LocaleProvider store={createLocaleStore(() => 'en', () => true)}>{children}</LocaleProvider>;
it('アプリ入力の見出し・状態・説明・選択肢を英語にし、声用マイクでは用途説明を隠す', () => {
    const view = render(<English><ProcessInputPanel value={{ source: { kind: 'process_loopback', config: { appKey: 'app', appName: '', rawEndpointId: '', purpose: 'music' } } }} onChange={vi.fn()} disabled={false} isAsio={false} status={{ failed: false, waitingForAudio: true }} /></English>);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for application audio.'); expect(document.body.textContent).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    view.rerender(<English><ProcessInputPanel value={{ source: { kind: 'device', config: { purpose: 'voice' } } }} onChange={vi.fn()} disabled={false} isAsio={false} /></English>);
    expect(screen.queryByText(/Comparison uses/)).not.toBeInTheDocument();
});
it('フレームは実際のrateがある場合だけmsへ変換する', () => {
    expect(framesToMs(480, 48000)).toBe('10.0 ms'); expect(framesToMs(441, 44100)).toBe('10.0 ms'); expect(framesToMs(0, 48000)).toBe('0.0 ms'); expect(framesToMs(2048, null)).toBeNull();
});
it.each([['missing plugin', 'not found'], ['corrupt saved state', 'could not be read'], ['stale revision', 'another operation'], ['unsupported', 'not supported']])('英語の操作エラー %s を分類し、原文を詳細で保持する', (raw, cause) => {
    render(<English><MixingError error={{ operation: 'mixingUi.levels', raw }} /></English>); expect(screen.getByRole('alert')).toHaveTextContent(cause);
    expect(screen.getByText(raw).closest('details')).not.toHaveAttribute('open'); fireEvent.click(screen.getByText('Details')); expect(screen.getByText(raw)).toBeVisible();
});
it('ミックス差分を項目とVST順ごとに英語で表示し、欠落を警告する', () => {
    const before: BundleMixingSummary = { input: null, postMix: { enabled: false, plugins: [] } };
    const after: BundleMixingSummary = { input: { version: 1, source: { kind: 'device', config: { host: 'WASAPI', inputId: 'music', inputChannels: [0, 1] } }, levels: { voice: { gain: 1, muted: false }, accompaniment: { gain: 0.5, muted: true }, offsetMs: 20, monitorAccompaniment: true } }, postMix: { enabled: true, plugins: [{ name: 'EQ', path: 'eq', vendor: '', version: '', enabled: true, muted: false, gain: 0 }] } };
    render(<English><MixingConfigurationDiff mixing={{ before, after, missingDevices: [], missingPlugins: ['EQ', 'VoiceComp'], pluginStateChanged: true }} /></English>);
    const table = screen.getByRole('table'); expect(within(table).getByRole('row', { name: /Accompaniment volume/ })).toHaveTextContent('50%'); expect(within(table).getByRole('row', { name: /Broadcast VST 1/ })).toHaveTextContent('0%');
    expect(screen.getByRole('alert')).toHaveTextContent('EQ'); expect(screen.getByRole('alert')).not.toHaveTextContent('VoiceComp'); expect(document.body.textContent).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
});
it('診断を開いた間だけ実際の診断値を読み、0を未取得と混同しない', async () => {
    const mixing = vi.spyOn(mixingApi, 'request').mockResolvedValue({ accompaniment: { capturedFrames: 100, nonzeroFrames: 20, queuedFrames: 0, correctionPpm: 15, discontinuities: 1, timestampErrors: 2, nonfiniteSamples: 3, waitingDiscardedFrames: 4 }, primaryClock: { queuedFrames: 5, correctionPpm: -1, underruns: 0 }, knownVoiceProcessingFrames: 480 } as any);
    vi.spyOn(postMixApi, 'request').mockResolvedValue({ attached: true, ready: true, failed: false, processedPackets: 42, sampleRate: 48000, transportLatencyFrames: 2048, declaredPluginLatencyFrames: 0 } as any);
    const view = render(<MixingDiagnostics open={false} />); expect(mixing).not.toHaveBeenCalled(); view.rerender(<MixingDiagnostics open />);
    await waitFor(() => expect(screen.getByRole('row', { name: /処理済みパケット数/ })).toHaveTextContent('42')); expect(screen.getByRole('row', { name: /主入力の音声不足/ })).toHaveTextContent('0');
    view.rerender(<MixingDiagnostics open={false} />); const calls = mixing.mock.calls.length; await act(async () => {}); expect(mixing).toHaveBeenCalledTimes(calls);
});

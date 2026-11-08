import { useEffect, useState } from 'react';
import { audioApi, type AudioStateInfo, type EngineRuntimeStats, type RoundTripConditions, type RoundTripSnapshot } from '@/api/audio';
import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

const REASONS: Record<string, MessageKey> = {
    no_signal: 'roundTrip.reason.noSignal',
    clipped: 'roundTrip.reason.clipped',
    truncated: 'roundTrip.reason.truncated',
    multiple_peaks: 'roundTrip.reason.multiplePeaks',
    low_snr: 'roundTrip.reason.lowSnr',
    out_of_range: 'roundTrip.reason.outOfRange',
    cancelled: 'roundTrip.reason.cancelled',
    timeout: 'roundTrip.reason.timeout',
    muted: 'roundTrip.reason.muted',
    input_changed: 'roundTrip.reason.inputChanged',
    stopped: 'roundTrip.reason.stopped',
    busy: 'roundTrip.reason.busy',
    not_running: 'roundTrip.reason.notRunning',
    stream_failed: 'roundTrip.reason.streamFailed',
    process_input: 'roundTrip.reason.processInput',
    split_output: 'roundTrip.reason.splitOutput',
    rate_mismatch: 'roundTrip.reason.rateMismatch',
    test_tone: 'roundTrip.reason.testTone',
    voice_check: 'roundTrip.reason.voiceCheck',
    recording: 'roundTrip.reason.recording',
    loudness: 'roundTrip.reason.loudness',
    auto_gain: 'roundTrip.reason.autoGain',
};

const REMEDIES: Record<string, MessageKey> = {
    no_signal: 'roundTrip.remedy.noSignal',
    clipped: 'roundTrip.remedy.clipped',
    truncated: 'roundTrip.remedy.truncated',
    multiple_peaks: 'roundTrip.remedy.multiplePeaks',
    low_snr: 'roundTrip.remedy.lowSnr',
    out_of_range: 'roundTrip.remedy.outOfRange',
    cancelled: 'roundTrip.remedy.cancelled',
    timeout: 'roundTrip.remedy.timeout',
    muted: 'roundTrip.remedy.muted',
    input_changed: 'roundTrip.remedy.inputChanged',
    stopped: 'roundTrip.remedy.stopped',
    busy: 'roundTrip.remedy.busy',
    not_running: 'roundTrip.remedy.notRunning',
    stream_failed: 'roundTrip.remedy.streamFailed',
    process_input: 'roundTrip.remedy.processInput',
    split_output: 'roundTrip.remedy.splitOutput',
    rate_mismatch: 'roundTrip.remedy.rateMismatch',
    test_tone: 'roundTrip.remedy.testTone',
    voice_check: 'roundTrip.remedy.voiceCheck',
    recording: 'roundTrip.remedy.recording',
    loudness: 'roundTrip.remedy.loudness',
    auto_gain: 'roundTrip.remedy.autoGain',
};

export function deviceIdentity(id?: string | null, name?: string | null): string {
    const trimmed = id?.trim();
    if (trimmed) return trimmed;
    const named = name?.trim();
    return named ? `name:${named}` : 'unknown';
}

export function conditionsMatch(saved: RoundTripConditions, current: RoundTripConditions): boolean {
    return saved.outputDeviceId === current.outputDeviceId
        && saved.inputDeviceId === current.inputDeviceId
        && saved.inputChannel === current.inputChannel
        && saved.inputChannelRight === current.inputChannelRight
        && saved.inputMixed === current.inputMixed
        && saved.sampleRate === current.sampleRate
        && saved.bufferSize === current.bufferSize
        && saved.engineEpoch === current.engineEpoch;
}

export function currentRoundTripConditions(
    stats: EngineRuntimeStats | null | undefined,
    audio: AudioStateInfo | null,
    isRunning: boolean,
): RoundTripConditions | null {
    const metadata = stats?.latencyMetadata;
    const channels = stats?.preparation?.inputChannels;
    const epoch = stats?.queueDiagnostics?.epoch;
    const config = audio?.config;
    if (!isRunning || !audio?.is_running || !config || !channels || !epoch) return null;
    if (metadata?.schemaVersion !== 1 || !metadata.streamRunning || !metadata.nominalSampleRateHz) return null;
    const [left, right] = channels;
    return {
        outputDeviceId: deviceIdentity(config.output_id, config.output),
        inputDeviceId: deviceIdentity(config.input_id, config.input),
        inputChannel: left,
        inputChannelRight: right,
        inputMixed: left !== right,
        sampleRate: metadata.nominalSampleRateHz,
        bufferSize: metadata.fixedBufferRequestFrames ?? 0,
        engineEpoch: epoch,
    };
}

function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error && error.message) return error.message;
    return 'stopped';
}

function oneDecimal(value: number): string {
    return value.toFixed(1);
}

export function RoundTripMeasureView({
    snapshot,
    error,
    busy,
    current,
    declaredMs,
    onStart,
    onCancel,
}: {
    snapshot: RoundTripSnapshot | null;
    error: string | null;
    busy: boolean;
    current: RoundTripConditions | null;
    declaredMs: number | null;
    onStart: () => void;
    onCancel: () => void;
}) {
    const t = useMessages();
    const running = snapshot?.phase === 'running';
    const result = snapshot?.phase === 'done' ? snapshot.result : null;
    const fresh = result?.kind === 'success' && current !== null && conditionsMatch(result.conditions, current);
    const reasonCode = error ?? result?.reason ?? null;
    const reasonKey = reasonCode ? REASONS[reasonCode] ?? 'roundTrip.reason.unknown' : null;
    const remedyKey = reasonCode ? REMEDIES[reasonCode] ?? 'roundTrip.remedy.unknown' : null;
    const delay = result?.kind === 'success' && typeof result.delayMs === 'number' && Number.isFinite(result.delayMs)
        ? result.delayMs
        : null;
    const resolution = result?.kind === 'success' && typeof result.resolutionMs === 'number' && Number.isFinite(result.resolutionMs)
        ? result.resolutionMs
        : null;
    return <section aria-label={t('roundTrip.title')} className="space-y-2 border-t border-border pt-3">
        <h4 className="font-semibold">{t('roundTrip.title')}</h4>
        <p className="text-ui-support text-muted-foreground">{t('roundTrip.warning')}</p>
        <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onStart} disabled={busy || running}>{t('roundTrip.start')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={!running}>{t('roundTrip.cancel')}</Button>
        </div>
        {running && <p className="text-ui-support">{t('roundTrip.running', { progress: Math.round((snapshot?.progress ?? 0) * 100) })}</p>}
        {delay !== null && resolution !== null && result && <div className="space-y-1 text-ui-support" data-current={fresh ? 'true' : 'false'}>
            <p>{t('roundTrip.measured', { ms: oneDecimal(delay), resolution: oneDecimal(resolution) })}</p>
            <p>{result.inverted ? t('roundTrip.polarityInverted') : t('roundTrip.polarityNormal')}</p>
            {typeof result.confidence === 'number' && Number.isFinite(result.confidence) && <p>{t('roundTrip.confidence', { value: result.confidence.toFixed(2) })}</p>}
            <p className="text-ui-support text-muted-foreground">{t('roundTrip.route', {
                rate: result.conditions.sampleRate.toLocaleString(),
                buffer: result.conditions.bufferSize === 0 ? t('roundTrip.bufferDefault') : t('roundTrip.bufferFrames', { frames: result.conditions.bufferSize }),
                channel: result.conditions.inputMixed
                    ? t('roundTrip.channelMixed', { left: result.conditions.inputChannel + 1, right: result.conditions.inputChannelRight + 1 })
                    : t('roundTrip.channelOne', { channel: result.conditions.inputChannel + 1 }),
            })}</p>
            {!fresh && <p>{current ? t('roundTrip.stale') : t('roundTrip.notCurrent')}</p>}
        </div>}
        {result && result.kind !== 'success' && reasonKey && remedyKey && <div className="space-y-1 text-ui-support">
            <p>{t(result.kind === 'uncertain' ? 'roundTrip.uncertain' : 'roundTrip.failed', { reason: t(reasonKey) })}</p>
            <p>{t(remedyKey)}</p>
        </div>}
        {!result && error && reasonKey && remedyKey && <div className="space-y-1 text-ui-support">
            <p>{t('roundTrip.failed', { reason: t(reasonKey) })}</p>
            <p>{t(remedyKey)}</p>
        </div>}
        {declaredMs !== null && <p className="text-ui-support text-muted-foreground">{t('roundTrip.declared', { ms: oneDecimal(declaredMs) })}</p>}
        <p className="text-ui-support text-muted-foreground">{t('roundTrip.notOneWay')} {t('roundTrip.noApply')}</p>
    </section>;
}

export function RoundTripMeasure({
    stats,
    isRunning,
    declaredMs,
}: {
    stats?: EngineRuntimeStats | null;
    isRunning: boolean;
    declaredMs: number | null;
}) {
    const [snapshot, setSnapshot] = useState<RoundTripSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [audio, setAudio] = useState<AudioStateInfo | null>(null);
    useEffect(() => {
        if (snapshot?.phase !== 'running') return undefined;
        let stopped = false;
        const remember = (next: RoundTripSnapshot) => {
            if (stopped) return;
            setSnapshot(next);
            if (next.phase === 'done' && next.result) {
                audioApi.getAudioState().then((state) => {
                    if (!stopped) setAudio(state);
                }).catch(() => {
                    if (!stopped) setAudio(null);
                });
            }
        };
        const tick = () => {
            audioApi.getRoundTripMeasurement().then(remember).catch((reason) => {
                if (!stopped) setError(errorText(reason));
            });
        };
        const id = window.setInterval(tick, 250);
        return () => {
            stopped = true;
            window.clearInterval(id);
        };
    }, [snapshot?.phase]);
    const start = () => {
        setBusy(true);
        setError(null);
        audioApi.measureRoundTrip().then((next) => {
            setSnapshot(next);
            setBusy(false);
        }).catch((reason) => {
            setError(errorText(reason));
            setBusy(false);
        });
    };
    const cancel = () => {
        audioApi.cancelRoundTripMeasurement().then((next) => {
            setSnapshot(next);
        }).catch((reason) => {
            setError(errorText(reason));
        });
    };
    return <RoundTripMeasureView
        snapshot={snapshot}
        error={error}
        busy={busy}
        current={currentRoundTripConditions(stats, audio, isRunning)}
        declaredMs={declaredMs}
        onStart={start}
        onCancel={cancel}
    />;
}

export function roundTripDeclaredMs(stats: EngineRuntimeStats | null | undefined, current: boolean): number | null {
    const value = stats?.totalChainLatencyMs;
    return current && typeof value === 'number' && Number.isFinite(value) ? value : null;
}

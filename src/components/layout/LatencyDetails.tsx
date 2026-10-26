import { useMessages } from '@/i18n/LocaleProvider';
import type { EngineRuntimeStats } from '@/api/audio';
import { LatencyStageDetails } from './LatencyStageDetails';
import { FrameTimingDetails } from './FrameTimingDetails';
import { ResamplerCohortTimingDetails } from './ResamplerCohortTimingDetails';
import { ResamplerBatchTimingDetails } from './ResamplerBatchTimingDetails';

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;


export function LatencyDetails({ stats, isRunning = true }: { stats?: EngineRuntimeStats | null; isRunning?: boolean }) {
    const t = useMessages();
    const oneFrame = (samples: unknown, rate: unknown, allowZero = false) => {
        if (!nonnegative(samples) || (!allowZero && samples === 0)) return t('latency.unknown');
        return positive(rate) ? `${samples} sample / ${(samples / rate * 1000).toFixed(2)} ms` : t('latency.samplesUnknownDuration', { arg0: samples });
    };
    const m = stats?.latencyMetadata;
    const known = m?.schemaVersion === 1;
    const current = isRunning && known && m.streamRunning;
    const monitorCurrent = m?.processingContext === 'broadcastWorker' ? isRunning && stats?.queueDiagnostics?.state === 'running' : !!current;
    const callback = m?.processingContext === 'broadcastWorker' ? undefined : stats?.callbackDiagnostics;
    const rows = current ? [
        [t('latency.outputRate'), positive(m.nominalSampleRateHz) ? `${m.nominalSampleRateHz.toLocaleString()} Hz` : t('latency.unknown')],
        [t('latency.requestedBuffer'), m.fixedBufferRequestFrames === null ? t('latency.deviceDefault') : oneFrame(m.fixedBufferRequestFrames, m.nominalSampleRateHz)],
        [t('latency.callbackFrames'), positive(callback?.count) && positive(callback?.minFrames) && positive(callback?.maxFrames)
            ? `${callback.minFrames}〜${callback.maxFrames} frame` : t('latency.unobserved')],
        [t('latency.noiseSetting'), m.nrConfiguredEnabled ? t('latency.noiseConfigured') : 'OFF'],
        [t('latency.noiseFrameLength'), oneFrame(m.nrProcessingFrameSamples, m.nominalSampleRateHz)],
        [t('latency.noiseFrameRate'), positive(m.nrProcessingRateHz) ? `${m.nrProcessingRateHz.toLocaleString()} Hz` : t('latency.unknown')],
        [t('latency.vstReported'), oneFrame(m.vstReportedLatencySamples, m.nominalSampleRateHz, true)],
    ] : [];
    return <section aria-label={t('latency.title')} className="space-y-2">
        <h3 className="font-semibold">{t('latency.title')}</h3>
        {m?.processingContext === 'broadcastWorker' && <p className="text-sm">{t('liveOutput.statsBroadcast')}</p>}
        <p role="status" className="text-sm">{!isRunning || (known && !m.streamRunning) ? t('latency.stopped') : !known ? t('latency.metadataMissing') : t('latency.unmeasured')}</p>
        {rows.length > 0 && <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}</dl>}
        <p className="text-xs text-muted-foreground">{t('latency.limitations')}</p>
        <LatencyStageDetails stats={stats} current={!!current} />
        <FrameTimingDetails snapshot={stats?.frameTiming} current={monitorCurrent} />
        <ResamplerBatchTimingDetails snapshot={stats?.resamplerBatchTiming} current={monitorCurrent} />
        <ResamplerCohortTimingDetails snapshot={stats?.resamplerCohortTiming}
            current={monitorCurrent && stats?.queueDiagnostics?.state === 'running' && stats.queueDiagnostics.epoch === stats.resamplerCohortTiming?.epoch} />
    </section>;
}

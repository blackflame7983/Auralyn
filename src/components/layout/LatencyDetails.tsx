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
        if (!nonnegative(samples) || (!allowZero && samples === 0)) return t('meterBrowser.copy.090');
        return positive(rate) ? `${samples} sample / ${(samples / rate * 1000).toFixed(2)} ms` : t('meterBrowser.copy.091', { arg0: samples });
    };
    const m = stats?.latencyMetadata;
    const known = m?.schemaVersion === 1;
    const current = isRunning && known && m.streamRunning;
    const callback = stats?.callbackDiagnostics;
    const rows = current ? [
        [t('meterBrowser.copy.092'), positive(m.nominalSampleRateHz) ? `${m.nominalSampleRateHz.toLocaleString()} Hz` : t('meterBrowser.copy.093')],
        [t('meterBrowser.copy.094'), m.fixedBufferRequestFrames === null ? t('meterBrowser.copy.095') : oneFrame(m.fixedBufferRequestFrames, m.nominalSampleRateHz)],
        [t('meterBrowser.copy.096'), positive(callback?.count) && positive(callback?.minFrames) && positive(callback?.maxFrames)
            ? `${callback.minFrames}〜${callback.maxFrames} frame` : t('meterBrowser.copy.097')],
        [t('meterBrowser.copy.098'), m.nrConfiguredEnabled ? t('meterBrowser.copy.099') : 'OFF'],
        [t('meterBrowser.copy.100'), oneFrame(m.nrProcessingFrameSamples, m.nominalSampleRateHz)],
        [t('meterBrowser.copy.101'), positive(m.nrProcessingRateHz) ? `${m.nrProcessingRateHz.toLocaleString()} Hz` : t('meterBrowser.copy.102')],
        [t('meterBrowser.copy.103'), oneFrame(m.vstReportedLatencySamples, m.nominalSampleRateHz, true)],
    ] : [];
    return <section aria-label={t('meterBrowser.copy.104')} className="space-y-2">
        <h3 className="font-semibold">{t('meterBrowser.copy.105')}</h3>
        <p role="status" className="text-sm">{!isRunning || (known && !m.streamRunning) ? t('meterBrowser.copy.106') : !known ? t('meterBrowser.copy.107') : t('meterBrowser.copy.108')}</p>
        {rows.length > 0 && <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}</dl>}
        <p className="text-xs text-muted-foreground">{t('meterBrowser.copy.109')}</p>
        <LatencyStageDetails stats={stats} current={!!current} />
        <FrameTimingDetails snapshot={stats?.frameTiming} current={!!current} />
        <ResamplerBatchTimingDetails snapshot={stats?.resamplerBatchTiming} current={!!current} />
        <ResamplerCohortTimingDetails snapshot={stats?.resamplerCohortTiming}
            current={!!current && stats?.queueDiagnostics?.state === 'running' && stats.queueDiagnostics.epoch === stats.resamplerCohortTiming?.epoch} />
    </section>;
}

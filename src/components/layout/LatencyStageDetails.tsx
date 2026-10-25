import type { EngineRuntimeStats } from '@/api/audio';
import { useMessages } from '@/i18n/LocaleProvider';
export function LatencyStageDetails({ stats, current }: { stats?: EngineRuntimeStats | null; current: boolean }) {
    const t = useMessages(); const s = stats?.latencyMetadata?.stageBreakdown;
    const uint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4294967295;
    const available = current && s?.schemaVersion === 1 && s.current && s.queryBasis === 'queriedAtRuntimeStats'
        && typeof s.streamEpoch === 'string' && ((stats?.latencyMetadata?.processingContext === 'broadcastWorker' && s.streamEpoch === stats.latencyMetadata.streamEpoch) || (s.streamEpoch === stats?.queueDiagnostics?.epoch && stats.queueDiagnostics.state === 'running'))
        && typeof s.globalBypass === 'boolean' && typeof s.builtinVoiceEnabled === 'boolean' && typeof s.builtinReverbEnabled === 'boolean'
        && s.builtinSignalDelay === 'unknown' && s.nr?.signalDelay === 'unknown' && s.nr.modelRateHz === 48000 && s.nr.modelFrameSamples === 480
        && Array.isArray(s.vst) && s.vst.length <= 32 && s.vst.every(v => typeof v.id === 'string' && typeof v.name === 'string'
            && ['active', 'bypassed', 'muted', 'unavailable'].includes(v.state) && (v.declaredSamples === null || uint(v.declaredSamples)));
    const n = s?.nr;
    const frameKnown = available && n && uint(n.configuredRateHz) && n.configuredRateHz >= 8000 && n.configuredRateHz <= 384000
        && uint(n.frameSamples) && n.frameSamples === Math.floor((n.configuredRateHz + 50) / 100)
        && typeof n.framePeriodMs === 'number' && Number.isFinite(n.framePeriodMs)
        && Math.abs(n.framePeriodMs - n.frameSamples * 1000 / n.configuredRateHz) < 1e-8;
    return <section aria-label={t('latencyStages.title')} className="space-y-2 text-xs">
        <h3 className="font-semibold">{t('latencyStages.title')}</h3>
        {!available ? <p>{t('latencyStages.unavailable')}</p> : <>
            <p>{t('latencyStages.query')}</p>
            {s.globalBypass && <p>{t('latencyStages.globalBypass')}</p>}
            <ul>{s.vst.map((v, i) => <li key={`${v.id}:${i}`}>
                {v.name}: {t(v.state === 'active' ? 'latencyStages.active' : v.state === 'bypassed' ? 'latencyStages.bypassed' : v.state === 'muted' ? 'latencyStages.muted' : 'latencyStages.unavailable')}
                {' / '}{t('latencyStages.declared', { value: v.declaredSamples === null ? t('latencyStages.unknown') : String(v.declaredSamples) })}
            </li>)}</ul>
            <p>{t('latencyStages.nrFrame', { value: frameKnown ? `${n!.frameSamples} frame / ${n!.configuredRateHz} Hz / ${n!.framePeriodMs!.toFixed(2)} ms` : t('latencyStages.unknown'), state: n?.enabled ? 'ON' : 'OFF' })}</p>
            <p>{t('latencyStages.nrUnknown')}</p>
            <p>{t('latencyStages.builtin', { voice: s.builtinVoiceEnabled ? 'ON' : 'OFF', reverb: s.builtinReverbEnabled ? 'ON' : 'OFF' })}</p>
        </>}
        <p className="text-muted-foreground">{t('latencyStages.limits')}</p>
    </section>;
}

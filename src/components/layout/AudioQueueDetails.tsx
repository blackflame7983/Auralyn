import { useMessages } from '@/i18n/LocaleProvider';
import type { QueueDiagnosticsSnapshot } from '@/api/audio';



export function AudioQueueDetails({ snapshot: q, isRunning }: { snapshot?: QueueDiagnosticsSnapshot | null; isRunning: boolean }) {
    const t = useMessages();
    const count = (value: number) => Number.isFinite(value) && value >= 0 ? value.toLocaleString() : t('meterBrowser.copy.110');
    const frames = (value: number | null) => value === null ? t('meterBrowser.copy.111') : `${count(value)} frame`;
    const duration = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? t('meterBrowser.copy.112', { arg0: value.toFixed(2) }) : t('meterBrowser.copy.113');
    if (!q) return <section aria-label={t('meterBrowser.copy.114')}><h3 className="font-semibold">{t('meterBrowser.copy.115')}</h3><p className="text-sm text-muted-foreground">{t('meterBrowser.copy.116')}</p></section>;
    const current = isRunning && q.state === 'running';
    const state = q.state === 'failed' ? t('meterBrowser.copy.117') : current ? t('meterBrowser.copy.118') : q.state === 'preparing' ? t('meterBrowser.copy.119') : q.state === 'running' ? t('meterBrowser.copy.120') : t('meterBrowser.copy.121');
    const recovery = q.recoveryStatus === 1 ? t('meterBrowser.copy.122')
        : q.recoveryStatus === 2 ? t('meterBrowser.copy.123')
        : t('meterBrowser.copy.124');
    const rows = [
        [t('meterBrowser.copy.125'), q.recoveryStatus == null ? t('meterBrowser.copy.126') : recovery],
        [t('meterBrowser.copy.127'), t('meterBrowser.copy.128', { arg0: q.recoveryCount == null ? t('meterBrowser.copy.129') : count(q.recoveryCount), arg1: q.recoveryDiscardedFrames == null ? t('meterBrowser.copy.130') : count(q.recoveryDiscardedFrames) })],
        [t('meterBrowser.copy.131'), `${frames(q.recoveryTargetFrames ?? null)} / ${frames(q.recoveryHighFrames ?? null)}`],
        [t('meterBrowser.copy.132'), `${count(q.inputRateHz)} / ${count(q.outputRateHz)} Hz`],
        [t('meterBrowser.copy.133'), `${count(q.inputChannels)} / ${count(q.outputChannels)} ch`],
        [t('meterBrowser.copy.134'), current ? `${frames(q.currentFrames)}（${duration(q.currentAudioMs)}）` : t('meterBrowser.copy.135')],
        [t('meterBrowser.copy.136'), current ? t('meterBrowser.copy.137', { arg0: q.currentSlots === null ? t('meterBrowser.copy.138') : count(q.currentSlots), arg1: q.currentPartialSlots === null ? t('meterBrowser.copy.139') : count(q.currentPartialSlots) }) : '—'],
        [t('meterBrowser.copy.140'), `${frames(q.maxObservedFrames)}（${duration(q.maxObservedAudioMs)}）`],
        [t('meterBrowser.copy.141'), t('meterBrowser.copy.142', { arg0: frames(q.capacityFrames), arg1: count(q.capacitySlots), arg2: count(q.capacityRemainderSlots) })],
        [t('meterBrowser.copy.143'), q.queuedFramesAtStop === null ? '—' : t('meterBrowser.copy.144', { arg0: frames(q.queuedFramesAtStop), arg1: q.queuedSlotsAtStop === null ? t('meterBrowser.copy.145') : count(q.queuedSlotsAtStop) })],
        [t('meterBrowser.copy.146'), count(q.receivedInputFrames)],
        [t('meterBrowser.copy.147'), `${count(q.generatedOutputFrames)} / ${count(q.offeredOutputFrames)}`],
        [t('meterBrowser.copy.148'), `${count(q.acceptedOutputFrames)} / ${count(q.droppedOutputFrames)}`],
        [t('meterBrowser.copy.149'), `${count(q.requestedOutputFrames)} / ${count(q.consumedOutputFrames)} / ${count(q.zeroFilledOutputFrames)}`],
        [t('meterBrowser.copy.150'), `${count(q.underflowCallbacks)} / ${count(q.queueReadCallbacks)}`],
    ];
    return <section aria-label={t('meterBrowser.copy.151')} className="space-y-2">
        <h3 className="font-semibold">{t('meterBrowser.copy.152')}</h3>
        <p role="status" className="text-sm">{state}</p>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}</dl>
        <p className="text-xs text-muted-foreground">{t('meterBrowser.copy.153')}</p>
        <p className="break-all text-xs text-muted-foreground">{t('meterBrowser.copy.154')}{q.epoch}</p>
        <p className="text-xs text-muted-foreground">{t('meterBrowser.copy.155')}</p>
        <p className="text-xs text-muted-foreground">{t('meterBrowser.copy.156')}</p>
    </section>;
}

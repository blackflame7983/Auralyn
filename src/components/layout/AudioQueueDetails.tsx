import { useMessages } from '@/i18n/LocaleProvider';
import type { QueueDiagnosticsSnapshot } from '@/api/audio';



export function AudioQueueDetails({ snapshot: q, isRunning }: { snapshot?: QueueDiagnosticsSnapshot | null; isRunning: boolean }) {
    const t = useMessages();
    const count = (value: number) => Number.isFinite(value) && value >= 0 ? value.toLocaleString() : t('audioQueue.unknown');
    const frames = (value: number | null) => value === null ? t('audioQueue.unknown') : `${count(value)} frame`;
    const duration = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? t('audioQueue.durationEquivalent', { arg0: value.toFixed(2) }) : t('audioQueue.durationUnknown');
    if (!q) return <section aria-label={t('audioQueue.title')}><h3 className="font-semibold">{t('audioQueue.title')}</h3><p className="text-sm text-muted-foreground">{t('audioQueue.missing')}</p></section>;
    const current = isRunning && q.state === 'running';
    const state = q.state === 'failed' ? t('audioQueue.failedAttempt') : current ? t('audioQueue.running') : q.state === 'preparing' ? t('audioQueue.starting') : q.state === 'running' ? t('audioQueue.lastRunning') : t('audioQueue.stoppedTotals');
    const recovery = q.recoveryStatus === 1 ? t('audioQueue.unsupportedRecovery')
        : q.recoveryStatus === 2 ? t('audioQueue.recoveryLimit')
        : t('audioQueue.recoveryMonitoring');
    const rows = [
        [t('audioQueue.recovery'), q.recoveryStatus == null ? t('audioQueue.notAvailable') : recovery],
        [t('audioQueue.recoveredFrames'), t('audioQueue.pair', { arg0: q.recoveryCount == null ? t('audioQueue.unknown') : count(q.recoveryCount), arg1: q.recoveryDiscardedFrames == null ? t('audioQueue.unknown') : count(q.recoveryDiscardedFrames) })],
        [t('audioQueue.recoveryThreshold'), `${frames(q.recoveryTargetFrames ?? null)} / ${frames(q.recoveryHighFrames ?? null)}`],
        [t('audioQueue.rates'), `${count(q.inputRateHz)} / ${count(q.outputRateHz)} Hz`],
        [t('audioQueue.channels'), `${count(q.inputChannels)} / ${count(q.outputChannels)} ch`],
        [t('audioQueue.currentFrames'), current ? `${frames(q.currentFrames)}（${duration(q.currentAudioMs)}）` : t('audioQueue.currentUnavailable')],
        [t('audioQueue.publishedSlots'), current ? t('audioQueue.slotCounts', { arg0: q.currentSlots === null ? t('audioQueue.unknown') : count(q.currentSlots), arg1: q.currentPartialSlots === null ? t('audioQueue.unknown') : count(q.currentPartialSlots) }) : '—'],
        [t('audioQueue.maxFrames'), `${frames(q.maxObservedFrames)}（${duration(q.maxObservedAudioMs)}）`],
        [t('audioQueue.capacity'), t('audioQueue.capacitySlots', { arg0: frames(q.capacityFrames), arg1: count(q.capacitySlots), arg2: count(q.capacityRemainderSlots) })],
        [t('audioQueue.stopRemaining'), q.queuedFramesAtStop === null ? '—' : t('audioQueue.remainingSlots', { arg0: frames(q.queuedFramesAtStop), arg1: q.queuedSlotsAtStop === null ? t('audioQueue.unknown') : count(q.queuedSlotsAtStop) })],
        [t('audioQueue.receivedFrames'), count(q.receivedInputFrames)],
        [t('audioQueue.generatedFrames'), `${count(q.generatedOutputFrames)} / ${count(q.offeredOutputFrames)}`],
        [t('audioQueue.acceptedFrames'), `${count(q.acceptedOutputFrames)} / ${count(q.droppedOutputFrames)}`],
        [t('audioQueue.readFrames'), `${count(q.requestedOutputFrames)} / ${count(q.consumedOutputFrames)} / ${count(q.zeroFilledOutputFrames)}`],
        [t('audioQueue.underflows'), `${count(q.underflowCallbacks)} / ${count(q.queueReadCallbacks)}`],
    ];
    return <section aria-label={t('audioQueue.title')} className="space-y-2">
        <h3 className="font-semibold">{t('audioQueue.title')}</h3>
        <p role="status" className="text-sm">{state}</p>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}</dl>
        <p className="text-xs text-muted-foreground">{t('audioQueue.recoveryLimitations')}</p>
        <p className="break-all text-xs text-muted-foreground">{t('audioQueue.epoch')}{q.epoch}</p>
        <p className="text-xs text-muted-foreground">{t('audioQueue.units')}</p>
        <p className="text-xs text-muted-foreground">{t('audioQueue.limitations')}</p>
    </section>;
}

import { Button } from '@/components/ui/button';
import { displayAudioHost } from '@/lib/audioDevices';
import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdBolt, MdClose, MdInfoOutline, MdWarning } from 'react-icons/md';
import { Modal } from '../ui/modal';
import { cn } from '@/lib/utils';
import { type EngineRuntimeStats, type ProcessingHealthSnapshot } from '../../api/audio';
import { SafetyOutput } from './SafetyLevels';
import { invalidateRuntimeStats, useRuntimeStats, useRuntimeStatsUnavailable } from '@/hooks/useRuntimeStats';
import { recentAnomalyWarning } from './processingHealth';
import { AudioQueueDetails } from './AudioQueueDetails';
import { LatencyDetails } from './LatencyDetails';
import { OutputGainControl } from './OutputGainControl';

interface MasterBarProps {
    isRunning?: boolean;
    processReady?: boolean | null;
    host?: string;
    sampleRate?: number;
    bufferSize?: number;
    onStatsChange?: (stats: EngineRuntimeStats | null) => void;
    onOpenVoiceCheck?: () => void;
    onOpenSoundSettings?: () => void;
    onOpenAudioTuning?: () => void;
    /** 出力の上に置く入力欄。 */
    input?: ReactNode;
    /** 比較の下に置く操作ロック。 */
    lock?: ReactNode;
    outputName?: string;
    outputMuted?: boolean;
    onCheckOutput?: (anchor: HTMLButtonElement) => void;
    /** 出力音量と、下端の状態表示のあいだに置く操作。 */
    compare?: ReactNode;
}

export const MasterBar: React.FC<MasterBarProps> = ({ host, sampleRate, bufferSize, isRunning = false, processReady, onStatsChange, onOpenAudioTuning, compare, input, lock, outputName, outputMuted = false, onCheckOutput }) => {
    const t = useMessages();
    const detailsButtonRef = useRef<HTMLButtonElement>(null);
    const stats = useRuntimeStats();
    const statsUnavailable = useRuntimeStatsUnavailable();
    const [eventHealth, setEventHealth] = useState<ProcessingHealthSnapshot | null>(null);
    const eventHealthTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [hasRecentGlitch, setHasRecentGlitch] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const glitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousGlitchCount = useRef<number | null>(null);
    const previousRunning = useRef(isRunning);
    const clearEventHealth = useCallback(() => {
        if (eventHealthTimer.current) clearTimeout(eventHealthTimer.current);
        eventHealthTimer.current = null;
        setEventHealth(null);
    }, []);
    useEffect(() => {
        if (previousRunning.current !== isRunning) invalidateRuntimeStats();
        previousRunning.current = isRunning;
        previousGlitchCount.current = null;
        if (glitchTimer.current) clearTimeout(glitchTimer.current);
        setHasRecentGlitch(false);
    }, [isRunning]);

    useEffect(() => {
        const unlisten = listen('audio-started', () => {
            previousGlitchCount.current = null;
            if (glitchTimer.current) clearTimeout(glitchTimer.current);
            setHasRecentGlitch(false);
            clearEventHealth();
        });
        return () => { void unlisten.then(stop => stop()).catch(() => {}); };
    }, [clearEventHealth]);

    useEffect(() => () => { if (glitchTimer.current) clearTimeout(glitchTimer.current); }, []);

    useEffect(() => {
        let disposed = false;
        const clear = () => { if (!disposed) clearEventHealth(); };
        // 統計が来ない間も、失効と同じ 2.5 秒でイベント由来の停止を残さない。
        const unlistenHealth = listen<ProcessingHealthSnapshot>('audio-processing-health', event => {
            if (disposed) return;
            if (eventHealthTimer.current) clearTimeout(eventHealthTimer.current);
            setEventHealth(event.payload);
            eventHealthTimer.current = setTimeout(clear, 2500);
        });
        const unlistenLifecycle = Promise.all(
            ['audio-stopped', 'audio-error', 'audio-stream-error'].map(name => listen(name, clear)),
        );
        return () => {
            disposed = true;
            if (eventHealthTimer.current) clearTimeout(eventHealthTimer.current);
            void unlistenHealth.then(stop => stop()).catch(() => {});
            void unlistenLifecycle.then(stops => stops.forEach(stop => stop())).catch(() => {});
        };
    }, [clearEventHealth]);
    useEffect(() => { clearEventHealth(); }, [stats, clearEventHealth]);
    useEffect(() => { if (!isRunning) clearEventHealth(); }, [isRunning, clearEventHealth]);
    const health = eventHealth ?? stats?.processingHealth ?? null;
    const processingStalled = isRunning && health?.state === 'stalled';

    useEffect(() => {
        onStatsChange?.(stats);
        if (!stats) { previousGlitchCount.current = null; return; }
        const previous = previousGlitchCount.current;
        if (previous !== null && stats.glitchCount > previous) {
            setHasRecentGlitch(true);
            if (glitchTimer.current) clearTimeout(glitchTimer.current);
            glitchTimer.current = setTimeout(() => setHasRecentGlitch(false), 10000);
        }
        previousGlitchCount.current = stats.glitchCount;
    }, [stats, onStatsChange]);

    const isFxActive = !!stats && !stats.globalBypass && stats.enabledPluginCount > 0;
    const isNoiseConfigured = !!stats?.noiseReductionEnabled;
    const isCleanActive = isNoiseConfigured && !isFxActive;
    const broadcastFailed = isRunning && stats?.latencyMetadata?.broadcastState === 'failed';
    const signalLabel = processReady === null ? t('master.unverified') : !isRunning ? (host ? t('shell.stopped') : t('shell.unconfigured')) : processReady === false ? t('prep.failed') : broadcastFailed ? t('liveOutput.shortFailed') : stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? t('liveOutput.branchLabel') : isFxActive ? t('master.vst') : (isCleanActive ? t('master.nr') : t('master.raw'));

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            {input}
            <SafetyOutput running={isRunning} name={outputName} muted={outputMuted} onCheckOutput={onCheckOutput} />
            <OutputGainControl />
            {compare}
            {lock}
            {/* 状態の表示が重なって列に収まらないときは、ここだけを縦に送る。上の操作は押し出さない。 */}
            {/* 切り抜きでフォーカスの輪が欠けないよう、輪の分の余白を内側に取り、同じ量を外側で打ち消す。 */}
            <div className="-mx-1 -mb-1 mt-auto flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto p-1 scrollbar-thin">
            {processingStalled && <div role="alert" className="flex min-w-0 items-start gap-2 text-ui-support text-warning">
                <MdWarning aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 whitespace-normal break-words">
                    <p>{t('master.processingStalled')}</p>
                    <p>{t('master.processingStalledHint')}</p>
                </div>
            </div>}
            {isRunning && statsUnavailable && <p role="status" className="min-w-0 whitespace-normal break-words text-ui-support">
                <MdInfoOutline aria-hidden="true" className="mr-1 inline h-4 w-4" />{t('master.statsUnavailable')}
            </p>}
            {hasRecentGlitch && <Button variant="ghost" size="sm" type="button" onClick={() => { detailsButtonRef.current?.focus(); setDetailsOpen(true); }} aria-haspopup="dialog" aria-expanded={detailsOpen}
                aria-label={t('master.recentDropout')} title={t('master.recentDropout')}
                className="shrink-0"><MdBolt aria-hidden="true" className="h-4 w-4" /></Button>}
            {hasRecentGlitch && onOpenAudioTuning && <Button variant="outline" size="sm" type="button" onClick={onOpenAudioTuning}
                className="shrink-0">{t('settings.audioTuning.open')}</Button>}

            <Button variant="ghost" size="icon" ref={detailsButtonRef} onClick={() => setDetailsOpen(true)} aria-haspopup="dialog" aria-expanded={detailsOpen}
                aria-label={t('master.details')} title={t('master.details')}
                className="shrink-0">
                <MdInfoOutline aria-hidden="true" className="h-4 w-4" />
            </Button>
            {/* 状態は操作の後に配置し、狭い幅では独立した行へ送る。 */}
            {/* 未設定はヘッダーとホームで示すため、ここでは重ねない。 */}
            {(broadcastFailed || (isRunning && processReady !== true)) && (
                <div className="flex flex-wrap items-center gap-1.5 min-w-0 max-w-full whitespace-normal break-words">
                    <span
                        className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-ui-support font-bold",
                            !isRunning || processReady !== true ? "text-muted-foreground border-border bg-muted" : broadcastFailed ? "text-destructive-text border-destructive-text/50 bg-destructive/10" : "text-success border-success/40 bg-success/10"
                        )}
                    >
                        {signalLabel}
                    </span>
                    {broadcastFailed && <span role="alert" className="sr-only">{t('liveOutput.failed')}</span>}
                </div>
            )}
            {detailsOpen && <Modal title={t('master.detailsTitle')} onClose={() => setDetailsOpen(false)}>
                <div className="modal-overlay-base">
                    <div className="modal-surface-base w-full max-w-md max-h-[calc(90vh/var(--ui-zoom))] flex flex-col whitespace-normal">
                        <div className="modal-header-base gap-3">
                            <h2 className="text-ui-heading font-bold">{t('master.detailsTitle')}</h2>
                            <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={() => setDetailsOpen(false)} className="shrink-0"><MdClose /></Button>
                        </div>
                        <div className="modal-body-base space-y-4">
                            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-ui-support">
                                {[
                                    [t('master.status'), signalLabel],
                                    [t('master.driver'), host ? displayAudioHost(host) : t('master.unset')],
                                    [t('master.rate'), isRunning && sampleRate ? `${sampleRate.toLocaleString()} Hz` : '—'],
                                    [t('master.buffer'), isRunning && bufferSize ? t('master.samples', {frames: bufferSize}) : '—'],
                                    [t('master.vstCount'), isRunning && stats ? t('master.counts', {enabled: stats.enabledPluginCount, total: stats.activePluginCount}) : '—'],
                                    [t('master.glitchTotal'), stats ? String(stats.glitchCount) : '—'],
                                ].map(([label, value]) => <React.Fragment key={label}>
                                    <dt className="text-muted-foreground">{label}</dt><dd className="break-all text-right">{value}</dd>
                                </React.Fragment>)}
                            </dl>
                            <details className="rounded-control border border-border p-3 space-y-3">
                              <summary className="cursor-pointer font-semibold">{t('structure.diagnostics')}</summary>
                            <LatencyDetails stats={stats} isRunning={isRunning} />
                            <AudioQueueDetails snapshot={stats?.queueDiagnostics} isRunning={isRunning} />
                            <div className="space-y-1 text-ui-support">
                                <p>{health ? t('master.recentAnomalies', { window: health.windowSecs, late: health.recentLate, underflow: health.recentUnderflow }) : '—'}</p>
                                <p className="text-muted-foreground">{t('master.recentAnomaliesNote')}</p>
                                {recentAnomalyWarning(health) && <p>{t('master.recentAnomaliesHigh')}</p>}
                            </div>
                            </details>
                        </div>
                    </div>
                </div>
            </Modal>}
            </div>
        </div>
    );
};

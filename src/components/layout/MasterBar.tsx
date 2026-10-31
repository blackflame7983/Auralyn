import { clientErrorNotice, type ClientErrorNotice } from '@/lib/clientError';
import { renderNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdGraphicEq, MdVolumeUp, MdVolumeOff, MdBolt, MdClose, MdInfoOutline } from 'react-icons/md';
import { Modal } from '../ui/modal';
import { cn } from '@/lib/utils';
import { audioApi, EngineRuntimeStats } from '../../api/audio';
import { useSharedMeter } from '../features/LevelMeter/MeterContext';
import { MeterVisual } from '../features/LevelMeter/MeterVisual';
import { Slider } from '@/components/ui/slider';
import * as Popover from '@radix-ui/react-popover';
import { AudioQueueDetails } from './AudioQueueDetails';
import { LatencyDetails } from './LatencyDetails';
import {
    restoreSavedOutputGain,
    readOutputGainStatus,
    setOutputGain as applyOutputGain,
} from '@/api/outputGain';

interface MasterBarProps {
    outputGainAnchor?: HTMLButtonElement | null;
    onOutputGainClose?: () => void;
    isRunning?: boolean;
    processReady?: boolean | null;
    host?: string;
    sampleRate?: number;
    bufferSize?: number;
    onStatsChange?: (stats: EngineRuntimeStats | null) => void;
    onOpenVoiceCheck?: () => void;
    onOpenSoundSettings?: () => void;
}

export const MasterBar: React.FC<MasterBarProps> = ({ host, sampleRate, bufferSize, isRunning = false, processReady, onStatsChange, outputGainAnchor, onOutputGainClose }) => {
    const t = useMessages();
    const meter = useSharedMeter(isRunning, 'output');
    const isClipping = meter.clipped;
    const [stats, setStats] = useState<EngineRuntimeStats | null>(null);
    const [hasRecentGlitch, setHasRecentGlitch] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const glitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousGlitchCount = useRef<number | null>(null);
    const statsGeneration = useRef(0);
    useEffect(() => { statsGeneration.current++; setStats(null); }, [isRunning]);

    // Master output gain (persisted)
    const [outputGain, setOutputGain] = useState<number>(() => {
        const saved = localStorage.getItem('vst_host_output_gain');
        return saved ? parseFloat(saved) : 100;
    });
    const outputGainDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gainRequestGeneration = useRef(0);
    const [gainError, setGainError] = useState<{ notice: ClientErrorNotice; requestedGain: number } | null>(null);
    const [gainRestoreError, setGainRestoreError] = useState<ClientErrorNotice | null>(null);
    const gainMessage = renderNotice(t, gainError?.notice ?? gainRestoreError);
    const lastGainAnchor = useRef<HTMLButtonElement | null>(null);
    const gainDismissedOutside = useRef(false);
    if (outputGainAnchor) lastGainAnchor.current = outputGainAnchor;
    // 幅の変更で入口が隠れた場合は閉じる。音量の同期・適用処理はフッターと共有する。
    useEffect(() => {
        if (!outputGainAnchor) return;
        gainDismissedOutside.current = false;
        const checkAnchor = () => {
            if (!outputGainAnchor.getClientRects().length || outputGainAnchor.closest('[inert]')) onOutputGainClose?.();
        };
        const observer = new ResizeObserver(checkAnchor);
        observer.observe(outputGainAnchor);
        window.addEventListener('resize', checkAnchor);
        return () => { observer.disconnect(); window.removeEventListener('resize', checkAnchor); };
    }, [outputGainAnchor, onOutputGainClose]);

    const handleOutputGainChange = useCallback((values: number[]) => {
        const generation = ++gainRequestGeneration.current;
        setGainError(null);
        window.dispatchEvent(new Event('output-gain-intent'));
        const pct = values[0];
        setOutputGain(pct);
        if (outputGainDebounce.current) clearTimeout(outputGainDebounce.current);
        outputGainDebounce.current = setTimeout(() => {
            // 状態取得で表示が実値へ戻っても、失敗した要求値を再試行できるように残す。
            applyOutputGain(pct / 100).catch((e) => {
                if (generation === gainRequestGeneration.current) setGainError({ notice: clientErrorNotice(e), requestedGain: pct });
            });
        }, 30);
    }, []);

    // reloadは読取だけ。実際の開始通知を受けた時だけ保存gainの初期化を行う。
    useEffect(() => {
        let disposed = false;
        let refreshing = false;
        let applying = false;
        let applyAgain = false;
        let restorePending = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const applyGain = async () => {
            if (disposed) return;
            if (applying) {
                applyAgain = true;
                return;
            }
            applying = true;
            const saved = localStorage.getItem('vst_host_output_gain');
            const pct = saved ? parseFloat(saved) : 100;
            try {
                // 保存音量の初期化は観測に付随する処理。新しいchildは要求しない。
                const process = await audioApi.getAudioState();
                if (disposed) return;
                if (!process.is_running) {
                    restorePending = true;
                    setGainRestoreError(null);
                    return;
                }
                await restoreSavedOutputGain(pct / 100);
                restorePending = false;
                if (!disposed) setGainRestoreError(null);
            } catch (e) {
                restorePending = true;
                if (!disposed) setGainRestoreError(clientErrorNotice(e));
            } finally {
                applying = false;
                if (applyAgain && !disposed) {
                    applyAgain = false;
                    void applyGain();
                }
            }
        };

        const sync = (event: Event) => {
            if (!disposed) setOutputGain((event as CustomEvent<number>).detail);
        };
        window.addEventListener('output-gain-sync', sync);
        const refresh = async () => {
            if (refreshing) return;
            refreshing = true;
            try {
                if (restorePending) await applyGain();
                else {
                    const process = await audioApi.getAudioState();
                    if (disposed || !process.is_running) return;
                    const state = await readOutputGainStatus();
                    if (!disposed && state.settled && !state.streamFailed && Number.isFinite(state.confirmedGain)) {
                        setOutputGain(state.confirmedGain * 100);
                    }
                }
            } catch {
                /* エンジン停止中は保存値を維持する。 */
            } finally {
                refreshing = false;
            }
        };
        // mount直後のstatusはLSへ公開しない。初回bootstrap待ちの保存音量を保持する。
        const unlisten = listen('audio-started', () => {
            void applyGain();
        });
        const initialize = async () => {
            try {
                await unlisten;
                if (disposed) return;
                await refresh();
                if (!disposed) timer = setInterval(() => void refresh(), 1000);
            } catch (e) {
                if (!disposed) setGainRestoreError(clientErrorNotice(e));
            }
        };
        void initialize();

        return () => {
            disposed = true;
            clearInterval(timer);
            window.removeEventListener('output-gain-sync', sync);
            void unlisten.then(f => f()).catch(() => {});
        };
    }, []);

    // Cleanup debounce timer on unmount
    useEffect(() => {
        return () => {
            if (outputGainDebounce.current) clearTimeout(outputGainDebounce.current);
            if (glitchTimer.current) clearTimeout(glitchTimer.current);
        };
    }, []);

    // Poll engine stats frequently for signal state and glitch indication
    useEffect(() => {
        let disposed = false;
        let fetching = false;
        let expiry: ReturnType<typeof setTimeout> | undefined;
        const invalidate = () => { statsGeneration.current++; setStats(null); onStatsChange?.(null); };
        const visibility = () => { if (document.hidden) invalidate(); };
        document.addEventListener('visibilitychange', visibility);
        const stops = ['audio-stopped', 'audio-error', 'audio-stream-error'].map(name => listen(name, invalidate));
        const fetchStats = () => {
            if (fetching || document.hidden) return;
            fetching = true;
            const generation = statsGeneration.current;
            audioApi.getEngineRuntimeStats().then((next) => {
                if (disposed || generation !== statsGeneration.current) return;
                const prev = previousGlitchCount.current;
                if (prev !== null && next.glitchCount > prev) {
                    setHasRecentGlitch(true);
                    if (glitchTimer.current) clearTimeout(glitchTimer.current);
                    glitchTimer.current = setTimeout(() => setHasRecentGlitch(false), 1500);
                }
                previousGlitchCount.current = next.glitchCount;
                setStats(next);
                onStatsChange?.(next);
                clearTimeout(expiry);
                expiry = setTimeout(invalidate, 2500);
            }).catch(() => { if (!disposed && generation === statsGeneration.current) invalidate(); }).finally(() => { fetching = false; });
        };
        fetchStats();
        const interval = setInterval(fetchStats, 1000);
        return () => { disposed = true; clearInterval(interval); clearTimeout(expiry); document.removeEventListener('visibilitychange', visibility); stops.forEach(p => { void p.then(fn => fn()).catch(() => {}); }); };
    }, [onStatsChange]);

    const isFxActive = !!stats && !stats.globalBypass && stats.enabledPluginCount > 0;
    const isNoiseConfigured = !!stats?.noiseReductionEnabled;
    const isCleanActive = isNoiseConfigured && !isFxActive;
    const broadcastFailed = isRunning && stats?.latencyMetadata?.broadcastState === 'failed';
    const signalLabel = processReady === null ? t('master.unverified') : !isRunning ? (host ? t('shell.stopped') : t('shell.unconfigured')) : processReady === false ? t('prep.failed') : broadcastFailed ? t('liveOutput.shortFailed') : stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? t('liveOutput.branchLabel') : isFxActive ? t('master.vst') : (isCleanActive ? t('master.nr') : t('master.raw'));

    return (
        <div className="relative flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-3 py-2 border-l border-border bg-card/30 backdrop-blur-sm transition-colors duration-300 min-w-0">
            <Popover.Root open={Boolean(outputGainAnchor)} onOpenChange={open => { if (!open) onOutputGainClose?.(); }}>
                {outputGainAnchor && <Popover.Anchor virtualRef={{ current: outputGainAnchor }} />}
                <Popover.Portal><Popover.Content aria-label={t('master.outputGain')} side="bottom" align="end" sideOffset={8} collisionPadding={12}
                    onInteractOutside={event => {
                        // 入口の再クリックは親で開閉し、別の操作へ進んだ場合はそのフォーカスを奪わない。
                        if (outputGainAnchor?.contains(event.target as Node)) event.preventDefault();
                        else gainDismissedOutside.current = true;
                    }}
                    onCloseAutoFocus={event => {
                        event.preventDefault();
                        const anchor = lastGainAnchor.current;
                        if (anchor?.closest('[inert]') || document.activeElement?.closest('#vst-panel')) return;
                        if (gainDismissedOutside.current && anchor?.getClientRects().length) return;
                        const target = anchor?.getClientRects().length ? anchor : document.querySelector<HTMLElement>('#master-output-gain [role="slider"]');
                        target?.focus({ preventScroll: true });
                    }} className="z-[200] w-64 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
                    <div className="flex items-center justify-between gap-4 text-sm"><span>{t('master.outputGain')}</span><span className="font-mono tabular-nums">{Math.round(outputGain)}%</span></div>
                    <Slider aria-label={t('master.outputGain')} aria-valuetext={`${Math.round(outputGain)}%`} value={[outputGain]} onValueChange={handleOutputGainChange}
                        min={0} max={200} step={1} onDoubleClick={() => handleOutputGainChange([100])} className="mt-4" />
                    <button type="button" disabled={outputGain === 100} onClick={() => handleOutputGainChange([100])}
                        className="mt-3 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">{t('header.inputGainHint')}</button>
                    {gainMessage && <div className="mt-3 space-y-2"><p role="alert" className="text-xs text-warning">{t('master.gainUnknown')}</p>
                        <button type="button" onClick={() => handleOutputGainChange([gainError?.requestedGain ?? outputGain])} className="rounded-md border border-border px-3 py-1.5 text-xs">{t('common.retry')}</button>
                        <details><summary className="cursor-pointer text-xs">{t('settings.mode.errorDetails')}</summary><p className="mt-2 break-words text-xs text-muted-foreground">{gainMessage}</p></details>
                    </div>}
                </Popover.Content></Popover.Portal>
            </Popover.Root>
            {/* Label */}
            <div className="hidden sm:flex shrink-0 flex-col items-end justify-center min-w-[60px]">
                <div className="flex items-center gap-2 text-muted-foreground font-bold font-mono tracking-widest text-xs">
                    <MdGraphicEq className={cn("w-3 h-3", isClipping ? 'text-destructive-text animate-pulse' : 'text-success')} />
                    {t('meter.output')}
                </div>
            </div>

            {/* Meters */}
            <div className="flex shrink-0 gap-1 h-8 items-end pb-1">
                <MeterVisual reading={meter} label={t('meter.output')} width={12} height={28} showValues />
            </div>

            {/* Master Output Volume */}
            <div className="flex shrink-0 items-center gap-2 border-l border-border pl-3 ml-1">
                {outputGain === 0 ? <MdVolumeOff aria-hidden="true" className="w-4 h-4 text-warning flex-shrink-0" /> : <MdVolumeUp aria-hidden="true" className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                <span aria-hidden="true" className="hidden lg:inline text-xs font-bold text-muted-foreground">{t('master.outputGain')}</span>
                <Slider
                    id="master-output-gain"
                    aria-label={t('master.outputGain')}
                    aria-valuetext={`${outputGain}%`}
                    value={[outputGain]}
                    onValueChange={handleOutputGainChange}
                    min={0}
                    max={200}
                    step={1}
                    className="w-16 md:w-20"
                    onDoubleClick={() => handleOutputGainChange([100])}
                />
                <span className="hidden md:inline text-xs font-mono tabular-nums text-muted-foreground min-w-[32px] text-right">
                    {Math.round(outputGain * 10) / 10}%
                </span>
            </div>

            {hasRecentGlitch && <span role="status" title={t('master.glitch')}><MdBolt aria-hidden="true" className="w-3.5 h-3.5 text-warning" /><span className="sr-only">{t('master.glitch')}</span></span>}

            <button onClick={() => setDetailsOpen(true)} aria-haspopup="dialog" aria-expanded={detailsOpen}
                aria-label={t('master.details')} title={t('master.details')}
                className="shrink-0 rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                <MdInfoOutline aria-hidden="true" className="h-4 w-4" />
            </button>
            {/* 状態は操作の後に配置し、狭い幅では独立した行へ送る。 */}
            {/* 未設定はヘッダーとホームで示すため、ここでは重ねない。 */}
            {(broadcastFailed || (!isRunning && !!host) || (isRunning && processReady !== true)) && (
                <div className="flex basis-full flex-wrap items-center gap-1.5 min-w-0 max-w-full whitespace-normal break-words lg:basis-auto">
                    <span
                        className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold",
                            !isRunning || processReady !== true ? "text-muted-foreground border-border bg-muted" : broadcastFailed ? "text-destructive-text border-destructive/50 bg-destructive/10" : "text-success border-success/40 bg-success/10"
                        )}
                    >
                        {signalLabel}
                    </span>
                    {broadcastFailed && <span role="alert" className="sr-only">{t('liveOutput.failed')}</span>}
                </div>
            )}
            {gainMessage && (
                <span role="alert" className="basis-full min-w-0 whitespace-normal break-words text-xs leading-4 text-warning" title={gainMessage}>
                    {t('master.gainUnknown')}
                </span>
            )}
            {detailsOpen && <Modal title={t('master.detailsTitle')} onClose={() => setDetailsOpen(false)}>
                <div className="modal-overlay-base">
                    <div className="modal-surface-base w-full max-w-md max-h-[90vh] flex flex-col whitespace-normal">
                        <div className="modal-header-base gap-3">
                            <h2 className="text-lg font-bold">{t('master.detailsTitle')}</h2>
                            <button aria-label={t('common.close')} onClick={() => setDetailsOpen(false)} className="shrink-0 rounded p-2 hover:bg-muted"><MdClose /></button>
                        </div>
                        <div className="modal-body-base space-y-4">
                            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                                {[
                                    [t('master.status'), signalLabel],
                                    [t('master.driver'), host || t('master.unset')],
                                    [t('master.rate'), isRunning && sampleRate ? `${sampleRate.toLocaleString()} Hz` : '—'],
                                    [t('master.buffer'), isRunning && bufferSize ? t('master.samples', {frames: bufferSize}) : '—'],
                                    [t('master.vstCount'), isRunning && stats ? t('master.counts', {enabled: stats.enabledPluginCount, total: stats.activePluginCount}) : '—'],
                                ].map(([label, value]) => <React.Fragment key={label}>
                                    <dt className="text-muted-foreground">{label}</dt><dd className="break-all text-right">{value}</dd>
                                </React.Fragment>)}
                            </dl>
                            <details className="rounded border border-border p-3 space-y-3">
                              <summary className="cursor-pointer font-semibold">{t('structure.diagnostics')}</summary>
                            <LatencyDetails stats={stats} isRunning={isRunning} />
                            <AudioQueueDetails snapshot={stats?.queueDiagnostics} isRunning={isRunning} />
                            </details>
                        </div>
                    </div>
                </div>
            </Modal>}
        </div>
    );
};

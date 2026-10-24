import { clientErrorNotice, type ClientErrorNotice } from '@/lib/clientError';
import { renderNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdGraphicEq, MdVolumeUp, MdBolt, MdMic, MdClose } from 'react-icons/md';
import { Modal } from '../ui/modal';
import { cn } from '@/lib/utils';
import { audioApi, EngineRuntimeStats } from '../../api/audio';
import { Slider } from '@/components/ui/slider';
import { AudioQueueDetails } from './AudioQueueDetails';
import { LatencyDetails } from './LatencyDetails';
import {
    restoreSavedOutputGain,
    readOutputGainStatus,
    setOutputGain as applyOutputGain,
} from '@/api/outputGain';

interface MeterLevels {
    input: [number, number];
    output: [number, number];
}

interface MasterBarProps {
    isRunning?: boolean;
    processReady?: boolean | null;
    host?: string;
    sampleRate?: number;
    bufferSize?: number;
    onOpenVoiceCheck?: () => void;
}

export const MasterBar: React.FC<MasterBarProps> = ({ host, sampleRate, bufferSize, onOpenVoiceCheck, isRunning = false, processReady }) => {
    const t = useMessages();
    const [levels, setLevels] = useState<[number, number]>([0, 0]);
    const [isClipping, setIsClipping] = useState(false);
    const [stats, setStats] = useState<EngineRuntimeStats | null>(null);
    const [hasRecentGlitch, setHasRecentGlitch] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const targetLevels = useRef<[number, number]>([0, 0]);
    const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    const [gainError, setGainError] = useState<ClientErrorNotice | null>(null);
    const [gainRestoreError, setGainRestoreError] = useState<ClientErrorNotice | null>(null);
    const gainMessage = renderNotice(t, gainError ?? gainRestoreError);

    const handleOutputGainChange = useCallback((values: number[]) => {
        window.dispatchEvent(new Event('output-gain-intent'));
        const pct = values[0];
        setOutputGain(pct);
        if (outputGainDebounce.current) clearTimeout(outputGainDebounce.current);
        outputGainDebounce.current = setTimeout(() => {
            setGainError(null);
            applyOutputGain(pct / 100).catch((e) => setGainError(clientErrorNotice(e)));
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
        const fetchStats = () => {
            if (fetching) return;
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
            }).catch(() => {}).finally(() => { fetching = false; });
        };
        fetchStats();
        const interval = setInterval(fetchStats, 1000);
        return () => { disposed = true; clearInterval(interval); };
    }, []);

    useEffect(() => {
        const unlisten = listen<MeterLevels>('audio-level', (event) => {
            const data = event.payload.output;
            targetLevels.current = data;

            // Instant clip detection
            if (data[0] > 1.0 || data[1] > 1.0) {
                setIsClipping(true);
                if (clipTimer.current) clearTimeout(clipTimer.current);
                clipTimer.current = setTimeout(() => setIsClipping(false), 2000);
            }
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    useEffect(() => {
        const intervalId = setInterval(() => {
            setLevels(prev => {
                const [currL, currR] = prev;
                let [targetL, targetR] = targetLevels.current;

                if (isNaN(targetL)) targetL = 0;
                if (isNaN(targetR)) targetR = 0;

                // Smooth decay
                const smoothL = targetL > currL ? 0.9 : 0.4;
                const smoothR = targetR > currR ? 0.9 : 0.4;

                let newL = currL + (targetL - currL) * smoothL;
                let newR = currR + (targetR - currR) * smoothR;

                if (isNaN(newL)) newL = 0;
                if (isNaN(newR)) newR = 0;

                return [newL, newR];
            });
        }, 16);

        return () => clearInterval(intervalId);
    }, []);

    const dbValue = (val: number) => {
        if (val <= 0.0001) return '-inf';
        return (20 * Math.log10(val)).toFixed(1);
    };

    const renderMeter = (val: number, label: string) => {
        const pct = isRunning ? Math.min(100, Math.max(0, val * 100)) : 0;
        return (
            <div className="flex flex-col gap-1 w-3 h-full bg-muted rounded-sm overflow-hidden border border-border relative group transition-colors duration-300">
                {/* Bar */}
                <div
                    className={cn(
                        "absolute bottom-0 left-0 right-0 transition-all duration-75 ease-out",
                        isClipping ? "bg-destructive shadow-[0_0_10px_currentColor]" : "bg-emerald-500"
                    )}
                    style={{ height: `${pct}%` }}
                />

                {/* Grid */}
                <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.1)_1px,transparent_1px)] dark:bg-[linear-gradient(rgba(0,0,0,0.5)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none" />

                {/* Label */}
                <div className="absolute bottom-1 left-0 right-0 text-[8px] text-center text-muted-foreground font-mono pointer-events-none mix-blend-difference opacity-0 group-hover:opacity-100 transition-opacity">{label}</div>
            </div>
        );
    };

    const effectiveSampleRate = sampleRate && sampleRate > 0 ? sampleRate : 48000;
    const isFxActive = !!stats && !stats.globalBypass && stats.enabledPluginCount > 0;
    const isNoiseConfigured = !!stats?.noiseReductionEnabled;
    const rawNoiseMode = stats?.noiseReductionMode?.toLowerCase();
    const noiseMode = rawNoiseMode === 'high' || rawNoiseMode === 'smart' || rawNoiseMode === 'venue'
        ? rawNoiseMode
        : 'low';
    const noiseModeLabel = stats?.noiseReductionEnabled
        ? (noiseMode === 'high' ? t('master.nrHigh') : noiseMode === 'smart' ? t('master.nrLearn') : noiseMode === 'venue' ? t('master.nrVenue') : t('master.nrLow'))
        : 'OFF';
    const isCleanActive = isNoiseConfigured && !isFxActive;
    const signalLabel = processReady === null ? t('master.unverified') : !isRunning ? (host ? t('shell.stopped') : t('shell.unconfigured')) : isFxActive ? t('master.vst') : (isCleanActive ? t('master.nr') : t('master.raw'));

    const handleNoiseReductionCycle = useCallback(async () => {
        if (!stats) return;
        const currentMode = !stats.noiseReductionEnabled
            ? 'off'
            : (stats.noiseReductionMode?.toLowerCase() === 'high' ? 'high' : stats.noiseReductionMode?.toLowerCase() === 'smart' ? 'smart' : stats.noiseReductionMode?.toLowerCase() === 'venue' ? 'venue' : 'low');
        const nextMode = currentMode === 'off' ? 'low' : currentMode === 'low' ? 'smart' : currentMode === 'smart' ? 'venue' : currentMode === 'venue' ? 'high' : 'off';
        const nextEnabled = nextMode !== 'off';
        try {
            await audioApi.setNoiseReduction(nextEnabled, nextEnabled ? nextMode : undefined);
            setStats(prev => prev ? {
                ...prev,
                noiseReductionEnabled: nextEnabled,
                noiseReductionActive: nextEnabled,
                noiseReductionMode: nextEnabled ? nextMode : (prev.noiseReductionMode || 'low'),
            } : prev);
        } catch (e) {
            console.error("Failed to set noise reduction", e);
        }
    }, [stats]);

    return (
        <div className={cn("relative h-full flex items-center gap-3 px-3 py-2 border-l border-border bg-card/30 backdrop-blur-sm transition-colors duration-300 min-w-0 whitespace-nowrap", gainMessage && "pt-0 pb-4")}>
            {gainMessage && (
                <span
                    role="alert"
                    className="absolute bottom-0.5 left-3 right-3 truncate text-xs leading-4 text-amber-700 dark:text-amber-300"
                    title={gainMessage}
                >
                    {t('master.gainUnknown')}
                </span>
            )}
            {/* Label */}
            <div className="hidden sm:flex flex-col items-end justify-center min-w-[60px]">
                <div className="flex items-center gap-2 text-muted-foreground font-bold font-mono tracking-widest text-xs">
                    <MdGraphicEq className={cn("w-3 h-3", isClipping ? 'text-destructive animate-pulse' : 'text-emerald-500')} />
                    {t('master.label')}
                </div>
                <div className="text-xs text-muted-foreground font-mono tracking-tight">
                    {isRunning ? `${dbValue(Math.max(levels[0], levels[1]))} dB` : t('master.stopped')}
                </div>
            </div>

            {/* Meters */}
            <div className="flex gap-1 h-3/4 items-end pb-1">
                {renderMeter(levels[0], 'L')}
                {renderMeter(levels[1], 'R')}
            </div>

            {onOpenVoiceCheck && (
                <button
                    onClick={onOpenVoiceCheck}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    title={t('master.voiceHint')}
                    aria-label={t('master.voice')}
                >
                    <MdMic className="w-4 h-4" />
                </button>
            )}

            {/* Master Output Volume */}
            <div className="flex items-center gap-2 border-l border-border pl-3 ml-1 min-w-0">
                <MdVolumeUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <Slider
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

            {/* Signal State + Latency */}
            {stats && (
                <div className="flex items-center gap-1.5 text-muted-foreground border-l border-border pl-3 ml-1 min-w-0">
                    <span
                        className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold font-mono",
                            !isRunning ? "text-muted-foreground border-border bg-muted" : isFxActive
                                ? "text-amber-800 dark:text-amber-300 border-amber-500/40 bg-amber-500/10"
                                : isCleanActive
                                    ? "text-sky-800 dark:text-sky-300 border-sky-500/40 bg-sky-500/10"
                                    : "text-emerald-800 dark:text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
                        )}
                    >
                        {signalLabel}
                    </span>
                    <button
                        onClick={handleNoiseReductionCycle}
                        className={cn(
                            "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-bold font-mono transition-colors",
                            stats.noiseReductionEnabled
                                ? noiseMode === "high" || noiseMode === "venue"
                                    ? "text-amber-800 dark:text-amber-300 border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20"
                                    : "text-sky-800 dark:text-sky-300 border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20"
                                : "text-muted-foreground border-border bg-muted/40 hover:bg-muted"
                        )}
                        title={t('master.nrHint', {mode: noiseModeLabel, rate: effectiveSampleRate})}
                    >
                        <span className="hidden md:inline">{t('master.noise')} </span>{noiseModeLabel}
                        {stats.speechDetected && stats.noiseReductionEnabled && (
                            <span className="ml-1 hidden lg:inline text-xs">{t('master.speech')}</span>
                        )}
                    </button>
                    {hasRecentGlitch && (
                        <MdBolt className="w-3.5 h-3.5 text-orange-500 animate-pulse" title={t('master.glitch')} />
                    )}
                </div>
            )}

            <button onClick={() => setDetailsOpen(true)} aria-haspopup="dialog" aria-expanded={detailsOpen}
                className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted">
                {t('master.details')}
            </button>
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
                            <LatencyDetails stats={stats} isRunning={isRunning} />
                            <AudioQueueDetails snapshot={stats?.queueDiagnostics} isRunning={isRunning} />
                        </div>
                    </div>
                </div>
            </Modal>}
        </div>
    );
};

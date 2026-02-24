import React, { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdGraphicEq, MdExtension, MdVolumeUp, MdBolt } from 'react-icons/md';
import { cn } from '@/lib/utils';
import { audioApi, EngineRuntimeStats } from '../../api/audio';
import { Slider } from '@/components/ui/slider';

interface MeterLevels {
    input: [number, number];
    output: [number, number];
}

interface MasterBarProps {
    host?: string;
    sampleRate?: number;
    bufferSize?: number;
}

export const MasterBar: React.FC<MasterBarProps> = ({ host, sampleRate, bufferSize }) => {
    const getBeginnerMode = () => localStorage.getItem('vst_host_beginner_mode') !== 'false';
    const [levels, setLevels] = useState<[number, number]>([0, 0]);
    const [isClipping, setIsClipping] = useState(false);
    const [stats, setStats] = useState<EngineRuntimeStats | null>(null);
    const [hasRecentGlitch, setHasRecentGlitch] = useState(false);
    const [isBeginnerMode, setIsBeginnerMode] = useState(getBeginnerMode);
    const targetLevels = useRef<[number, number]>([0, 0]);
    const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const glitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousGlitchCount = useRef<number | null>(null);

    // Master output gain (persisted)
    const [outputGain, setOutputGain] = useState<number>(() => {
        const saved = localStorage.getItem('vst_host_output_gain');
        return saved ? parseFloat(saved) : 100;
    });
    const outputGainDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleOutputGainChange = useCallback((values: number[]) => {
        const pct = values[0];
        setOutputGain(pct);
        localStorage.setItem('vst_host_output_gain', String(pct));
        if (outputGainDebounce.current) clearTimeout(outputGainDebounce.current);
        outputGainDebounce.current = setTimeout(() => {
            audioApi.setOutputGain(pct / 100).catch(() => {});
        }, 30);
    }, []);

    // Apply saved output gain on mount AND when engine starts/restarts
    useEffect(() => {
        const applyGain = () => {
            const saved = localStorage.getItem('vst_host_output_gain');
            const pct = saved ? parseFloat(saved) : 100;
            if (pct !== 100) {
                audioApi.setOutputGain(pct / 100).catch(() => {});
            }
        };

        // Try immediately (engine may already be running)
        applyGain();

        // Also apply when engine starts (covers cold boot / restart scenarios)
        const unlisten = listen('audio-started', () => {
            applyGain();
        });

        return () => { unlisten.then(f => f()); };
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
        const fetchStats = () => {
            audioApi.getEngineRuntimeStats().then((next) => {
                const prev = previousGlitchCount.current;
                if (prev !== null && next.glitchCount > prev) {
                    setHasRecentGlitch(true);
                    if (glitchTimer.current) clearTimeout(glitchTimer.current);
                    glitchTimer.current = setTimeout(() => setHasRecentGlitch(false), 1500);
                }
                previousGlitchCount.current = next.glitchCount;
                setStats(next);
            }).catch(() => {});
        };
        fetchStats();
        const interval = setInterval(fetchStats, 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const syncBeginnerMode = (event?: Event) => {
            const next = (event as CustomEvent<boolean> | undefined)?.detail;
            setIsBeginnerMode(typeof next === 'boolean' ? next : getBeginnerMode());
        };
        window.addEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
        window.addEventListener('storage', syncBeginnerMode);
        return () => {
            window.removeEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
            window.removeEventListener('storage', syncBeginnerMode);
        };
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
        const pct = Math.min(100, Math.max(0, val * 100));
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

    const isAsio = host?.toUpperCase().includes('ASIO') ?? false;
    const effectiveSampleRate = sampleRate && sampleRate > 0 ? sampleRate : 48000;
    const effectiveBufferSize = bufferSize && bufferSize > 0 ? bufferSize : (isAsio ? 256 : 512);
    const baseLatencyMs = ((effectiveBufferSize * 2) / effectiveSampleRate) * 1000 + (isAsio ? 0 : 20);
    const fxLatencyMs = stats?.totalPluginLatencyMs ?? 0;
    const nrLatencyMs = stats?.noiseReductionLatencyMs ?? 0;
    const chainLatencyMs = stats?.totalChainLatencyMs ?? 0;
    const totalLatencyMs = baseLatencyMs + chainLatencyMs;
    const isFxActive = !!stats && !stats.globalBypass && stats.enabledPluginCount > 0;
    const isNoiseActive = !!stats?.noiseReductionActive;
    const noiseMode = stats?.noiseReductionMode?.toLowerCase() === 'high' ? 'high' : 'low';
    const noiseModeLabel = stats?.noiseReductionEnabled
        ? (noiseMode === 'high' ? '強' : '弱')
        : 'OFF';
    const isCleanActive = isNoiseActive && !isFxActive;
    const signalLabel = isFxActive ? '処理中' : (isCleanActive ? 'ノイズ抑制' : '原音');

    const handleNoiseReductionCycle = useCallback(async () => {
        if (!stats) return;
        const currentMode = !stats.noiseReductionEnabled
            ? 'off'
            : (stats.noiseReductionMode?.toLowerCase() === 'high' ? 'high' : 'low');
        const nextMode = currentMode === 'off' ? 'low' : currentMode === 'low' ? 'high' : 'off';
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
        <div className="h-full flex items-center gap-3 px-3 border-l border-border bg-card/30 backdrop-blur-sm transition-colors duration-300 min-w-0 whitespace-nowrap">
            {/* Label */}
            <div className="hidden sm:flex flex-col items-end justify-center min-w-[60px]">
                <div className="flex items-center gap-2 text-muted-foreground font-bold font-mono tracking-widest text-xs">
                    <MdGraphicEq className={cn("w-3 h-3", isClipping ? 'text-destructive animate-pulse' : 'text-emerald-500')} />
                    マスター
                </div>
                <div className="text-[10px] text-muted-foreground font-mono tracking-tight">
                    {dbValue(Math.max(levels[0], levels[1]))} dB
                </div>
            </div>

            {/* Meters */}
            <div className="flex gap-1 h-3/4 items-end pb-1">
                {renderMeter(levels[0], 'L')}
                {renderMeter(levels[1], 'R')}
            </div>

            {/* Master Output Volume */}
            <div className="flex items-center gap-2 border-l border-border pl-3 ml-1 min-w-0">
                <MdVolumeUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <Slider
                    value={[outputGain]}
                    onValueChange={handleOutputGainChange}
                    min={0}
                    max={200}
                    step={1}
                    className="w-16 md:w-20"
                    onDoubleClick={() => handleOutputGainChange([100])}
                />
                <span className="hidden md:inline text-[10px] font-mono tabular-nums text-muted-foreground min-w-[32px] text-right">
                    {outputGain}%
                </span>
            </div>

            {/* Signal State + Latency */}
            {stats && (
                <div className="flex items-center gap-1.5 text-muted-foreground border-l border-border pl-3 ml-1 min-w-0">
                    <span
                        className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold font-mono",
                            isFxActive
                                ? "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10"
                                : isCleanActive
                                    ? "text-sky-600 dark:text-sky-300 border-sky-500/40 bg-sky-500/10"
                                    : "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                        )}
                    >
                        {signalLabel}
                    </span>
                    <button
                        onClick={handleNoiseReductionCycle}
                        className={cn(
                            "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold font-mono transition-colors",
                            stats.noiseReductionEnabled
                                ? noiseMode === "high"
                                    ? "text-amber-600 dark:text-amber-300 border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20"
                                    : "text-sky-600 dark:text-sky-300 border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20"
                                : "text-muted-foreground border-border bg-muted/40 hover:bg-muted"
                        )}
                        title={`ノイズ抑制: ${noiseModeLabel}（${effectiveSampleRate}Hz / OFF→弱→強）`}
                    >
                        <span className="hidden md:inline">ノイズ </span>{noiseModeLabel}
                    </button>
                    {!isBeginnerMode && (
                        <>
                            <span className="hidden xl:inline text-[10px] font-mono tabular-nums">入出力 {baseLatencyMs.toFixed(1)}ms</span>
                            <span className="hidden xl:inline text-[10px] font-mono tabular-nums">ノイズ {nrLatencyMs.toFixed(1)}ms</span>
                            <span className="hidden xl:inline text-[10px] font-mono tabular-nums">VST {fxLatencyMs.toFixed(1)}ms</span>
                        </>
                    )}
                    <span className="text-[10px] font-mono tabular-nums text-foreground">
                        <span className="hidden lg:inline">合計 </span>{totalLatencyMs.toFixed(1)}ms
                    </span>
                    {hasRecentGlitch && (
                        <MdBolt className="w-3.5 h-3.5 text-orange-500 animate-pulse" title="直近でグリッチを検出" />
                    )}
                </div>
            )}

            {/* Engine Stats */}
            {stats && !isBeginnerMode && (
                <div className="flex items-center gap-1.5 text-muted-foreground border-l border-border pl-3 ml-1 min-w-0">
                    <MdExtension className="w-3 h-3" />
                    <span className="text-[10px] font-mono tabular-nums whitespace-nowrap" title={`${stats.enabledPluginCount} 有効 / ${stats.activePluginCount} 総数`}>
                        <span className="xl:hidden">有{stats.enabledPluginCount}/総{stats.activePluginCount}</span>
                        <span className="hidden xl:inline">{stats.enabledPluginCount} 有効 / {stats.activePluginCount} 総数</span>
                    </span>
                </div>
            )}
        </div>
    );
};

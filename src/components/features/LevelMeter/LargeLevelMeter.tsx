import React, { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdWarning, MdInfo, MdVolumeUp, MdClose, MdOpenInFull, MdCloseFullscreen } from 'react-icons/md';
import { audioApi } from '../../../api/audio';
import { cn } from '@/lib/utils';

interface MeterLevels {
    input: [number, number];
    output: [number, number];
}

interface LargeLevelMeterProps {
    onClose: () => void;
}

// Helper: Linear peak (0-1) to dB
const toDB = (linear: number): number => {
    if (linear <= 0) return -Infinity;
    return 20 * Math.log10(linear);
};

// Helper: Format dB for display
const formatDB = (db: number): string => {
    if (!isFinite(db) || db < -60) return '-∞';
    return db.toFixed(1);
};

export const LargeLevelMeter: React.FC<LargeLevelMeterProps> = ({ onClose }) => {
    const [levels, setLevels] = useState<[number, number]>([0, 0]);
    const [peakHold, setPeakHold] = useState<[number, number]>([0, 0]);
    const [hasClipped, setHasClipped] = useState(false);
    const [showTips, setShowTips] = useState(false);
    const [inputGain, setInputGain] = useState(() => {
        // Read persisted value (stored as percentage 0-200) and convert to linear 0-2
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) / 100 : 1.0;
    });
    const [isMiniMode, setIsMiniMode] = useState(false);
    const targetLevels = useRef<[number, number]>([0, 0]);
    const peakDecayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clipResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gainDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sync input gain from other components (e.g. Header slider)
    useEffect(() => {
        const handler = (e: Event) => {
            const pct = (e as CustomEvent<number>).detail;
            setInputGain(pct / 100);
        };
        window.addEventListener('input-gain-sync', handler);
        return () => window.removeEventListener('input-gain-sync', handler);
    }, []);

    // ... (Hooks remain same) ...
    useEffect(() => {
        const unlisten = listen<MeterLevels>('audio-level', (event) => {
            targetLevels.current = event.payload.output;
        });
        return () => { unlisten.then(f => f()); };
    }, []);

    useEffect(() => {
        const intervalId = setInterval(() => {
            setLevels(prev => {
                const [currL, currR] = prev;
                let [targetL, targetR] = targetLevels.current;
                if (isNaN(targetL)) targetL = 0;
                if (isNaN(targetR)) targetR = 0;
                const smoothL = targetL > currL ? 0.85 : 0.35;
                const smoothR = targetR > currR ? 0.85 : 0.35;
                let newL = currL + (targetL - currL) * smoothL;
                let newR = currR + (targetR - currR) * smoothR;
                if (isNaN(newL) || !isFinite(newL)) newL = 0;
                if (isNaN(newR) || !isFinite(newR)) newR = 0;

                // Check for clipping
                const dbL = toDB(newL);
                const dbR = toDB(newR);
                if (dbL >= -3 || dbR >= -3) {
                    setHasClipped(true);
                    if (clipResetTimer.current) clearTimeout(clipResetTimer.current);
                    clipResetTimer.current = setTimeout(() => setHasClipped(false), 3000);
                }
                return [newL, newR];
            });

            setPeakHold(prevPeak => {
                const [currL, currR] = targetLevels.current;
                return [Math.max(prevPeak[0], currL), Math.max(prevPeak[1], currR)];
            });
        }, 16);

        peakDecayTimer.current = setInterval(() => {
            setPeakHold(prev => [prev[0] * 0.9, prev[1] * 0.9]);
        }, 2000);

        return () => {
            clearInterval(intervalId);
            if (peakDecayTimer.current) clearInterval(peakDecayTimer.current);
            if (clipResetTimer.current) clearTimeout(clipResetTimer.current);
        };
    }, []);

    const renderBar = (val: number, peak: number, label: string) => {
        const pct = Math.min(100, Math.max(0, val * 100));
        const peakPct = Math.min(100, Math.max(0, peak * 100));
        const db = toDB(val);
        const isClipping = db >= -3;
        const isWarning = db >= -12 && db < -3;

        return (
            <div className="flex flex-col items-center gap-1 flex-1 h-full min-h-0">
                {!isMiniMode && <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">{label}</span>}
                <div className={cn("relative w-full bg-card rounded overflow-hidden ring-1 ring-border transition-all", isMiniMode ? "h-full" : "h-full")}>
                    {/* Bar */}
                    <div
                        className={cn("absolute bottom-0 left-0 right-0 transition-all duration-75 ease-out",
                            isClipping ? 'bg-gradient-to-t from-red-600 to-red-400' :
                                isWarning ? 'bg-gradient-to-t from-yellow-600 to-yellow-400' :
                                    'bg-gradient-to-t from-emerald-600 to-emerald-400'
                        )}
                        style={{ height: `${pct}%` }}
                    />
                    {/* Peak Hold Line */}
                    <div
                        className="absolute left-0 right-0 h-0.5 bg-white/80 shadow-[0_0_4px_rgba(255,255,255,0.5)]"
                        style={{ bottom: `${peakPct}%` }}
                    />
                    {/* Gridlines */}
                    <div className="absolute inset-0 flex flex-col justify-between py-1 pointer-events-none opacity-50">
                        {[0, -6, -12, -24, -48].map(dbMark => {
                            const markPct = Math.pow(10, dbMark / 20) * 100;
                            return (
                                <div
                                    key={dbMark}
                                    className="absolute w-full border-t border-black/30"
                                    style={{ bottom: `${markPct}%` }}
                                />
                            );
                        })}
                    </div>
                </div>
                {/* dB Value */}
                {!isMiniMode && (
                    <span className={cn("text-xs font-mono", isClipping ? 'text-destructive font-bold' : 'text-muted-foreground')}>
                        {formatDB(db)}
                    </span>
                )}
            </div>
        );
    };

    return (
        <div className={cn(
            "fixed top-16 bottom-20 right-0 bg-background/95 border-l border-border shadow-2xl z-40 flex flex-col p-2 gap-2 transition-all duration-300 backdrop-blur-md",
            isMiniMode ? "w-16" : "w-36"
        )}>
            {/* Header */}
            <div className="flex items-center justify-between">
                {!isMiniMode && <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider truncate">レベル</span>}
                <div className={cn("flex items-center gap-1", isMiniMode && "flex-col w-full")}>
                    <button
                        onClick={() => setIsMiniMode(!isMiniMode)}
                        className="text-muted-foreground hover:text-primary transition-colors p-1"
                        title={isMiniMode ? "詳細表示" : "ミニモード"}
                    >
                        {isMiniMode ? <MdOpenInFull className="w-4 h-4" /> : <MdCloseFullscreen className="w-4 h-4" />}
                    </button>
                    {!isMiniMode && (
                        <button
                            onClick={() => setShowTips(prev => !prev)}
                            className={cn("text-muted-foreground hover:text-primary transition-colors p-1", showTips && "text-primary")}
                            title="dB スケールについて"
                        >
                            <MdInfo className="w-4 h-4" />
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="text-muted-foreground hover:text-destructive p-1 rounded-full hover:bg-white/10 transition-colors"
                        title="閉じる"
                    >
                        <MdClose className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Clipping Indicator */}
            {hasClipped && (
                <div className={cn(
                    "flex items-center justify-center bg-destructive/20 border border-destructive/50 rounded animate-pulse shrink-0",
                    isMiniMode ? "p-1" : "px-2 py-1 gap-1"
                )}>
                    <MdWarning className="w-3 h-3 text-destructive" />
                    {!isMiniMode && <span className="text-[10px] font-bold text-destructive uppercase">Clip!</span>}
                </div>
            )}

            {/* Tips Panel */}
            {!isMiniMode && showTips && (
                <div className="text-[9px] text-muted-foreground bg-popover/95 border border-border rounded-md p-2 space-y-1 animate-in fade-in zoom-in-95 duration-200">
                    <div><span className="text-emerald-500">緑</span>: -12dB以下</div>
                    <div><span className="text-yellow-500">黄</span>: -12~-3dB</div>
                    <div><span className="text-destructive">赤</span>: -3dB以上</div>
                </div>
            )}

            {/* Input Gain Slider */}
            {!isMiniMode && (
                <div className="space-y-1 shrink-0">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1"><MdVolumeUp className="w-3 h-3" /> 入力</span>
                        <span className="font-mono">{(inputGain * 100).toFixed(0)}%</span>
                    </div>
                    <input
                        type="range"
                        min="0"
                        max="200"
                        value={inputGain * 100}
                        onChange={(e) => {
                            const pct = Number(e.target.value);
                            const value = pct / 100;
                            setInputGain(value);
                            if (gainDebounce.current) clearTimeout(gainDebounce.current);
                            gainDebounce.current = setTimeout(() => {
                                audioApi.setInputGain(value).catch(console.error);
                                localStorage.setItem('vst_host_input_gain', String(pct));
                            }, 50);
                            // Sync to Header slider
                            window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: pct }));
                        }}
                        onDoubleClick={() => {
                            setInputGain(1.0);
                            audioApi.setInputGain(1.0).catch(console.error);
                            localStorage.setItem('vst_host_input_gain', '100');
                            window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: 100 }));
                        }}
                        className="w-full h-2 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                        title="ダブルクリックで100%にリセット"
                    />
                </div>
            )}

            {/* Meter Bars */}
            <div className="flex gap-1.5 flex-1 min-h-0 w-full">
                {renderBar(levels[0], peakHold[0], 'L')}
                {renderBar(levels[1], peakHold[1], 'R')}
            </div>

            {/* Grid Labels (Hidden in Mini Mode) */}
            {!isMiniMode && (
                <div className="flex justify-around text-[10px] text-muted-foreground font-mono shrink-0">
                    <span>0</span>
                    <span>-12</span>
                    <span>-24</span>
                    <span>-∞</span>
                </div>
            )}
        </div>
    );
};

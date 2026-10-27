import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState, useRef } from 'react';
import { useMeterLevels, meterStatusLabel } from '../../../hooks/useMeterLevels';
import { MdWarning, MdInfo, MdVolumeUp, MdClose, MdOpenInFull, MdCloseFullscreen } from 'react-icons/md';
import { audioApi } from '../../../api/audio';
import { cn } from '@/lib/utils';

interface LargeLevelMeterProps {
    onClose: () => void;
    running?: boolean;
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

export const LargeLevelMeter: React.FC<LargeLevelMeterProps> = ({ onClose, running = false }) => {
    const t = useMessages();
    const { levels, peak: peakHold, clipped: hasClipped, state } = useMeterLevels({ running, large: true });
    const [showTips, setShowTips] = useState(false);
    const [inputGain, setInputGain] = useState(() => {
        // Read persisted value (stored as percentage 0-200) and convert to linear 0-2
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) / 100 : 1.0;
    });
    const [isMiniMode, setIsMiniMode] = useState(false);
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

    const renderBar = (val: number, peak: number, label: string) => {
        const pct = Math.min(100, Math.max(0, val * 100));
        const peakPct = Math.min(100, Math.max(0, peak * 100));
        const db = toDB(val);
        const isClipping = db >= -3;
        const isWarning = db >= -12 && db < -3;

        return (
            <div className="flex flex-col items-center gap-1 flex-1 h-full min-h-0">
                {!isMiniMode && <span className="text-xs text-muted-foreground uppercase tracking-wider font-mono">{label}</span>}
                <div className={cn("relative w-full bg-card rounded overflow-hidden ring-1 ring-border transition-all", isMiniMode ? "h-full" : "h-full")}>
                    {/* Bar */}
                    <div
                        className={cn("absolute bottom-0 left-0 right-0 transition-all duration-75 ease-out",
                            isClipping ? 'bg-gradient-to-t from-meter-danger to-meter-danger' :
                                isWarning ? 'bg-gradient-to-t from-warning to-warning' :
                                    'bg-gradient-to-t from-success to-success'
                        )}
                        style={{ height: `${pct}%` }}
                    />
                    {/* Peak Hold Line */}
                    <div
                        className="absolute left-0 right-0 h-0.5 bg-foreground/80 shadow-[0_0_4px_hsl(var(--foreground)/0.5)]"
                        style={{ bottom: `${peakPct}%` }}
                    />
                    {/* Gridlines */}
                    <div className="absolute inset-0 flex flex-col justify-between py-1 pointer-events-none opacity-50">
                        {[0, -6, -12, -24, -48].map(dbMark => {
                            const markPct = Math.pow(10, dbMark / 20) * 100;
                            return (
                                <div
                                    key={dbMark}
                                    className="absolute w-full border-t border-foreground/30"
                                    style={{ bottom: `${markPct}%` }}
                                />
                            );
                        })}
                    </div>
                </div>
                {/* dB Value */}
                {!isMiniMode && (
                    <span className={cn("text-xs font-mono", isClipping ? 'text-destructive-text font-bold' : 'text-muted-foreground')}>
                        {formatDB(db)}
                    </span>
                )}
            </div>
        );
    };

    return (
        <div className={cn(
            "fixed top-16 bottom-[calc(var(--app-footer-height,4rem)+1rem)] right-0 bg-background/95 border-l border-border shadow-2xl z-40 flex flex-col p-2 gap-2 transition-all duration-300 backdrop-blur-md",
            isMiniMode ? "w-16" : "w-36"
        )}>
            {/* Header */}
            <div className="flex items-center justify-between">
                {!isMiniMode && <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider truncate">{t('meter.title')}</span>}
                <div className={cn("flex items-center gap-1", isMiniMode && "flex-col w-full")}>
                    <button
                        onClick={() => setIsMiniMode(!isMiniMode)}
                        className="text-muted-foreground hover:text-primary transition-colors p-1"
                        title={isMiniMode ? t('meter.detailedView') : t('meter.miniView')}
                    >
                        {isMiniMode ? <MdOpenInFull className="w-4 h-4" /> : <MdCloseFullscreen className="w-4 h-4" />}
                    </button>
                    {!isMiniMode && (
                        <button
                            onClick={() => setShowTips(prev => !prev)}
                            className={cn("text-muted-foreground hover:text-primary transition-colors p-1", showTips && "text-primary")}
                            title={t('meter.scaleDetails')}
                        >
                            <MdInfo className="w-4 h-4" />
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="text-muted-foreground hover:text-destructive-text p-1 rounded-full hover:bg-card/10 transition-colors"
                        title={t('common.close')}
                    >
                        <MdClose className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <span className="text-xs text-muted-foreground" title={t('meter.arrivalUnverified')}>{t(meterStatusLabel(state))}</span>

            {/* Clipping Indicator */}
            {hasClipped && (
                <div className={cn(
                    "flex items-center justify-center bg-destructive/20 border border-destructive/50 rounded animate-pulse shrink-0",
                    isMiniMode ? "p-1" : "px-2 py-1 gap-1"
                )}>
                    <MdWarning className="w-3 h-3 text-destructive-text" />
                    {!isMiniMode && <span className="text-xs font-bold text-destructive-text uppercase">Clip!</span>}
                </div>
            )}

            {/* Tips Panel */}
            {!isMiniMode && showTips && (
                <div className="text-xs text-muted-foreground bg-popover/95 border border-border rounded-md p-2 space-y-1 animate-in fade-in zoom-in-95 duration-200">
                    <div><span className="text-success">{t('meter.scale.green')}</span>{t('meter.scale.low')}</div>
                    <div><span className="text-warning">{t('meter.scale.yellow')}</span>: -12~-3dB</div>
                    <div><span className="text-destructive-text">{t('meter.scale.red')}</span>{t('meter.scale.high')}</div>
                </div>
            )}

            {/* Input Gain Slider */}
            {!isMiniMode && (
                <div className="space-y-1 shrink-0">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-1"><MdVolumeUp className="w-3 h-3" /> {t('meter.input')}</span>
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
                        title={t('meter.resetGainHint')}
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
                <div className="flex justify-around text-xs text-muted-foreground font-mono shrink-0">
                    <span>0</span>
                    <span>-12</span>
                    <span>-24</span>
                    <span>-∞</span>
                </div>
            )}
        </div>
    );
};

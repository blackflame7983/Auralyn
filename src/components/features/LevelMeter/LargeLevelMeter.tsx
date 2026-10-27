import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState, useRef } from 'react';
import { meterStatusLabel } from '../../../hooks/useMeterLevels';
import { useSharedMeter } from './MeterContext';
import { MeterVisual } from './MeterVisual';
import { MdInfo, MdVolumeUp, MdClose, MdOpenInFull, MdCloseFullscreen } from 'react-icons/md';
import { audioApi } from '../../../api/audio';
import { cn } from '@/lib/utils';

interface LargeLevelMeterProps {
    onClose: () => void;
    running?: boolean;
}

export const LargeLevelMeter: React.FC<LargeLevelMeterProps> = ({ onClose, running = false }) => {
    const t = useMessages();
    const reading = useSharedMeter(running, 'output');
    const { state } = reading;
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

            {/* Tips Panel */}
            {!isMiniMode && showTips && (
                <div className="text-xs text-muted-foreground bg-popover/95 border border-border rounded-md p-2 space-y-1 animate-in fade-in zoom-in-95 duration-200">
                    <div><span className="text-success">{t('meter.scale.green')}</span>{t('meter.scale.low')}</div>
                    <div><span className="text-warning">{t('meter.scale.yellow')}</span>: −6〜0 dBFS</div>
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
                        aria-label={t('meter.input')}
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

            {/* 共通基準の出力メーター */}
            <div className="flex-1 min-h-0 flex justify-center items-stretch">
                <MeterVisual reading={reading} label={t('meter.output')} width={isMiniMode ? 12 : 32} height="100%" showValues={!isMiniMode} scale={!isMiniMode} />
                {!isMiniMode && <div aria-hidden="true" className="relative h-full w-8 text-xs text-muted-foreground font-mono">
                    {[0, -6, -12, -24, -48].map(mark => <span key={mark} className="absolute left-1 -translate-y-1/2" style={{ bottom: `calc(${Math.pow(10, mark / 20) * 100}% - 0.5em)` }}>{mark}</span>)}
                </div>}
            </div>
        </div>
    );
};

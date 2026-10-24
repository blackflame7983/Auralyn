import { useMessages } from '@/i18n/LocaleProvider';
import React from 'react';
import { useMeterLevels, meterStatusLabel } from '../../../hooks/useMeterLevels';

interface LevelMeterProps {
    running?: boolean;
    width?: number; // Width of EACH bar
    height?: number;
    type?: 'input' | 'output';
}

export const LevelMeter: React.FC<LevelMeterProps> = ({ width = 8, height = 32, type = 'output', running = false }) => {
    const t = useMessages();
    const { levels, clipped: isClipping, state } = useMeterLevels({ running, type });

    const renderBar = (val: number) => {
        // Clamp for bar height, but keep original val for clip logic (handled separately)
        const pct = Math.min(100, Math.max(0, val * 100));

        // Color logic
        let barColor = "bg-gradient-to-t from-emerald-500 via-emerald-400 to-yellow-400 dark:from-accent-primary dark:to-accent-secondary";

        return (
            <div className="w-full h-full bg-bg-element rounded-full relative overflow-hidden ring-1 ring-border-subtle">
                <div
                    className={`absolute bottom-0 left-0 right-0 ${barColor} transition-all duration-75 ease-out`}
                    style={{ height: `${pct}%` }}
                />
                {/* Scanline effect */}
                <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.1)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none opacity-50" />
            </div>
        );
    };

    return (
        <div aria-label={t('meterBrowser.copy.067', { arg0: type === 'input' ? t('meterBrowser.copy.068') : t('meterBrowser.copy.069'), arg1: t(meterStatusLabel(state)) })} title={t(meterStatusLabel(state))} className={`relative flex gap-1.5 p-1.5 bg-bg-panel/50 rounded-lg border shadow-inner items-center justify-center backdrop-blur-sm transition-colors duration-300 ${isClipping ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)] bg-red-500/10' : 'border-border-subtle'}`} style={{ height }}>
            {/* Type Label (Tiny) */}
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] font-mono font-bold text-text-tertiary uppercase tracking-wider bg-bg-base px-1 rounded ring-1 ring-border-subtle/50">
                {type === 'input' ? 'IN' : 'OUT'}
            </div>

            <div style={{ width, height: '100%' }} title="Left">
                {renderBar(levels[0])}
            </div>
            <div style={{ width, height: '100%' }} title="Right">
                {renderBar(levels[1])}
            </div>
        </div>
    );
};

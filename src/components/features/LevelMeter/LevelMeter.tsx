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
        const barColor = "bg-gradient-to-t from-success via-success to-warning";

        return (
            <div className="w-full h-full bg-muted rounded-full relative overflow-hidden ring-1 ring-border">
                <div
                    className={`absolute bottom-0 left-0 right-0 ${barColor} transition-all duration-75 ease-out`}
                    style={{ height: `${pct}%` }}
                />
                {/* Scanline effect */}
                <div className="absolute inset-0 meter-grid pointer-events-none opacity-50" />
            </div>
        );
    };

    return (
        <div aria-label={t('meter.accessibleLevel', { arg0: type === 'input' ? t('meter.input') : t('meter.output'), arg1: t(meterStatusLabel(state)) })} title={t(meterStatusLabel(state))} className={`relative flex gap-1.5 p-1.5 bg-card/50 rounded-lg border shadow-inner items-center justify-center backdrop-blur-sm transition-colors duration-300 ${isClipping ? 'border-meter-danger shadow-[0_0_10px_hsl(var(--meter-danger)/0.3)] bg-destructive/10' : 'border-border'}`} style={{ height }}>
            {/* Type Label (Tiny) */}
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-mono font-bold text-muted-foreground uppercase tracking-wider bg-background px-1 rounded ring-1 ring-border/50">
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

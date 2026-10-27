import { useMessages } from '@/i18n/LocaleProvider';
import { CLIP_LEVEL, WARNING_LEVEL, meterStatusLabel, toDbfs, type MeterReading } from '@/hooks/useMeterLevels';

export function MeterVisual({ reading, label, orientation = 'vertical', height = 32, width = 8, showValues = false, scale = false }: {
    reading: MeterReading; label: string; orientation?: 'horizontal' | 'vertical'; height?: number | string; width?: number; showValues?: boolean; scale?: boolean;
}) {
    const t = useMessages();
    const current = reading.state === 'live' || reading.state === 'silent';
    const amplitude = current ? Math.max(...reading.levels) : 0;
    const db = toDbfs(amplitude);
    const text = current ? `${Number.isFinite(db) ? db.toFixed(1) : '−∞'} dBFS` : t(meterStatusLabel(reading.state));
    const bars = orientation === 'horizontal' ? [Math.max(...reading.levels)] : reading.levels;
    const peaks = orientation === 'horizontal' ? [Math.max(...reading.peak)] : reading.peak;
    return <div className={`flex min-w-0 items-center gap-1 ${orientation === 'horizontal' ? 'flex-1' : ''}`}>
        <div role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0}
            aria-valuenow={current ? Math.max(-60, Math.min(0, Number.isFinite(db) ? db : -60)) : undefined}
            aria-valuetext={text} title={t(meterStatusLabel(reading.state))}
            className={`flex min-w-0 gap-1 ${orientation === 'horizontal' ? 'flex-1' : ''}`} style={{ height }}>
            {bars.map((value, i) => {
                const pct = current ? Math.min(100, Math.max(0, value * 100)) : 0;
                const peak = current ? Math.min(100, Math.max(0, peaks[i] * 100)) : 0;
                const color = peaks[i] >= CLIP_LEVEL ? 'bg-meter-danger' : peaks[i] >= WARNING_LEVEL ? 'bg-warning' : 'bg-success';
                return <div key={i} title={orientation === 'vertical' ? (i === 0 ? 'Left' : 'Right') : undefined}
                    className={`relative overflow-hidden rounded bg-muted ring-1 ring-border ${orientation === 'horizontal' ? 'h-full flex-1' : 'h-full'}`} style={orientation === 'vertical' ? { width } : undefined}>
                    <div className={`absolute bottom-0 left-0 ${orientation === 'horizontal' ? 'h-full' : 'right-0'} ${color} transition-all duration-75`} style={orientation === 'horizontal' ? { width: `${pct}%` } : { height: `${pct}%` }} />
                    {scale && [0, -6, -12, -24, -48].map(mark => <span key={mark} aria-hidden="true" className={`absolute bg-foreground/30 ${orientation === 'horizontal' ? 'top-0 bottom-0 w-px' : 'left-0 right-0 h-px'}`} style={orientation === 'horizontal' ? { left: `${Math.pow(10, mark / 20) * 100}%` } : { bottom: `${Math.pow(10, mark / 20) * 100}%` }} />)}
                    {current && <div aria-hidden="true" className={`absolute bg-foreground/80 ${orientation === 'horizontal' ? 'top-0 bottom-0 w-0.5' : 'left-0 right-0 h-0.5'}`} style={orientation === 'horizontal' ? { left: `${peak}%` } : { bottom: `${peak}%` }} />}
                </div>;
            })}
        </div>
        {showValues && current && <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">{text}</span>}
        {scale && <span className="sr-only">0, −6, −12, −24, −48 dBFS</span>}
        {reading.clipped && <button type="button" onClick={reading.resetClip} className="shrink-0 rounded border border-destructive/50 px-1 text-xs font-semibold text-destructive-text" aria-label={t('meter.clearClipNamed', { name: label })}>{t('meter.clip')}</button>}
    </div>;
}

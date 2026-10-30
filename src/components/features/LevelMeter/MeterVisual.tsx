import { useMessages } from '@/i18n/LocaleProvider';
import { CLIP_LEVEL, WARNING_LEVEL, meterStatusLabel, toDbfs, type MeterReading } from '@/hooks/useMeterLevels';

export function MeterVisual({ reading, label, orientation = 'vertical', height = 32, width = 8, showValues = false, scale = false, stackValues = false }: {
    reading: MeterReading; label: string; orientation?: 'horizontal' | 'vertical'; height?: number | string; width?: number; showValues?: boolean; scale?: boolean; stackValues?: boolean;
}) {
    const t = useMessages();
    const current = reading.state === 'live' || reading.state === 'silent';
    const amplitude = current ? Math.max(...reading.levels) : 0;
    const db = toDbfs(amplitude);
    const text = current ? `${Number.isFinite(db) ? db.toFixed(1) : '−∞'} dBFS` : t(meterStatusLabel(reading.state));
    const bars = orientation === 'horizontal' ? [Math.max(...reading.levels)] : reading.levels;
    const peaks = orientation === 'horizontal' ? [Math.max(...reading.peak)] : reading.peak;
    // 大型の縦表示では値と解除ボタンを下に置き、狭いサイドバーでもバー幅を保つ。
    const stacked = orientation === 'vertical' && stackValues;
    return <div className={`flex min-w-0 items-center gap-1 ${stacked ? 'h-full min-h-0 flex-col' : ''} ${orientation === 'horizontal' ? 'flex-1' : ''}`}>
        <div role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0}
            aria-valuenow={current ? Math.max(-60, Math.min(0, Number.isFinite(db) ? db : -60)) : undefined}
            aria-valuetext={text} title={t(meterStatusLabel(reading.state))}
            className={`flex min-w-0 gap-1 ${stacked ? 'min-h-0 flex-1' : ''} ${orientation === 'horizontal' ? 'flex-1' : ''}`} style={{ height: stacked ? undefined : height }}>
            {bars.map((value, i) => {
                const pct = current ? Math.min(100, Math.max(0, value * 100)) : 0;
                const peak = current ? Math.min(100, Math.max(0, peaks[i] * 100)) : 0;
                const color = peaks[i] >= CLIP_LEVEL ? 'bg-meter-danger' : peaks[i] >= WARNING_LEVEL ? 'bg-warning' : 'bg-success';
                return <div key={i} title={orientation === 'vertical' ? (i === 0 ? 'Left' : 'Right') : undefined}
                    className={`relative overflow-hidden rounded bg-muted ring-1 ring-border ${orientation === 'horizontal' ? 'h-full flex-1' : 'h-full'}`} style={orientation === 'vertical' ? { width } : undefined}>
                    <div className={`absolute bottom-0 left-0 ${orientation === 'horizontal' ? 'h-full' : 'right-0'} ${color}`} style={orientation === 'horizontal' ? { width: `${pct}%` } : { height: `${pct}%` }} />
                    {scale && [0, -6, -12, -24, -48].map(mark => <span key={mark} aria-hidden="true" className={`absolute bg-foreground/30 ${orientation === 'horizontal' ? 'top-0 bottom-0 w-px' : 'left-0 right-0 h-px'}`} style={orientation === 'horizontal' ? { left: `${Math.pow(10, mark / 20) * 100}%` } : { bottom: `${Math.pow(10, mark / 20) * 100}%` }} />)}
                    {current && <div aria-hidden="true" className={`absolute bg-foreground/80 ${orientation === 'horizontal' ? 'top-0 bottom-0 w-0.5' : 'left-0 right-0 h-0.5'}`} style={orientation === 'horizontal' ? { left: `${peak}%` } : { bottom: `${peak}%` }} />}
                </div>;
            })}
            {stacked && scale && <div aria-hidden="true" className="relative h-full w-8 shrink-0 text-xs text-muted-foreground font-mono">
                {/* 上端の0と下端の目盛りも、この欄の中へ収める。状態表示や値の欄へはみ出させない。 */}
                {[0, -6, -12, -24, -48].map(mark => <span key={mark} className="absolute left-1 leading-4"
                    style={{ top: `clamp(0px, calc(${100 - Math.pow(10, mark / 20) * 100}% - 0.5rem), calc(100% - 1rem))` }}>{mark}</span>)}
            </div>}
        </div>
        {/* 桁数・無音・更新待ちでバーの長さを変えないよう、値の欄は常に同じ幅と高さを確保する。 */}
        {showValues && <span className="inline-block h-4 w-[12ch] shrink-0 text-right text-xs leading-4 font-mono tabular-nums text-muted-foreground whitespace-nowrap">{current ? text : ''}</span>}
        {scale && <span className="sr-only">0, −6, −12, −24, −48 dBFS</span>}
        {reading.clipped && <button type="button" onClick={reading.resetClip} className="shrink-0 rounded border border-destructive/50 px-1 text-xs font-semibold text-destructive-text" aria-label={t('meter.clearClipNamed', { name: label })}>{t('meter.clip')}</button>}
    </div>;
}

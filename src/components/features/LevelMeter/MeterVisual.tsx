import { memo, useLayoutEffect, useRef, useState } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import { MdWarningAmber } from 'react-icons/md';
import { CLIP_LEVEL, WARNING_LEVEL, meterStatusLabel, toDbfs, type MeterReading } from '@/hooks/useMeterLevels';

export const MeterVisual = memo(function MeterVisual({ reading, label, orientation = 'vertical', height = 32, width = 8, showValues = false, numbers = true, scale = false, stackValues = false, statusOverlay = false }: {
    reading: MeterReading; label: string; orientation?: 'horizontal' | 'vertical'; height?: number | string; width?: number; showValues?: boolean;
    /** false では dBFS 値を出さず、無音・停止などの状態だけを言葉で示す（数値の詳細 OFF）。 */
    numbers?: boolean; scale?: boolean; stackValues?: boolean;
    /** 本番帯は状態をバーの中に重ね、高さと位置を変えない。 */
    statusOverlay?: boolean;
}) {
    const t = useMessages();
    const current = reading.state === 'live' || reading.state === 'silent';
    const amplitude = current ? Math.max(...reading.levels) : 0;
    // 無音通知の後もバーはなめらかに減衰するが、その残値を極端なdBFS値として表示しない。
    const db = toDbfs(reading.state === 'silent' ? 0 : amplitude);
    const text = current ? `${Number.isFinite(db) ? db.toFixed(1) : '−∞'} dBFS` : t(meterStatusLabel(reading.state));
    const statusText = t(meterStatusLabel(reading.state));
    const accessibleText = `${reading.state === 'silent' ? t('meter.silentLevel', { state: statusText, level: text }) : text}${reading.clipped ? ` — ${t('meter.clip')}` : ''}`;
    const displayText = orientation === 'horizontal' && reading.state !== 'live'
        ? t(reading.state === 'waiting' || reading.state === 'stale' ? 'meter.waitingShort' : meterStatusLabel(reading.state))
        : current && numbers ? text : '';
    const bars = orientation === 'horizontal' ? [Math.max(...reading.levels)] : reading.levels;
    const peaks = orientation === 'horizontal' ? [Math.max(...reading.peak)] : reading.peak;
    // 大型の縦表示では値と解除ボタンを下に置き、狭いサイドバーでもバー幅を保つ。
    const scaleRef = useRef<HTMLDivElement>(null);
    const [scaleHeight, setScaleHeight] = useState(0);
    // 実際のバー高に合わせ、隣の目盛りとの文字間隔を確保する。
    useLayoutEffect(() => {
        const node = scaleRef.current;
        if (!node || !scale || orientation !== 'vertical' || !stackValues) return;
        const update = () => setScaleHeight(node.getBoundingClientRect().height);
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, [scale, orientation, stackValues]);
    let previousMarkTop = -Infinity;
    const visibleMarks = [0, -6, -12, -24, -48].filter(mark => {
        const top = Math.max(0, Math.min(scaleHeight - 16, (1 - Math.pow(10, mark / 20)) * scaleHeight - 8));
        if (scaleHeight > 0 && top - previousMarkTop < 20) return false;
        previousMarkTop = top;
        return true;
    });
    const horizontalStatus = orientation === 'horizontal' && showValues && statusOverlay;
    const empty = reading.state !== 'live';
    const stacked = orientation === 'vertical' && stackValues;
    return <div className={`flex items-center gap-1 min-w-0 ${stacked ? 'h-full min-h-0 flex-col' : ''} ${orientation === 'horizontal' ? 'flex-1' : ''}`}>
        <div ref={scaleRef} role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0}
            aria-valuenow={current ? Math.max(-60, Math.min(0, Number.isFinite(db) ? db : -60)) : undefined}
            aria-valuetext={accessibleText} title={reading.state === 'waiting' || reading.state === 'stale' ? `${accessibleText} — ${t('meter.waitingHelp')}` : accessibleText}
            className={`meter-visual relative flex min-w-0 gap-1 ${stacked ? 'min-h-0 flex-1' : ''} ${orientation === 'horizontal' ? 'flex-1' : ''}`} style={{ height: stacked ? undefined : height }}>
            {bars.map((value, i) => {
                const pct = current ? Math.min(100, Math.max(0, value * 100)) : 0;
                const peak = current ? Math.min(100, Math.max(0, peaks[i] * 100)) : 0;
                const color = peaks[i] >= CLIP_LEVEL ? 'bg-meter-danger' : peaks[i] >= WARNING_LEVEL ? 'bg-meter-warning' : 'bg-success';
                return <div key={i} title={orientation === 'vertical' ? t(i === 0 ? 'meter.left' : 'meter.right') : undefined}
                    className={`relative overflow-hidden rounded ${empty ? 'bg-muted/40 ring-border/40' : 'bg-muted ring-border'} ring-1 ${orientation === 'horizontal' ? 'h-full flex-1' : 'h-full'}`} style={orientation === 'vertical' ? { width } : undefined}>
                    <div className={`absolute inset-0 ${orientation === 'horizontal' ? 'origin-left' : 'origin-bottom'} ${color}`} style={{ transform: orientation === 'horizontal' ? `scaleX(${pct / 100})` : `scaleY(${pct / 100})` }} />
                    {scale && [0, -6, -12, -24, -48].map(mark => <span key={mark} aria-hidden="true" className={`absolute ${empty ? 'bg-foreground/[0.12]' : 'bg-foreground/30'} ${orientation === 'horizontal' ? 'top-0 bottom-0 w-px' : 'left-0 right-0 h-px'}`} style={orientation === 'horizontal' ? { left: `${Math.pow(10, mark / 20) * 100}%` } : { bottom: `${Math.pow(10, mark / 20) * 100}%` }} />)}
                    {/* 親と同寸の層を動かし、ピーク線の太さと外枠の角丸は拡縮しない。 */}
                    {current && <div aria-hidden="true" className="absolute inset-0" style={{ transform: orientation === 'horizontal' ? `translateX(${peak}%)` : `translateY(${-peak}%)` }}>
                        <div className={`absolute bg-foreground/80 ${orientation === 'horizontal' ? 'left-0 top-0 bottom-0 w-0.5' : 'bottom-0 left-0 right-0 h-0.5'}`} />
                    </div>}
                </div>;
            })}
            {/* 文字の背面を不透明にし、目盛りや減衰中の色と重なっても読めるようにする。 */}
            {horizontalStatus && empty && <span title={accessibleText} data-meter-status
                className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center rounded bg-background px-1 text-xs leading-4 text-muted-foreground">{displayText}</span>}
            {stacked && scale && <div aria-hidden="true" className="relative h-full w-8 shrink-0 text-xs text-muted-foreground font-mono">
                {/* 上端の0と下端の目盛りも、この欄の中へ収める。状態表示や値の欄へはみ出させない。 */}
                {visibleMarks.map(mark => <span key={mark} className="absolute left-1 leading-4"
                    style={{ top: `clamp(0px, calc(${100 - Math.pow(10, mark / 20) * 100}% - 0.5rem), calc(100% - 1rem))` }}>{mark}</span>)}
            </div>}
        </div>
        {/* 従来の横方向の値欄は保ち、状態文だけをバー内へ移す。行は追加しない。 */}
        {showValues && (numbers || orientation === 'horizontal') && <span title={accessibleText} data-meter-status={horizontalStatus && empty ? undefined : true} aria-hidden={horizontalStatus && empty ? true : undefined} className={`min-w-0 max-w-[12ch] basis-[12ch] shrink break-words text-xs leading-4 text-muted-foreground ${orientation === 'horizontal' ? 'text-left' : 'text-right'} ${horizontalStatus ? 'h-4 overflow-hidden' : ''} ${horizontalStatus && empty ? 'invisible' : ''} ${numbers ? 'font-mono tabular-nums' : ''}`}>{displayText}</span>}
        {scale && <span className="sr-only">0, −6, −12, −24, −48 dBFS</span>}
        {/* 警告の有無で横バーの幅・縦バーの高さを変えない。解除操作の場所も固定する。 */}
        <span className="inline-flex h-5 w-6 shrink-0 items-center justify-center">
            {reading.clipped && <button type="button" onClick={reading.resetClip}
                title={`${t('meter.clipAge', { seconds: reading.clipSecondsAgo ?? 0 })} — ${t('meter.clearClipNamed', { name: label })}`}
                className={`relative before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] rounded border p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${reading.clipSecondsAgo != null && reading.clipSecondsAgo >= 10 ? 'border-border text-muted-foreground hover:bg-muted' : 'border-meter-danger/50 text-meter-danger hover:bg-destructive/10'}`}
                aria-label={t('meter.clearClipNamed', { name: label })}>
                <MdWarningAmber aria-hidden="true" className="h-4 w-4" /><span className="sr-only">{t('meter.clip')}</span>
            </button>}
        </span>
    </div>;
});

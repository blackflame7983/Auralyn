import { useId, type CSSProperties } from 'react';

export function AuroraRibbons({ running, style }: { running: boolean; style: CSSProperties }) {
    const id = useId().replace(/:/g, '');
    const ribbons = [
        { d: 'M-80 150 C 140 60, 300 210, 520 120 S 860 40, 1080 130 S 1320 200, 1480 90', strands: 9, spread: 5 },
        { d: 'M-60 190 C 180 120, 360 250, 600 170 S 940 110, 1180 190 S 1380 230, 1500 160', strands: 7, spread: 6 },
        { d: 'M-40 110 C 220 170, 420 40, 700 100 S 1020 170, 1260 80 S 1420 60, 1520 110', strands: 6, spread: 4 },
    ];
    return <div aria-hidden="true" className="live-aurora" data-lit={running} style={style}>
        <svg className="h-full w-full" viewBox="0 0 1440 260" preserveAspectRatio="xMidYMid slice">
            <defs>
                <linearGradient id={`${id}-v`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--aurora-rose))" stopOpacity="0.55" />
                    <stop offset="28%" stopColor="hsl(var(--aurora-green))" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="hsl(var(--aurora-teal))" stopOpacity="0.15" />
                </linearGradient>
                <linearGradient id={`${id}-h`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="hsl(var(--aurora-green))" stopOpacity="0" />
                    <stop offset="22%" stopColor="hsl(var(--aurora-green))" stopOpacity="1" />
                    <stop offset="78%" stopColor="hsl(var(--aurora-green))" stopOpacity="1" />
                    <stop offset="100%" stopColor="hsl(var(--aurora-green))" stopOpacity="0" />
                </linearGradient>
                <mask id={`${id}-m`}><rect width="1440" height="260" fill={`url(#${id}-h)`} /></mask>
            </defs>
            <g mask={`url(#${id}-m)`}>
                {ribbons.map((ribbon, index) => <g key={index} className="live-aurora-ribbon">
                    {/* ぼかしの代わりに、太く薄い線を重ねて光のにじみを作る。 */}
                    <path d={ribbon.d} fill="none" stroke={`url(#${id}-v)`} strokeWidth={64} strokeOpacity={0.2} strokeLinecap="round" />
                    <path d={ribbon.d} fill="none" stroke={`url(#${id}-v)`} strokeWidth={28} strokeOpacity={0.32} strokeLinecap="round" />
                    {/* 細い線の束で、カーテンの縦の筋を見せる。 */}
                    {Array.from({ length: ribbon.strands }, (_, strand) => <path key={strand} d={ribbon.d}
                        transform={`translate(0 ${(strand - ribbon.strands / 2) * ribbon.spread})`}
                        fill="none" stroke={`url(#${id}-v)`} strokeWidth={strand % 3 === 0 ? 2 : 1.1}
                        strokeOpacity={0.5 + (strand % 4) * 0.15} vectorEffect="non-scaling-stroke" />)}
                </g>)}
            </g>
        </svg>
    </div>;
}


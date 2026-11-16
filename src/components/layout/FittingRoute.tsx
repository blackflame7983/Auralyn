import { useRef } from 'react';
import { useFitRouteStart } from '@/hooks/useFitRouteStart';
import { ROUTE_JOIN, routeSegments } from '@/lib/routeFit';
import { cn } from '@/lib/utils';

// 経路を区切りごとの要素にし、入らない分は先頭から隠す。全文は読み上げと title に残す。
// 区切りの「 → 」の前後の空白は要素の端で詰められるので、whitespace-pre で保つ（測る側も同じ）。
export function FittingRoute({ route }: { route: string }) {
    const box = useRef<HTMLSpanElement>(null);
    const segments = routeSegments(route);
    const hidden = useFitRouteStart(box, route);
    const clipLast = segments.length - hidden === 1;
    return (
        <span ref={box} data-route-box title={route} className="relative block min-w-0 flex-1 overflow-hidden text-ui-support text-muted-foreground">
            <span className="sr-only">{route}</span>
            <span aria-hidden="true" data-route-visual data-audit-truncate className="flex min-w-0 max-w-full items-baseline overflow-hidden">
                {hidden > 0 && <span className="shrink-0 whitespace-pre">{`…${ROUTE_JOIN}`}</span>}
                {segments.map((part, index) => index < hidden ? null : (
                    <span key={index} className={cn(clipLast ? 'min-w-0 overflow-hidden text-ellipsis whitespace-pre' : 'shrink-0 whitespace-pre')}>
                        {index > hidden ? ROUTE_JOIN : ''}{part}
                    </span>
                ))}
            </span>
            <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 flex whitespace-pre opacity-0">
                <span data-route-ellipsis>…</span>
                <span data-route-sep className="whitespace-pre">{ROUTE_JOIN}</span>
                {segments.map((part, index) => <span key={index} data-route-seg className="whitespace-pre">{part}</span>)}
            </span>
        </span>
    );
}

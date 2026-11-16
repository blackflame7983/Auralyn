import { useRef } from 'react';
import { useFitRouteStart } from '@/hooks/useFitRouteStart';
import { ROUTE_JOIN, routeSegments } from '@/lib/routeFit';
import { cn } from '@/lib/utils';

// 経路を区切りごとの要素にし、入らない分は先頭から隠す。全文は読み上げと title に残す。
export function FittingRoute({ route }: { route: string }) {
    const box = useRef<HTMLSpanElement>(null);
    const segments = routeSegments(route);
    const hidden = useFitRouteStart(box, route);
    const clipLast = segments.length - hidden === 1;
    return (
        <span ref={box} data-route-box title={route} className="relative block min-w-0 flex-1 overflow-hidden text-ui-support text-muted-foreground">
            <span className="sr-only">{route}</span>
            <span aria-hidden="true" data-route-visual data-audit-truncate className="flex min-w-0 max-w-full items-baseline overflow-hidden">
                {hidden > 0 && <span className="shrink-0 whitespace-nowrap">{`…${ROUTE_JOIN}`}</span>}
                {segments.map((part, index) => index < hidden ? null : (
                    <span key={index} className={cn(clipLast ? 'min-w-0 truncate' : 'shrink-0 whitespace-nowrap')}>
                        {index > hidden ? ROUTE_JOIN : ''}{part}
                    </span>
                ))}
            </span>
            <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 flex whitespace-nowrap opacity-0">
                <span data-route-ellipsis>…</span>
                <span data-route-sep>{ROUTE_JOIN}</span>
                {segments.map((part, index) => <span key={index} data-route-seg className="whitespace-nowrap">{part}</span>)}
            </span>
        </span>
    );
}

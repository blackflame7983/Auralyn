import { useRef } from 'react';
import { useFitRouteStart } from '@/hooks/useFitRouteStart';
import { ROUTE_JOIN, routeSegments } from '@/lib/routeFit';
import { cn } from '@/lib/utils';

const NO_COMPACT: readonly string[] = [];

// 経路を区切りごとの要素にし、入らない分は先頭から隠す。送り先（最後の区切り）は切らず、
// 入らないときは送り先の短い形（compact、長い順）に替える。全文は読み上げと title に残す。
// 区切りの「 → 」の前後の空白は要素の端で詰められるので、whitespace-pre で保つ（測る側も同じ）。
export function FittingRoute({ route, compact = NO_COMPACT }: { route: string; compact?: readonly string[] }) {
    const box = useRef<HTMLSpanElement>(null);
    const segments = routeSegments(route);
    const { hidden, variant, clipped } = useFitRouteStart(box, route, compact);
    const lastIndex = segments.length - 1;
    const shown = (part: string, index: number) => index === lastIndex && variant > 0 ? compact[variant - 1] ?? part : part;
    return (
        <span ref={box} data-route-box title={route} className="relative block min-w-0 flex-1 overflow-hidden text-ui-support text-muted-foreground">
            <span className="sr-only">{route}</span>
            <span aria-hidden="true" data-route-visual data-audit-truncate className="flex min-w-0 max-w-full items-baseline overflow-hidden">
                {hidden > 0 && <span className="shrink-0 whitespace-pre">{`…${ROUTE_JOIN}`}</span>}
                {segments.map((part, index) => index < hidden ? null : (
                    <span key={index} className={cn(clipped && index === lastIndex ? 'min-w-0 overflow-hidden text-ellipsis whitespace-pre' : 'shrink-0 whitespace-pre')}>
                        {index > hidden ? ROUTE_JOIN : ''}{shown(part, index)}
                    </span>
                ))}
            </span>
            <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 flex whitespace-pre opacity-0">
                <span data-route-ellipsis>…</span>
                <span data-route-sep className="whitespace-pre">{ROUTE_JOIN}</span>
                {segments.map((part, index) => <span key={index} data-route-seg className="whitespace-pre">{part}</span>)}
                {compact.map((part, index) => <span key={`alt-${index}`} data-route-alt className="whitespace-pre">{part}</span>)}
            </span>
        </span>
    );
}

import { useLayoutEffect, useState, type RefObject } from 'react';
import { fitRoute, type RouteFit } from '@/lib/routeFit';

const UNFITTED: RouteFit = { hidden: 0, variant: 0, clipped: false };

// 箱の幅が変わったときだけ、隠す区切りの数と送り先の形を決める。中身の文字では幅は変わらない。
export function useFitRouteStart(box: RefObject<HTMLElement | null>, route: string, compact: readonly string[]): RouteFit {
    const [fit, setFit] = useState<RouteFit>(UNFITTED);
    const alternatives = compact.join('\n');
    useLayoutEffect(() => {
        const element = box.current;
        if (!element) return;
        const measure = (selector: string) => [...element.querySelectorAll<HTMLElement>(selector)].map(node => node.offsetWidth);
        const fitNow = () => {
            const separator = element.querySelector<HTMLElement>('[data-route-sep]')?.offsetWidth ?? 0;
            const ellipsis = element.querySelector<HTMLElement>('[data-route-ellipsis]')?.offsetWidth ?? 0;
            const next = fitRoute(measure('[data-route-seg]'), measure('[data-route-alt]'), separator, ellipsis, element.clientWidth);
            setFit(current => current.hidden === next.hidden && current.variant === next.variant && current.clipped === next.clipped ? current : next);
        };
        fitNow();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(fitNow);
        observer.observe(element);
        return () => observer.disconnect();
    }, [box, route, alternatives]);
    return fit;
}

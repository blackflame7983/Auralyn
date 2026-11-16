import { useLayoutEffect, useState, type RefObject } from 'react';
import { hiddenRoutePrefix } from '@/lib/routeFit';

// 箱の幅が変わったときだけ、先頭から隠す区切りの数を決める。中身の文字では幅は変わらない。
export function useFitRouteStart(box: RefObject<HTMLElement | null>, route: string): number {
    const [hidden, setHidden] = useState(0);
    useLayoutEffect(() => {
        const element = box.current;
        if (!element) return;
        const fit = () => {
            const widths = [...element.querySelectorAll<HTMLElement>('[data-route-seg]')].map(node => node.offsetWidth);
            const separator = element.querySelector<HTMLElement>('[data-route-sep]')?.offsetWidth ?? 0;
            const ellipsis = element.querySelector<HTMLElement>('[data-route-ellipsis]')?.offsetWidth ?? 0;
            const next = hiddenRoutePrefix(widths, separator, ellipsis, element.clientWidth);
            setHidden(current => current === next ? current : next);
        };
        fit();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(fit);
        observer.observe(element);
        return () => observer.disconnect();
    }, [box, route]);
    return hidden;
}

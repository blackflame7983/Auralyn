import { useLayoutEffect, useState, type RefObject } from 'react';

/** 縦メーターの目盛りを、実際のバーの高さに合わせる。 */
export function useMeterScaleHeight(node: RefObject<HTMLElement | null>, enabled: boolean): number {
    const [height, setHeight] = useState(0);
    useLayoutEffect(() => {
        const element = node.current;
        if (!element || !enabled) return;
        const update = () => setHeight(element.getBoundingClientRect().height);
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [node, enabled]);
    return height;
}

import { useLayoutEffect, useRef } from 'react';
import { fadeBox, findColumnScroller, moreBelow, readScrollMetrics, saveBarNear } from '@/lib/columnScrollHint';

function sameElements(left: Set<Element>, right: Set<Element>): boolean {
    if (left.size !== right.size) return false;
    for (const element of left) if (!right.has(element)) return false;
    return true;
}

function cssPx(value: number): string {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    return `${value / scale}px`;
}

// 中央の列に続きがあるとき、下端へ静止したフェードを出す。読み上げには出さない。
export function useColumnScrollHint() {
    const placeRef = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
        const fade = document.createElement('div');
        fade.className = 'column-scroll-more';
        fade.setAttribute('aria-hidden', 'true');
        fade.setAttribute('data-scroll-more', '');
        fade.hidden = true;
        document.body.appendChild(fade);

        let scroller: HTMLElement | null = null;
        let observer: ResizeObserver | null = null;
        let watched = new Set<Element>();

        const place = () => {
            const next = findColumnScroller(document);
            if (next !== scroller) {
                scroller?.removeEventListener('scroll', place);
                observer?.disconnect();
                observer = null;
                watched = new Set();
                scroller = next;
                if (scroller) scroller.addEventListener('scroll', place, { passive: true });
            }
            if (scroller && typeof ResizeObserver !== 'undefined') {
                const targets = new Set<Element>([scroller, ...scroller.children]);
                const bar = saveBarNear(scroller);
                if (bar) targets.add(bar);
                if (!observer || !sameElements(watched, targets)) {
                    observer?.disconnect();
                    observer = new ResizeObserver(place);
                    for (const element of targets) observer.observe(element);
                    watched = targets;
                }
            }
            const bar = scroller ? saveBarNear(scroller) : null;
            const box = scroller && moreBelow(readScrollMetrics(scroller))
                ? fadeBox(scroller.getBoundingClientRect(), bar?.getBoundingClientRect() ?? null)
                : null;
            fade.hidden = !box;
            if (!box) return;
            fade.style.top = cssPx(box.top);
            fade.style.left = cssPx(box.left);
            fade.style.width = cssPx(box.width);
            fade.style.height = cssPx(box.height);
        };

        placeRef.current = place;
        place();
        return () => {
            placeRef.current = null;
            scroller?.removeEventListener('scroll', place);
            observer?.disconnect();
            fade.remove();
        };
    }, []);
    useLayoutEffect(() => {
        placeRef.current?.();
    });
}

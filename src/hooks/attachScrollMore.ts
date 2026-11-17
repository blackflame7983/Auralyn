import { fadeBox, moreBelow, readScrollMetrics } from '@/lib/columnScrollHint';

function sameElements(left: Set<Element>, right: Set<Element>): boolean {
    if (left.size !== right.size) return false;
    for (const element of left) if (!right.has(element)) return false;
    return true;
}

export function cssPx(value: number): string {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    return `${value / scale}px`;
}

export function attachScrollMore(
    findScroller: () => HTMLElement | null,
    findLimit: (scroller: HTMLElement) => HTMLElement | null,
    applyBox: (box: { top: number; left: number; width: number; height: number } | null) => void,
): { place: () => void; stop: () => void } {
    let scroller: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;
    let children: MutationObserver | null = null;
    let watched = new Set<Element>();

    const place = () => {
        const next = findScroller();
        if (next !== scroller) {
            scroller?.removeEventListener('scroll', place);
            observer?.disconnect();
            observer = null;
            children?.disconnect();
            children = null;
            watched = new Set();
            scroller = next;
            if (scroller) {
                scroller.addEventListener('scroll', place, { passive: true });
                if (typeof MutationObserver !== 'undefined') {
                    children = new MutationObserver(place);
                    children.observe(scroller, { childList: true });
                }
            }
        }
        if (scroller && typeof ResizeObserver !== 'undefined') {
            const targets = new Set<Element>([scroller, ...scroller.children]);
            const limit = findLimit(scroller);
            if (limit) targets.add(limit);
            if (!observer || !sameElements(watched, targets)) {
                observer?.disconnect();
                observer = new ResizeObserver(place);
                for (const element of targets) observer.observe(element);
                watched = targets;
            }
        }
        const limit = scroller ? findLimit(scroller) : null;
        const box = scroller && moreBelow(readScrollMetrics(scroller))
            ? fadeBox(scroller.getBoundingClientRect(), limit?.getBoundingClientRect() ?? null)
            : null;
        applyBox(box);
    };

    return {
        place,
        stop() {
            scroller?.removeEventListener('scroll', place);
            observer?.disconnect();
            children?.disconnect();
        },
    };
}

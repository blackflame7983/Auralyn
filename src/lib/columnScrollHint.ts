export const COLUMN_FADE_HEIGHT = 24;

export function moreBelow(metrics: { scrollHeight: number; clientHeight: number; scrollTop: number; paddingBottom: number }): boolean {
    return metrics.scrollHeight - metrics.paddingBottom - metrics.clientHeight - metrics.scrollTop > 1;
}

export function readScrollMetrics(element: HTMLElement): { scrollHeight: number; clientHeight: number; scrollTop: number; paddingBottom: number } {
    const padding = Number.parseFloat(getComputedStyle(element).paddingBottom);
    return {
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollTop: element.scrollTop,
        paddingBottom: Number.isFinite(padding) ? padding : 0,
    };
}

function scrolls(element: HTMLElement): boolean {
    return /(auto|scroll)/.test(getComputedStyle(element).overflowY);
}

// ホームは中央の列自身がスクロールする。ほかのページは、その中で一番広いスクロールを列にする。
export function findColumnScroller(root: ParentNode): HTMLElement | null {
    const main = root.querySelector('main.home-main');
    if (!(main instanceof HTMLElement)) return null;
    if (scrolls(main)) return main;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    // 列の中の全要素を調べると重いので、スクロールの指定を持つ要素だけを候補にする。
    // スクロールする列は、どれも overflow のクラスか style で指定している（#691）。
    const candidates = main.querySelectorAll<HTMLElement>('[class*="overflow-y-auto"], [class*="overflow-auto"], [class*="overflow-y-scroll"], [class*="overflow-scroll"], [style*="overflow"]');
    for (const node of candidates) {
        if (!scrolls(node)) continue;
        const area = node.clientWidth * node.clientHeight;
        if (area <= bestArea) continue;
        best = node;
        bestArea = area;
    }
    return best;
}

export function saveBarNear(scroller: HTMLElement): HTMLElement | null {
    const root = scroller.parentElement;
    if (!root) return null;
    const bottom = scroller.getBoundingClientRect().bottom;
    const bars = [...root.querySelectorAll<HTMLElement>('[data-save-bar]')].filter(bar => !scroller.contains(bar));
    const nearest = bars
        .map(bar => ({ bar, top: bar.getBoundingClientRect().top }))
        .filter(item => item.top <= bottom + 1)
        .sort((a, b) => b.top - a.top)[0];
    return nearest?.bar ?? null;
}

// 保存の欄があるときは、その上端でフェードを止める。欄が列の下端に接するときは列の下端と同じ位置になる。
export function fadeBox(scroller: DOMRect, saveBar: DOMRect | null): { top: number; left: number; width: number; height: number } | null {
    if (scroller.width < 1 || scroller.height < COLUMN_FADE_HEIGHT) return null;
    const limit = saveBar && saveBar.top < scroller.bottom - 1 ? saveBar.top : scroller.bottom;
    const top = limit - COLUMN_FADE_HEIGHT;
    if (top < scroller.top) return null;
    return { top, left: scroller.left, width: scroller.width, height: COLUMN_FADE_HEIGHT };
}

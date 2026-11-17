import { fadeBox, moreBelow, readScrollMetrics, scrollToClearFade } from '@/lib/columnScrollHint';

function sameElements(left: Set<Element>, right: Set<Element>): boolean {
    if (left.size !== right.size) return false;
    for (const element of left) if (!right.has(element)) return false;
    return true;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// react-icons/md の MdKeyboardArrowDown と同じ形。フェードを素のDOMで作るため、パスをここに置く。
const CHEVRON_DOWN = 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z';

// 続きがある印。フェードと下向きの山形を1つの部品にして、中央の列とダイアログで同じ見た目にする。
export function createScrollMoreFade(variant: '' | 'dialog'): HTMLDivElement {
    const fade = document.createElement('div');
    fade.className = variant ? `column-scroll-more ${variant}-scroll-more` : 'column-scroll-more';
    fade.setAttribute('aria-hidden', 'true');
    fade.setAttribute('data-scroll-more', variant);
    fade.hidden = true;
    const chevron = document.createElementNS(SVG_NS, 'svg');
    chevron.setAttribute('class', 'scroll-more-chevron');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', CHEVRON_DOWN);
    chevron.append(path);
    fade.append(chevron);
    return fade;
}
// 画面の座標（拡大表示を含む）を、要素の CSS px へ戻す。
function unzoom(value: number): number {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    return value / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
}
export function cssPx(value: number): string {
    return `${unzoom(value)}px`;
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

    const currentBox = () => {
        const limit = scroller ? findLimit(scroller) : null;
        return scroller && moreBelow(readScrollMetrics(scroller))
            ? fadeBox(scroller.getBoundingClientRect(), limit?.getBoundingClientRect() ?? null)
            : null;
    };

    // 焦点が入った要素の枠がフェードに隠れるなら、その分だけ本文を送る。scroll-padding を持たない本文では、
    // 一部でも見えている要素へ焦点を移してもブラウザーは送らない。フェードが出ているときだけ補い、動きは付けずすぐに送る。
    // マウスで押した要素は送らない。押している間に要素が動くと、クリックが成立しなくなる。
    const clearFade = (event: FocusEvent) => {
        const box = currentBox();
        if (scroller && box && event.target instanceof Element && event.target.matches(':focus-visible')) {
            const delta = scrollToClearFade(event.target.getBoundingClientRect(), scroller.getBoundingClientRect(), box.top);
            if (delta !== 0) scroller.scrollBy({ top: unzoom(delta), behavior: 'instant' });
        }
        // ブラウザーの送りでスクロールの位置が変わっていることがある。スクロールの通知を待たず、フェードを今の位置に合わせる。
        applyBox(currentBox());
    };

    const place = () => {
        const next = findScroller();
        if (next !== scroller) {
            scroller?.removeEventListener('scroll', place);
            scroller?.removeEventListener('focusin', clearFade);
            observer?.disconnect();
            observer = null;
            children?.disconnect();
            children = null;
            watched = new Set();
            scroller = next;
            if (scroller) {
                scroller.addEventListener('scroll', place, { passive: true });
                scroller.addEventListener('focusin', clearFade);
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
        applyBox(currentBox());
    };

    return {
        place,
        stop() {
            scroller?.removeEventListener('scroll', place);
            scroller?.removeEventListener('focusin', clearFade);
            observer?.disconnect();
            children?.disconnect();
        },
    };
}

// 見えているかの判定。画面の検査（screenAudit）と、文字の折り返しの検査（shortLines）が同じ基準で調べる。
// createVisibility はブラウザの中で動く。関数を文字列にして送るので、外側の変数を参照しない。

export interface PageVisibility {
    /** 閉じたメニュー・aria-hidden・inert・opacity 0 などを除いた、画面に出ている要素か。 */
    isVisible(element: Element): boolean;
    /** テキストノードが画面に出ているか。親が display: contents のときは、箱を持つ祖先で見る。 */
    isTextVisible(node: Node): boolean;
    /**
     * from から親をたどり、overflow で切り取る祖先の箱を集める。
     * reachableByScroll が true のときは、スクロールで届く文字を数えるため、最初のスクロール領域（auto・scroll）より外の切り取りを見ない。
     */
    clipLimits(from: Element | null, reachableByScroll?: boolean): DOMRect[];
    /** 切り取りの箱との共通部分。1px 未満しか残らなければ null。 */
    clipRect(rect: DOMRect, limits: DOMRect[]): DOMRect | null;
}

export function createVisibility(): PageVisibility {
    const visibleCache = new WeakMap<Element, boolean>();
    const isVisible = (element: Element): boolean => {
        const cached = visibleCache.get(element);
        if (cached !== undefined) return cached;
        let visible = true;
        // 閉じたメニューの中は見えない。ボタン自身の data-state="closed" は、ツールチップが閉じている印なので外さない。
        const closed = element.closest('[data-state="closed"]');
        const closedPanel = closed !== null && !closed.matches('button, a, summary, [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="menuitem"]');
        if (element.closest('[aria-hidden="true"], .sr-only, [hidden], [inert]') || closedPanel) visible = false;
        else {
            const details = element.closest('details');
            if (details && !details.open) {
                const summary = details.querySelector(':scope > summary');
                if (summary !== element && !summary?.contains(element)) visible = false;
            }
            for (let node: Element | null = element; node && visible; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') visible = false;
                if (Number(style.opacity) === 0) visible = false;
            }
            if (visible) {
                const box = element.getBoundingClientRect();
                // 1px 未満は、画面に出ていないものとして外す。
                if (box.width < 1 || box.height < 1) visible = false;
            }
        }
        visibleCache.set(element, visible);
        return visible;
    };
    const holder = (node: Node): Element | null => {
        let current = node.parentElement;
        while (current && getComputedStyle(current).display === 'contents') current = current.parentElement;
        return current;
    };
    const clips = (style: CSSStyleDeclaration) => /\b(hidden|clip|auto|scroll)\b/.test(`${style.overflowX} ${style.overflowY}`);
    const clipLimits = (from: Element | null, reachableByScroll = false): DOMRect[] => {
        const limits: DOMRect[] = [];
        for (let node = from; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'contents' || !clips(style)) continue;
            if (reachableByScroll && /\b(auto|scroll)\b/.test(`${style.overflowX} ${style.overflowY}`)) break;
            limits.push(node.getBoundingClientRect());
        }
        return limits;
    };
    const clipRect = (rect: DOMRect, limits: DOMRect[]): DOMRect | null => {
        let current: DOMRect | null = rect;
        for (const limit of limits) {
            if (!current) break;
            const left = Math.max(current.left, limit.left);
            const right = Math.min(current.right, limit.right);
            const top = Math.max(current.top, limit.top);
            const bottom = Math.min(current.bottom, limit.bottom);
            current = right - left >= 1 && bottom - top >= 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
        }
        return current;
    };
    const isTextVisible = (node: Node): boolean => {
        const owner = holder(node);
        return owner !== null && isVisible(owner);
    };
    return { isVisible, isTextVisible, clipLimits, clipRect };
}

/** ブラウザの中で createVisibility() を呼ぶ式。page.evaluate などへ渡す文字列に埋め込む。 */
export const visibilityExpression = `(${createVisibility.toString()})()`;

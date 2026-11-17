import { useLayoutEffect, useRef } from 'react';
import { afterFrame } from './internal/afterFrame';
import { dialogScrollLimit, findDialogScroller } from '@/lib/columnScrollHint';
import { attachScrollMore, cssPx } from './attachScrollMore';

function edge(style: CSSStyleDeclaration, side: 'borderTopWidth' | 'borderLeftWidth'): number {
    const value = Number.parseFloat(style[side]);
    return Number.isFinite(value) ? value : 0;
}

// ダイアログの本文に続きがあるとき、本文の下端へ静止したフェードを出す。読み上げには出さない。
export function useDialogScrollHint(root: HTMLElement | null) {
    const placeRef = useRef<(() => void) | null>(null);
    const cancelFrameRef = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
        const host = root?.querySelector('.modal-surface-base');
        if (!root || !(host instanceof HTMLElement)) return;
        const fade = document.createElement('div');
        fade.className = 'column-scroll-more dialog-scroll-more';
        fade.setAttribute('aria-hidden', 'true');
        fade.setAttribute('data-scroll-more', 'dialog');
        fade.hidden = true;
        host.appendChild(fade);
        const attached = attachScrollMore(
            () => findDialogScroller(root),
            dialogScrollLimit,
            box => {
                fade.hidden = !box;
                if (!box) return;
                const origin = host.getBoundingClientRect();
                const border = getComputedStyle(host);
                fade.style.top = cssPx(box.top - origin.top - edge(border, 'borderTopWidth'));
                fade.style.left = cssPx(box.left - origin.left - edge(border, 'borderLeftWidth'));
                fade.style.width = cssPx(box.width);
                fade.style.height = cssPx(box.height);
            },
        );
        placeRef.current = attached.place;
        attached.place();
        return () => {
            placeRef.current = null;
            cancelFrameRef.current?.();
            cancelFrameRef.current = null;
            attached.stop();
            fade.remove();
        };
    }, [root]);
    useLayoutEffect(() => {
        if (cancelFrameRef.current || !placeRef.current) return;
        cancelFrameRef.current = afterFrame(() => {
            cancelFrameRef.current = null;
            placeRef.current?.();
        });
    });
}

import { useLayoutEffect, useRef } from 'react';
import { afterFrame } from './internal/afterFrame';
import { findColumnScroller, saveBarNear } from '@/lib/columnScrollHint';
import { attachScrollMore, createScrollMoreFade, cssPx } from './attachScrollMore';

// 中央の列に続きがあるとき、下端へ静止したフェードを出す。読み上げには出さない。
export function useColumnScrollHint() {
    // 描き直しのたびに列を探すと、要素が多い画面では重い（列の中を全部調べることがある）。
    // 描き直しからの置き直しは、1フレームに1回へまとめる。スクロール・大きさ・子の出入りは、その場で置き直す。
    const placeRef = useRef<(() => void) | null>(null);
    const cancelFrameRef = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
        const fade = createScrollMoreFade('');
        document.body.appendChild(fade);
        const attached = attachScrollMore(
            () => findColumnScroller(document),
            saveBarNear,
            box => {
                fade.hidden = !box;
                if (!box) return;
                fade.style.top = cssPx(box.top);
                fade.style.left = cssPx(box.left);
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
    }, []);
    useLayoutEffect(() => {
        if (cancelFrameRef.current || !placeRef.current) return;
        cancelFrameRef.current = afterFrame(() => {
            cancelFrameRef.current = null;
            placeRef.current?.();
        });
    });
}

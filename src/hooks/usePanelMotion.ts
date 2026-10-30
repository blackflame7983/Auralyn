import { useEffect, useLayoutEffect, useState, type TransitionEvent } from 'react';

// 出口の間だけ内容を残す。閉じる操作自体（保存値・フォーカス・inert）は待たせない。
export function usePanelMotion(open: boolean) {
    const [retained, setRetained] = useState(open);
    const [instant, setInstant] = useState(true);
    useEffect(() => {
        const pointer = () => setInstant(false);
        const keyboard = () => setInstant(true);
        window.addEventListener('pointerdown', pointer, true);
        window.addEventListener('keydown', keyboard, true);
        return () => {
            window.removeEventListener('pointerdown', pointer, true);
            window.removeEventListener('keydown', keyboard, true);
        };
    }, []);
    useLayoutEffect(() => {
        if (open) { setRetained(true); return; }
        if (!retained) return;
        const token = getComputedStyle(document.documentElement).getPropertyValue('--motion-panel').trim();
        const parsed = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
        const duration = instant || !Number.isFinite(parsed) ? 0 : parsed;
        if (duration <= 0) { setRetained(false); return; }
        // 非表示のウィンドウなどで transitionend が届かなくても必ず片付ける。
        const timer = window.setTimeout(() => setRetained(false), duration + 50);
        return () => window.clearTimeout(timer);
    }, [open, retained, instant]);
    const onTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
        if (!open && event.target === event.currentTarget && event.propertyName === 'opacity') setRetained(false);
    };
    return { present: open || retained, instant, onTransitionEnd };
}

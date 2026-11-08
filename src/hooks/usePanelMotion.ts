import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { useReducedMotion, type Transition, type Variants } from 'motion/react';

function readToken(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** `--motion-panel` を秒へ。読めないときは動かさない。 */
function panelDuration() {
    const token = readToken('--motion-panel');
    const parsed = parseFloat(token) * (token.endsWith('ms') ? 0.001 : 1);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** `--ease-drawer` の cubic-bezier を Motion の曲線へ。読めないときは既定の ease-out。 */
function drawerEase(): [number, number, number, number] | 'easeOut' {
    const match = /cubic-bezier\(([^)]+)\)/.exec(readToken('--ease-drawer'));
    const values = match?.[1].split(',').map(Number);
    return values?.length === 4 && values.every(Number.isFinite) ? values as [number, number, number, number] : 'easeOut';
}

// 出口の間だけ内容を残す（AnimatePresence）。閉じる操作自体（保存値・フォーカス・inert）は待たせない。
// transform は文字列で渡し、Motion に WAAPI で合成させる（メインスレッドの毎フレーム更新にしない）。
export function usePanelMotion(open: boolean, panelRef: RefObject<HTMLElement | null>) {
    const [instant, setInstant] = useState(true);
    const [exiting, setExiting] = useState(false);
    const reduced = useReducedMotion() ?? false;
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
    const [wasOpen, setWasOpen] = useState(open);
    if (wasOpen !== open) {
        setWasOpen(open);
        setExiting(!open);
    }
    const duration = instant ? 0 : panelDuration();
    const finishNow = useCallback(() => {
        panelRef.current?.getAnimations?.().forEach(animation => animation.finish());
    }, [panelRef]);
    useLayoutEffect(() => {
        if (!exiting) return;
        // 終了途中でキーボードへ切り替えたら、残りの動きを待たずに片付ける。
        if (instant) { finishNow(); return; }
        // 非表示のウィンドウなどで終了通知が届かなくても必ず片付ける。
        const timer = window.setTimeout(finishNow, duration * 1000 + 50);
        return () => window.clearTimeout(timer);
    }, [exiting, instant, duration, finishNow]);
    const variants = useMemo<Variants>(() => ({
        hidden: { opacity: 0, transform: reduced ? 'none' : 'translateX(100%)' },
        shown: { opacity: 1, transform: reduced ? 'none' : 'translateX(0%)' },
    }), [reduced]);
    const transition = useMemo<Transition>(() => ({ duration, ease: drawerEase() }), [duration]);
    return {
        present: open || exiting,
        instant,
        motionProps: {
            variants,
            transition,
            initial: instant ? false as const : 'hidden',
            animate: 'shown',
            exit: 'hidden',
        },
        onExitComplete: () => setExiting(false),
    };
}

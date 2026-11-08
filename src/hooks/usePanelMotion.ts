import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import type { Transition, Variants } from 'motion/react';

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

const EXIT_GRACE_MS = 150;
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

// Motion の useReducedMotion は初回の値を保持し、起動中の設定変更に追従しないため自前で購読する。
function subscribeReducedMotion(onChange: () => void) {
    if (typeof matchMedia !== 'function') return () => {};
    const media = matchMedia(REDUCED_QUERY);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
}

function prefersReducedMotion() {
    return typeof matchMedia === 'function' && matchMedia(REDUCED_QUERY).matches;
}

// 出口の間だけ内容を残す（AnimatePresence）。閉じる操作自体（保存値・フォーカス・inert）は待たせない。
// transform は文字列で渡し、Motion に WAAPI で合成させる（メインスレッドの毎フレーム更新にしない）。
export function usePanelMotion(open: boolean, panelRef: RefObject<HTMLElement | null>) {
    const [instant, setInstant] = useState(true);
    const [exiting, setExiting] = useState(false);
    const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
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
        if (instant) finishNow();
        // Motion は描画フレームでアニメーションを作り、finish イベントで完了を返す。非表示のウィンドウや
        // 最初のフレーム前では finish() が空振りするため、退場の状態は自前で確定させる。要素は inert で操作対象外。
        // 開始が少し遅れても終わり際を切らないよう、予定より長めに待つ。
        const timer = window.setTimeout(() => { finishNow(); setExiting(false); }, duration * 1000 + EXIT_GRACE_MS);
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

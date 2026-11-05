import { useEffect, useRef, type RefObject } from 'react';
import type { Availability } from '@/lib/preparation';

// ホームの区画が跳ねないよう、配置の変化を transform だけで補間する（DESIGN.md 5.6、#298）。
// 変化の後に前回の位置との差を測り、その差から 0 へ戻す（FLIP）。幅・高さ・余白は遷移させない。
// 測るのは容器の直下と data-layout-motion を付けた要素だけで、メーターの値の更新では測らない。

type Box = { x: number; y: number; h: number };
const OFF = 'off';

// transform に左右されない位置。offsetTop を親へたどって足す。
const offsetPosition = (element: HTMLElement) => {
    let x = 0, y = 0;
    for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) { x += node.offsetLeft; y += node.offsetTop; }
    return { x, y };
};

// 時間と曲線は index.css のモーショントークンから読む。Web Animations には var() を渡せないため。
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tokenMs = (name: string, fallback: number) => {
    const raw = token(name);
    const value = parseFloat(raw) * (raw.endsWith('ms') ? 1 : 1000);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

// 動いている途中の位置から次の動きを始める。途中で戻しても最初からやり直さない。
const currentShift = (element: HTMLElement) => {
    const transform = getComputedStyle(element).transform;
    if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return { x: 0, y: 0 };
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
};

export function useLayoutMotion(ref: RefObject<HTMLElement | null>, enabled = true) {
    useEffect(() => {
        const root = ref.current;
        if (!enabled || !root || typeof ResizeObserver === 'undefined' || typeof root.animate !== 'function') return;
        const boxes = new WeakMap<HTMLElement, Box>();
        const moves = new WeakMap<HTMLElement, Animation>();
        let tracked: HTMLElement[] = [];
        let trackedSet = new Set<HTMLElement>();
        let ready = false;
        const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

        const collect = () => {
            const next = [...root.children, ...root.querySelectorAll('[data-layout-motion]')]
                .filter((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.layoutMotion !== OFF);
            tracked = [...new Set(next)];
            trackedSet = new Set(tracked);
        };
        const anchorOf = (element: HTMLElement) => {
            for (let node = element.parentElement; node && node !== root; node = node.parentElement) if (trackedSet.has(node)) return node;
            return root;
        };

        const measure = () => {
            const still = reduced?.matches ?? false;
            const move = tokenMs('--motion-panel', 240);
            const fade = tokenMs('--motion-fast', 150);
            const easeMove = token('--ease-in-out') || 'ease-in-out';
            const easeOut = token('--ease-out') || 'ease-out';
            for (const element of tracked) {
                if (!element.isConnected) continue;
                const self = offsetPosition(element), anchor = offsetPosition(anchorOf(element));
                const box = { x: self.x - anchor.x, y: self.y - anchor.y, h: element.offsetHeight };
                const previous = boxes.get(element);
                boxes.set(element, box);
                // 隠れていた要素や、動きを減らす設定では位置を記録するだけにする。
                if (still) { moves.get(element)?.cancel(); continue; }
                if (!previous) {
                    // 入れ替わって現れた内容は、場所を動かさず不透明度だけで入れる。
                    if (ready && box.h > 0) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, easing: easeOut });
                    continue;
                }
                if (previous.h === 0 || box.h === 0) continue;
                const dx = previous.x - box.x, dy = previous.y - box.y;
                if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
                    const running = moves.get(element);
                    const shift = running?.playState === 'running' ? currentShift(element) : { x: 0, y: 0 };
                    running?.cancel();
                    moves.set(element, element.animate([
                        { transform: `translate(${dx + shift.x}px, ${dy + shift.y}px)` },
                        { transform: 'translate(0px, 0px)' },
                    ], { duration: move, easing: easeMove, composite: 'add' }));
                }
            }
            ready = true;
        };

        // 大きさが変わったときだけ測る。新しく現れた要素は観測の初回通知で測られる。
        const resize = new ResizeObserver(measure);
        const observe = () => {
            const before = trackedSet;
            collect();
            resize.observe(root);
            for (const element of tracked) if (!before.has(element)) resize.observe(element);
            for (const element of before) if (!trackedSet.has(element)) resize.unobserve(element);
        };
        observe();
        measure();
        const mutation = new MutationObserver(records => { if (records.some(record => record.type === 'childList')) observe(); });
        mutation.observe(root, { childList: true, subtree: true });
        return () => { resize.disconnect(); mutation.disconnect(); };
    }, [ref, enabled]);
}

// 設定の反映中は観測が一瞬 pending になる。そのたびに配置を畳むと本番帯が跳ねるので、直前の判定を使い続ける（#298）。
export function useSettledReady(availability: Availability) {
    const settled = useRef(false);
    if (availability !== 'pending') settled.current = availability === 'ready';
    return settled.current;
}

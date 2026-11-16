import { useEffect, useLayoutEffect, type RefObject } from 'react';

// 手順の印は、折り返しや言語で行の高さが変わっても、いまの行に合わせる。
export function useSetupRailThumb(rail: HTMLOListElement | null, thumb: HTMLSpanElement | null, stepIndex: number, goal: string | null | undefined, locale: string) {
    useLayoutEffect(() => {
        const current = rail?.children.item(stepIndex) as HTMLElement | null;
        if (!rail || !thumb || !current) return;
        const measure = () => {
            thumb.style.height = `${current.offsetHeight}px`;
            thumb.style.transform = `translateY(${current.offsetTop}px)`;
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(rail);
        Array.from(rail.children).forEach(row => observer.observe(row));
        return () => observer.disconnect();
    }, [rail, thumb, stepIndex, goal, locale]);
}

// 手順が変わったら、本文と外側のスクロールを先頭へ戻し、見出しへ焦点を移す。
export function useSetupStepScroll(isOpen: boolean, state: string, bodyRef: RefObject<HTMLDivElement | null>, surfaceRef: RefObject<HTMLDivElement | null>) {
    useEffect(() => {
        if (!isOpen || !bodyRef.current) return;
        bodyRef.current.scrollTop = 0;
        if (surfaceRef.current) surfaceRef.current.scrollTop = 0;
        const heading = bodyRef.current.querySelector('h2');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }, [isOpen, state, bodyRef, surfaceRef]);
}

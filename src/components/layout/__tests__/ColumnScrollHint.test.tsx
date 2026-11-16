import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useColumnScrollHint } from '@/hooks/useColumnScrollHint';

afterEach(() => cleanup());

function Hint({ children }: { children: ReactNode }) {
    useColumnScrollHint();
    return <>{children}</>;
}

function sizeScroller(element: HTMLElement, scrollTop: number) {
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(element, 'scrollTop', { configurable: true, value: scrollTop });
    element.getBoundingClientRect = () => new DOMRect(8, 40, 200, 100);
}

function HomeColumn({ scrollTop }: { scrollTop: number }) {
    const ref = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        sizeScroller(element, scrollTop);
    });
    return <main ref={ref} className="home-main" style={{ overflowY: 'auto' }}><div>本文</div></main>;
}

function SettingsColumn() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        const bar = barRef.current;
        if (!scroller || !bar) return;
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
        Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 300 });
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 800 });
        Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
        scroller.getBoundingClientRect = () => new DOMRect(0, 100, 300, 200);
        bar.getBoundingClientRect = () => new DOMRect(0, 300, 300, 48);
    });
    return (
        <main className="home-main" style={{ overflowY: 'hidden' }}>
            <div ref={scrollerRef} style={{ overflowY: 'auto' }}>本文</div>
            <div ref={barRef} data-save-bar="">保存</div>
        </main>
    );
}

function fadeOf(): HTMLElement {
    const fade = document.querySelector('[data-scroll-more]');
    if (!(fade instanceof HTMLElement)) throw new Error('フェードが無い');
    return fade;
}

it('続きがあるときは列の下端にフェードを出し、末尾では消す', () => {
    function Frame() {
        const [scrollTop, setScrollTop] = useState(0);
        return <Hint><button type="button" onClick={() => setScrollTop(300)}>末尾</button><HomeColumn scrollTop={scrollTop} /></Hint>;
    }
    const { getByRole } = render(<Frame />);
    const fade = fadeOf();
    expect(fade.hidden).toBe(false);
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    expect(fade.style.top).toBe('116px');
    fireEvent.click(getByRole('button', { name: '末尾' }));
    expect(fadeOf().hidden).toBe(true);
});

it('保存の欄があるページでは、欄の上端にフェードの下端を合わせる', () => {
    render(<Hint><SettingsColumn /></Hint>);
    const fade = fadeOf();
    expect(fade.hidden).toBe(false);
    expect(fade.style.top).toBe('276px');
    expect(Number(fade.style.top.replace('px', '')) + Number(fade.style.height.replace('px', ''))).toBe(300);
});

it('区画があとから足されて続きができたときも、フェードを出す（声の流れが出るとき）', async () => {
    const scroller = document.createElement('main');
    scroller.className = 'home-main';
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
    let contentHeight = 100;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => contentHeight });
    scroller.getBoundingClientRect = () => new DOMRect(8, 40, 200, 100);
    document.body.appendChild(scroller);
    try {
        render(<Hint><div /></Hint>);
        expect(fadeOf().hidden).toBe(true);
        // 区画が足され、中身が伸びる。列の大きさは変わらない。
        contentHeight = 300;
        scroller.appendChild(document.createElement('section'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(fadeOf().hidden).toBe(false);
    } finally {
        scroller.remove();
    }
});

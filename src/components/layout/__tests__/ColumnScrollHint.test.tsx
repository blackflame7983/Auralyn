import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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

it('続きがあるときは列の下端にフェードを出し、末尾では消す', async () => {
    function Frame() {
        const [scrollTop, setScrollTop] = useState(0);
        return <Hint><button type="button" onClick={() => setScrollTop(300)}>末尾</button><HomeColumn scrollTop={scrollTop} /></Hint>;
    }
    const { getByRole } = render(<Frame />);
    const fade = fadeOf();
    expect(fade.hidden).toBe(false);
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    expect(fade.style.top).toBe('116px');
    expect(fade.querySelector('svg.scroll-more-chevron path')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: '末尾' }));
    // 描き直しからの置き直しは、次のフレームにまとめて行う（#691）。
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
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

function focusByKeyboard(element: HTMLElement) {
    fireEvent.keyDown(document.body, { key: 'Tab' });
    element.focus();
}

function columnWithButton(rect: DOMRect) {
    const scroller = document.createElement('main');
    scroller.className = 'home-main';
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 400 });
    scroller.getBoundingClientRect = () => new DOMRect(8, 40, 200, 100);
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy;
    const button = document.createElement('button');
    button.textContent = '操作';
    button.getBoundingClientRect = () => rect;
    scroller.appendChild(button);
    document.body.appendChild(scroller);
    return { scroller, button, scrollBy };
}

it('焦点の枠がフェードに隠れる操作は、すぐに（動きを付けず）フェードの上まで送る', () => {
    const { scroller, button, scrollBy } = columnWithButton(new DOMRect(8, 100, 80, 20));
    try {
        render(<Hint><div /></Hint>);
        expect(fadeOf().hidden).toBe(false);
        focusByKeyboard(button);
        // フェードは 116 から。下端 120 + 枠 4 = 124 なので 8 送る。
        expect(scrollBy).toHaveBeenCalledTimes(1);
        expect(scrollBy).toHaveBeenCalledWith({ top: 8, behavior: 'instant' });
    } finally {
        scroller.remove();
    }
});

it('フェードに掛からない操作と、フェードが出ていないときは送らない', () => {
    const { scroller, button, scrollBy } = columnWithButton(new DOMRect(8, 60, 80, 20));
    try {
        render(<Hint><div /></Hint>);
        focusByKeyboard(button);
        expect(scrollBy).not.toHaveBeenCalled();
        button.blur();
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 100 });
        button.getBoundingClientRect = () => new DOMRect(8, 100, 80, 20);
        focusByKeyboard(button);
        expect(scrollBy).not.toHaveBeenCalled();
    } finally {
        scroller.remove();
    }
});

it('画面を離れたあとは、焦点が入っても送らない（購読を外す）', () => {
    const { scroller, button, scrollBy } = columnWithButton(new DOMRect(8, 100, 80, 20));
    try {
        const { unmount } = render(<Hint><div /></Hint>);
        unmount();
        focusByKeyboard(button);
        expect(scrollBy).not.toHaveBeenCalled();
    } finally {
        scroller.remove();
    }
});

it('押している間に焦点が入った要素は動かさず、離したあとのキーボード操作では送る', () => {
    const { scroller, button, scrollBy } = columnWithButton(new DOMRect(8, 100, 80, 20));
    const input = document.createElement('input');
    input.getBoundingClientRect = () => new DOMRect(8, 100, 80, 20);
    scroller.appendChild(input);
    try {
        render(<Hint><div /></Hint>);
        fireEvent.pointerDown(input);
        input.focus();
        expect(scrollBy).not.toHaveBeenCalled();
        fireEvent.pointerUp(document.body);
        focusByKeyboard(button);
        expect(scrollBy).toHaveBeenCalledTimes(1);
    } finally {
        scroller.remove();
    }
});

it('拡大表示では、枠の幅にも倍率を掛けて見積もり、送る量は CSS px へ戻す', () => {
    const { scroller, button, scrollBy } = columnWithButton(new DOMRect(8, 92, 80, 20));
    // jsdom は zoom を計算しないので、ページの倍率だけを差し替える。
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = computed(element, pseudo);
        return element === document.documentElement
            ? new Proxy(style, { get: (target, key) => (key === 'zoom' ? '1.5' : Reflect.get(target, key, target)) })
            : style;
    });
    try {
        render(<Hint><div /></Hint>);
        // フェードは 116 から。下端 112 + 枠 6 = 118 なので画面で 2、CSS px で 4/3 送る。
        focusByKeyboard(button);
        expect(scrollBy).toHaveBeenCalledTimes(1);
        expect(scrollBy.mock.calls[0][0].top).toBeCloseTo(2 / 1.5);
    } finally {
        vi.restoreAllMocks();
        scroller.remove();
    }
});

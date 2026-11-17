import { useLayoutEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Modal } from '../modal';

afterEach(() => cleanup());

function sizeBox(element: HTMLElement, rect: DOMRect, scrollTop: number, scrollHeight: number) {
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: rect.height });
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: rect.width });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
    element.getBoundingClientRect = () => rect;
}

function DialogBody({ scrollTop }: { scrollTop: number }) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const footerRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const body = bodyRef.current;
        const footer = footerRef.current;
        const surface = body?.parentElement;
        if (!body || !footer || !(surface instanceof HTMLElement)) return;
        sizeBox(body, new DOMRect(40, 80, 300, 100), scrollTop, 400);
        footer.getBoundingClientRect = () => new DOMRect(40, 160, 300, 40);
        surface.getBoundingClientRect = () => new DOMRect(32, 40, 320, 180);
    });
    return <div className="modal-surface-base" style={{ position: 'relative' }}>
        <div ref={bodyRef} className="modal-body-base" style={{ overflowY: 'auto' }}>本文が続く</div>
        <div ref={footerRef} className="modal-footer-base">次へ</div>
    </div>;
}

function fadeOf(): HTMLElement {
    const fade = document.querySelector('[data-scroll-more="dialog"]');
    if (!(fade instanceof HTMLElement)) throw new Error('ダイアログのフェードが無い');
    return fade;
}

it('続きがあるときは本文の下端でフッターの手前にフェードを出し、末尾では消す', async () => {
    function Frame() {
        const [scrollTop, setScrollTop] = useState(0);
        return <>
            <button type="button" onClick={() => setScrollTop(300)}>末尾</button>
            <Modal title="案内" onClose={() => {}}><div className="modal-overlay-base"><DialogBody scrollTop={scrollTop} /></div></Modal>
        </>;
    }
    const { getByRole } = render(<Frame />);
    const fade = fadeOf();
    expect(fade.hidden).toBe(false);
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    expect(fade.style.top).toBe('96px');
    expect(Number(fade.style.top.replace('px', '')) + Number(fade.style.height.replace('px', ''))).toBe(120);
    fireEvent.click(getByRole('button', { name: '末尾', hidden: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(fadeOf().hidden).toBe(true);
});

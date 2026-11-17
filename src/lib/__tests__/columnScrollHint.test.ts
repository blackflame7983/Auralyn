import { expect, it } from 'vitest';
import { dialogScrollLimit, fadeBox, findDialogScroller, moreBelow, scrollToClearFade } from '../columnScrollHint';

it('最後まで来たら続きなしにし、下の余白だけが残るときは出さない', () => {
    expect(moreBelow({ scrollHeight: 400, clientHeight: 100, scrollTop: 0, paddingBottom: 0 })).toBe(true);
    expect(moreBelow({ scrollHeight: 400, clientHeight: 100, scrollTop: 299, paddingBottom: 0 })).toBe(false);
    expect(moreBelow({ scrollHeight: 140, clientHeight: 100, scrollTop: 0, paddingBottom: 40 })).toBe(false);
});

it('ダイアログは一番広い本文のスクロールを選び、フッターを下端にする', () => {
    const root = document.createElement('div');
    const surface = document.createElement('div');
    surface.className = 'modal-surface-base';
    const rail = document.createElement('nav');
    rail.style.overflowY = 'auto';
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 80 });
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 200 });
    const body = document.createElement('div');
    body.className = 'modal-body-base';
    body.style.overflowY = 'auto';
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
    const footer = document.createElement('div');
    footer.className = 'modal-footer-base';
    surface.append(rail, body, footer);
    root.append(surface);
    document.body.append(root);
    try {
        expect(findDialogScroller(root)).toBe(body);
        expect(dialogScrollLimit(body)).toBe(footer);
    } finally {
        root.remove();
    }
});

it('フェードは列の下端に置き、保存の欄に重なるときはその上端で止める', () => {
    const scroller = new DOMRect(8, 40, 200, 100);
    expect(fadeBox(scroller, null)).toEqual({ top: 116, left: 8, width: 200, height: 24 });
    const touching = new DOMRect(8, 140, 200, 48);
    expect(fadeBox(scroller, touching)).toEqual({ top: 116, left: 8, width: 200, height: 24 });
    const overlapping = new DOMRect(8, 120, 200, 48);
    expect(fadeBox(scroller, overlapping)?.top).toBe(96);
    expect(fadeBox(new DOMRect(0, 0, 200, 16), null)).toBeNull();
});

it('焦点の枠（4px）がフェードに入るときだけ、その分を下へ送る', () => {
    const scroller = new DOMRect(8, 40, 200, 100);
    // フェードは 116 から。要素の下端 110 + 枠 4 = 114 は手前なので送らない。
    expect(scrollToClearFade(new DOMRect(8, 90, 80, 20), scroller, 116)).toBe(0);
    expect(scrollToClearFade(new DOMRect(8, 96, 80, 20), scroller, 116)).toBe(4);
    expect(scrollToClearFade(new DOMRect(8, 110, 80, 28), scroller, 116)).toBe(26);
});

it('焦点の枠が列の上端より上へはみ出すときは、その分を上へ戻す', () => {
    const scroller = new DOMRect(8, 40, 200, 100);
    expect(scrollToClearFade(new DOMRect(8, 40, 80, 20), scroller, 116)).toBe(-4);
    expect(scrollToClearFade(new DOMRect(8, 44, 80, 20), scroller, 116)).toBe(0);
    expect(scrollToClearFade(new DOMRect(8, 10, 80, 20), scroller, 116)).toBe(-34);
});

it('枠を含めて列に収まらない要素と、箱の無い要素は送らない', () => {
    const scroller = new DOMRect(8, 40, 200, 100);
    expect(scrollToClearFade(new DOMRect(8, 30, 80, 90), scroller, 116)).toBe(0);
    expect(scrollToClearFade(new DOMRect(0, 0, 0, 0), scroller, 116)).toBe(0);
});

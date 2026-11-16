import { expect, it } from 'vitest';
import { fadeBox, moreBelow } from '../columnScrollHint';

it('最後まで来たら続きなしにし、下の余白だけが残るときは出さない', () => {
    expect(moreBelow({ scrollHeight: 400, clientHeight: 100, scrollTop: 0, paddingBottom: 0 })).toBe(true);
    expect(moreBelow({ scrollHeight: 400, clientHeight: 100, scrollTop: 299, paddingBottom: 0 })).toBe(false);
    expect(moreBelow({ scrollHeight: 140, clientHeight: 100, scrollTop: 0, paddingBottom: 40 })).toBe(false);
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

import { expect, it } from 'vitest';
import { hiddenRoutePrefix, routeSegments } from '../routeFit';

it('区切りは矢印だけで分け、空の区間は捨てる', () => {
    expect(routeSegments('CABLE Output → スピーカー → OBSで配信')).toEqual(['CABLE Output', 'スピーカー', 'OBSで配信']);
    expect(routeSegments('自分用 → スピーカー')).toEqual(['自分用', 'スピーカー']);
});

it('幅が足りるときは先頭を隠さない', () => {
    expect(hiddenRoutePrefix([200, 80, 70], 16, 12, 400)).toBe(0);
    expect(hiddenRoutePrefix([70], 16, 12, 10)).toBe(0);
    expect(hiddenRoutePrefix([200, 80, 70], 16, 12, 0)).toBe(0);
});

it('入りきらないときは送り先が残るところまで先頭を隠す', () => {
    // 全体 382。中間まで残すと 194。送り先だけなら 98。
    expect(hiddenRoutePrefix([200, 80, 70], 16, 12, 120)).toBe(2);
    expect(hiddenRoutePrefix([200, 80, 70], 16, 12, 200)).toBe(1);
});

it('送り先だけでも入らないときは、送り先だけを残して先頭を全部隠す', () => {
    expect(hiddenRoutePrefix([200, 80, 70], 16, 12, 50)).toBe(2);
    expect(hiddenRoutePrefix([100, 40], 10, 10, 30)).toBe(1);
});

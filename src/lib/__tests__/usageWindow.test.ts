import { describe, expect, it } from 'vitest';
import { parseWindowBounds, planWindow, selectWorkArea, type WindowBounds, type WorkArea } from '../usageWindow';

const normal: WindowBounds = { x: 100, y: 60, width: 1024, height: 768, maximized: false };
const main: WorkArea = { x: 0, y: 0, width: 1920, height: 1040, scale: 1 };

describe('用途別ウィンドウの境界', () => {
    it('画面に収まる場合、配信用途でも既存サイズと位置を保持する', () => {
        expect(planWindow(normal, 'voice', main, { width: 16, height: 39 })).toEqual({
            minWidth: 960, minHeight: 640, bounds: normal,
        });
    });
    it('不足分だけ拡大し、音楽表示にしても大きいサイズを縮めない', () => {
        const small = { ...normal, width: 900, height: 600 };
        const voice = planWindow(small, 'voice', main, { width: 16, height: 39 }).bounds;
        expect(voice).toMatchObject({ width: 960, height: 640 });
        expect(planWindow(voice, 'music', main, { width: 16, height: 39 }).bounds).toEqual(voice);
    });
    it('高DPIや小さな画面では枠を含む作業領域内に下限と位置を補正する', () => {
        const area = { x: -1200, y: 0, width: 1200, height: 800, scale: 1.5 };
        const result = planWindow({ ...normal, x: -2000, y: 500 }, 'voice', area, { width: 24, height: 60 });
        expect(result.minWidth).toBe(784);
        expect(result.minHeight).toBeCloseTo(493.333333);
        expect(result.bounds).toMatchObject({ x: -1200, y: 0, width: 784 });
        expect(result.bounds.height).toBeCloseTo(493.333333);
    });
    it('接続中は保存位置と重なるモニター、消失時は最も近いモニターを選ぶ', () => {
        const right = { ...main, x: 1920 };
        expect(selectWorkArea([main, right], { ...normal, x: 2400 })).toBe(right);
        expect(selectWorkArea([main], { ...normal, x: 2400 })).toBe(main);
        expect(selectWorkArea([], normal)).toBeNull();
    });
    it('異なるDPIの境界では全候補に同じ物理矩形を使って最大の重なりを選ぶ', () => {
        const left = { x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
        const right = { x: 1920, y: 0, width: 2560, height: 1440, scale: 2 };
        const boundary = { x: 1300, y: 100, width: 960, height: 640, maximized: false, scale: 1 };
        expect(selectWorkArea([left, right], boundary)).toBe(left);
        expect(selectWorkArea([left, right], { ...boundary, x: 1700 })).toBe(right);
        expect(selectWorkArea([left], { ...boundary, x: 2600, scale: 2 })).toBe(left);
        const { scale: _scale, ...legacy } = boundary;
        expect(selectWorkArea([left, right], legacy, 1)).toBe(left);
    });
    it('不正な保存値を読み戻さない', () => {
        expect(parseWindowBounds({ ...normal, width: Infinity })).toBeNull();
        expect(parseWindowBounds({ ...normal, x: 999999 })).toBeNull();
        expect(parseWindowBounds({ ...normal, maximized: 'true' })).toBeNull();
        expect(parseWindowBounds(normal)).toEqual(normal);
    });
});

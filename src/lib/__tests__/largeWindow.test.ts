import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { largeWindow, uiScale, unzoomDrag, unzoomTranslate } from '../largeWindow';

it('倍率は基準以下で1、超えた分だけ0.01刻みで、上限は1.5', () => {
    expect(uiScale(1024, 768)).toBe(1);
    expect(uiScale(1440, 900)).toBe(1);
    expect(uiScale(1700, 960)).toBe(1);
    expect(uiScale(1920, 1080)).toBe(1.13);
    expect(uiScale(2560, 1440)).toBe(1.5);
    expect(uiScale(3840, 2160)).toBe(1.5);
});

it('拡大中のポップアップとドラッグは、見た目の移動量を倍率で割って戻す', () => {
    expect(unzoomTranslate('translate(1708px, 56px)', 1)).toBe('translate(1708px, 56px)');
    expect(unzoomTranslate('translate(1708px, 56px)', 1.13)).toBe(`translate(${1708 / 1.13}px, ${56 / 1.13}px)`);
    expect(unzoomDrag({ x: 113, y: 0 }, 1)).toEqual({ x: 113, y: 0 });
    expect(unzoomDrag({ x: 113, y: 56 }, 1.13)).toEqual({ x: 113 / 1.13, y: 56 / 1.13 });
});

it('寸法は CSS のメディアクエリと同じ数値を使う', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../index.css'), 'utf8');
    expect(css).toContain(`min-height: ${largeWindow.tier2MinHeight}px`);
    expect(css).toContain(`min-width: ${largeWindow.connectColumnMinWidth}px`);
    expect(css).toContain(`min-width: ${largeWindow.pageColumnsMinWidth}px`);
    expect(css).toContain(`max-width: ${largeWindow.homeContentMax}px`);
    expect(css).toContain(`max-width: ${largeWindow.homeContentWideMax}px`);
});

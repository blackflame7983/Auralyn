import { test, expect, type Page } from '@playwright/test';
import { shortWrappedLines } from './helpers/shortLines';

async function render(page: Page, html: string) {
    await page.setContent(`<style>#t { font: 16px monospace; width: 8.5ch; word-break: break-all; }</style><p id="t">${html}</p>`);
    return shortWrappedLines(page.locator('#t'));
}

test.describe('shortWrappedLines', () => {
    test('インライン要素の途中で折れても、後ろの文字だけを短い行と数えない', async ({ page }) => {
        // 1行目は abcdefgh、2行目は ijkl。「gh」は行の途中にある。
        expect(await render(page, '<span>abcdef</span>ghijkl')).toEqual([]);
    });

    test('末尾がインライン要素の2文字だけの行を見逃さない', async ({ page }) => {
        expect(await render(page, 'abcdefgh<span>ij</span>')).toEqual(['ij']);
    });

    test('1〜2文字で終わる行を知らせる', async ({ page }) => {
        expect(await render(page, 'abcdefghij')).toEqual(['ij']);
    });

    test('3文字以上で折り返す文は知らせない', async ({ page }) => {
        expect(await render(page, 'abcdefgh ijklmn')).toEqual([]);
    });
});

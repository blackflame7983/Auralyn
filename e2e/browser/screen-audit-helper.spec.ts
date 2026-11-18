import { test, expect, type Page } from '@playwright/test';
import { runScreenAudit } from './helpers/screenAudit';

const style = `
    body { margin: 0; font: 16px sans-serif; }
    .rounded-card { border-radius: 8px; background: #ddd; }
    .setup-choice-icon { display: grid; place-items: center; width: 44px; height: 44px; }
    svg { width: 20px; height: 20px; }
`;

async function emptyFrames(page: Page, body: string, extra = ''): Promise<string[]> {
    await page.setContent(`<style>${style}${extra}</style>${body}`);
    const hits = await runScreenAudit(page, { purpose: 'voice', locale: 'ja' });
    return hits.filter(hit => hit.check === 'empty').map(hit => hit.selector);
}

test.describe('空の枠の検査', () => {
    test('セットアップのカードのアイコン台は、空の枠にしない', async ({ page }) => {
        expect(await emptyFrames(page, '<span class="setup-choice-icon rounded-card"><svg></svg></span>')).toEqual([]);
    });

    test('拡大表示（150%）のアイコン台も、空の枠にしない', async ({ page }) => {
        expect(await emptyFrames(page, '<span class="setup-choice-icon rounded-card"><svg></svg></span>', 'html { zoom: 1.5; }')).toEqual([]);
    });

    test('直下に svg が1つだけの幅の広い空のカードは、空の枠として知らせる', async ({ page }) => {
        const found = await emptyFrames(page, '<div class="rounded-card" style="width: 400px; height: 56px"><svg></svg></div>');
        expect(found).toEqual(['div.rounded-card']);
    });

    test('アイコン台でも、svg が見えていなければ空の枠として知らせる', async ({ page }) => {
        const found = await emptyFrames(page, '<span class="setup-choice-icon rounded-card"><svg style="display: none"></svg></span>');
        expect(found).toEqual(['span.setup-choice-icon']);
    });

    test('アイコン台でも、中身が無ければ空の枠として知らせる', async ({ page }) => {
        const found = await emptyFrames(page, '<span class="setup-choice-icon rounded-card"></span>');
        expect(found).toEqual(['span.setup-choice-icon']);
    });
});

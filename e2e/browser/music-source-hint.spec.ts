import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';
import { openHome, streamLevels, type Locale, type RunState } from './helpers/openHome';
import { waitForStableLayout } from './helpers/waitForStableLayout';

// 音楽鑑賞のホームで、再生元から音が届いていないときだけ、再生アプリの出力先を一行で案内する（#718）。
const hintText: Record<Locale, string> = {
    ja: '再生アプリの出力を「CABLE Input」にすると、音が届きます。',
    en: 'Set your player\'s output to “CABLE Input” and sound will arrive.',
};
const nowRegion = (page: Page, locale: Locale) => page.getByRole('region', { name: locale === 'ja' ? 'いまの状態' : 'Current status', exact: true });
const size = { width: 900, height: 600 };
// 案内は音が届かない状態が5秒続いてから出る（src/components/features/Home/MusicSourceHint.tsx）。
const afterHintDelay = 5_500;

test.describe('音が届いていない実行中の音楽鑑賞', () => {
    test.use({ liveHome: true });
    for (const locale of ['ja', 'en'] as const) {
        test(`${locale}: 再生元の近くに一行の案内が出て、診断への入口は最初の表示に残る`, async ({ page }) => {
            await openHome(page, { state: 'running', locale, purpose: 'music', theme: 'dark', size, levels: false });
            const strip = nowRegion(page, locale);
            const hint = strip.getByText(hintText[locale], { exact: true });
            await expect(hint).toBeVisible({ timeout: 10_000 });
            await waitForStableLayout(page);
            const reading = await hint.evaluate(element => {
                const line = Number.parseFloat(getComputedStyle(element).lineHeight);
                const box = element.getBoundingClientRect();
                // 直前の行は「再生元の状態」と「出力の大きさ」。案内はその直下に置く。
                const row = element.previousElementSibling;
                const hasSource = row?.querySelector('[data-now-incoming]') != null;
                return { lines: Math.round(box.height / line), below: row && hasSource ? box.top - row.getBoundingClientRect().bottom : null, overflow: element.scrollWidth - element.clientWidth };
            });
            expect(reading.lines, '案内は1行').toBe(1);
            expect(reading.overflow).toBeLessThanOrEqual(0);
            expect(reading.below, `再生元の状態の行の直下 ${JSON.stringify(reading)}`).not.toBeNull();
            expect(reading.below ?? 99, JSON.stringify(reading)).toBeLessThan(8);
            await expect(strip.getByRole('button')).toHaveCount(0);
            const diagnose = page.getByRole('button', { name: locale === 'ja' ? '音のトラブルを診断' : 'Diagnose audio problems', exact: true });
            await expect(diagnose).toBeInViewport({ ratio: 1 });
        });
    }

    test('ja: 音が届き始めたら案内を消す', async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'music', theme: 'dark', size, levels: false });
        const hint = nowRegion(page, 'ja').getByText(hintText.ja, { exact: true });
        await expect(hint).toBeVisible({ timeout: 10_000 });
        await streamLevels(page);
        await expect(hint).toHaveCount(0);
    });

    test('ja: 配信・通話のホームには出さない', async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme: 'dark', size, levels: false });
        await page.waitForTimeout(afterHintDelay);
        await expect(page.getByText('再生アプリの出力を', { exact: false })).toHaveCount(0);
    });
});

test.describe('音が届いている実行中の音楽鑑賞', () => {
    test.use({ liveHome: true });
    test('ja: 案内を出さない', async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'music', theme: 'dark', size, levels: true });
        await page.waitForTimeout(afterHintDelay);
        await expect(page.getByText('再生アプリの出力を', { exact: false })).toHaveCount(0);
    });
});

test.describe('停止中の音楽鑑賞', () => {
    test.use({ liveHome: true, stoppedHome: true });
    const state: RunState = 'stopped';
    for (const locale of ['ja', 'en'] as const) {
        test(`${locale}: 案内を出さない`, async ({ page }) => {
            await openHome(page, { state, locale, purpose: 'music', theme: 'dark', size });
            await page.waitForTimeout(afterHintDelay);
            await expect(page.getByText(locale === 'ja' ? '再生アプリの出力を' : 'Set your player', { exact: false })).toHaveCount(0);
        });
    }
});

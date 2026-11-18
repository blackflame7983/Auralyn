import type { Page } from '@playwright/test';
import { expect, test } from './tauriFixture';
import { setOutputGain, setOutputMuted } from './e2eHooks';
import { mustBox } from './mustBox';
import { openHome, type Locale, type Purpose } from './helpers/openHome';
import { message } from '../../src/i18n/messages';

// ミュートの伝え方を場所ごとの役割に分ける（#766）。
// いまの状態：何が起きているか（音を送っていません／音を出していません）。右の列の札：原因と解除の入口（出力ミュート・音量ゼロ）。
// 接続の確認：同じ入口の「ミュート・出力音量を確認」は置かない。
test.use({ liveHome: true });

const sizes = [
    { width: 900, height: 600 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
] as const;
const locales: readonly Locale[] = ['ja', 'en'];
const purposes: readonly Purpose[] = ['voice', 'music'];

const column = (page: Page, locale: Locale) => page.getByRole('complementary', { name: message(locale, 'shell.safetyColumn'), exact: true });
const nowText = (locale: Locale, purpose: Purpose) => message(locale, purpose === 'music' ? 'home.notPlaying' : 'home.notSending');

/** 札と、いまの状態の文が、画面にいくつ出ているか。 */
async function muteCounts(page: Page, locale: Locale, purpose: Purpose) {
    return {
        cause: await page.getByText(message(locale, 'prep.muted'), { exact: true }).count(),
        causeButtons: await column(page, locale).getByRole('button', { name: message(locale, 'prep.muted'), exact: true }).count(),
        now: await page.getByText(nowText(locale, purpose), { exact: true }).count(),
        check: await page.getByRole('button', { name: (locale === 'ja' ? 'ミュート・出力音量を確認' : 'Check mute and output level'), exact: true }).count(),
        liveRegions: await page.getByRole('status').filter({ hasText: new RegExp(`${message(locale, 'prep.muted')}|${nowText(locale, purpose)}`) }).count(),
    };
}

for (const size of sizes) for (const locale of locales) for (const purpose of purposes) {
    test(`ミュート中、原因の札は右の列に1回、いまの状態の文は1回で、解除すると両方消える（${size.width}×${size.height}、${locale}、${purpose}）`, async ({ page }, info) => {
        await openHome(page, { state: 'running', locale, purpose, theme: 'dark', size });
        await setOutputMuted(page, true);
        const now = page.getByRole('region', { name: message(locale, 'home.now'), exact: true });
        const status = now.locator('[data-now-mute="muted"]');
        const chip = column(page, locale).getByRole('button', { name: message(locale, 'prep.muted'), exact: true });
        await expect(status).toHaveText(nowText(locale, purpose));
        // 最初の表示で、どちらもスクロールせずに見える。
        await expect(status).toBeInViewport({ ratio: 1 });
        await expect(chip).toBeInViewport({ ratio: 1 });
        await expect.poll(() => muteCounts(page, locale, purpose)).toEqual({ cause: 1, causeButtons: 1, now: 1, check: 0, liveRegions: 1 });
        // 札は解除の入口へ案内するだけで、ミュートを勝手に解除しない。
        await chip.click();
        await expect(page.locator('#emergency-mute')).toBeFocused();
        await expect(chip).toBeVisible();

        // 切れ・重なり・はみ出しが無い。
        const heading = now.getByRole('heading', { level: 2 });
        const headingBox = await mustBox(heading);
        const statusBox = await mustBox(status);
        expect(headingBox.x + headingBox.width <= statusBox.x + 1 || statusBox.x + statusBox.width <= headingBox.x + 1 || headingBox.y + headingBox.height <= statusBox.y + 1, '見出しと状態の文が重なる').toBe(true);
        expect(await status.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getClientRects().length === 1), 'いまの状態の文が切れるか折り返す').toBe(true);
        const fit = await chip.evaluate(element => {
            const aside = element.closest('aside');
            if (!aside) return { inside: false, clipped: true, overflow: Number.POSITIVE_INFINITY };
            const box = element.getBoundingClientRect();
            const columnBox = aside.getBoundingClientRect();
            return {
                inside: box.left >= columnBox.left - 1 && box.right <= columnBox.right + 1 && box.top >= columnBox.top - 1 && box.bottom <= columnBox.bottom + 1,
                clipped: element.scrollWidth > element.clientWidth + 1,
                overflow: aside.scrollHeight - aside.clientHeight,
            };
        });
        expect(fit).toEqual({ inside: true, clipped: false, overflow: expect.any(Number) });
        expect(fit.overflow).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`muted-${purpose}-${locale}-${size.width}x${size.height}.png`) });

        await setOutputMuted(page, false);
        await expect(status).toHaveCount(0);
        await expect(chip).toHaveCount(0);
        await expect.poll(() => muteCounts(page, locale, purpose)).toEqual({ cause: 0, causeButtons: 0, now: 0, check: 0, liveRegions: 0 });
        await page.screenshot({ path: info.outputPath(`released-${purpose}-${locale}-${size.width}x${size.height}.png`) });
    });
}

for (const locale of locales) for (const purpose of purposes) {
    test(`出力音量ゼロでも同じに出て、音量を戻すと両方消える（1024×768、${locale}、${purpose}）`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose, theme: 'dark', size: { width: 1024, height: 768 } });
        await setOutputMuted(page, false);
        await setOutputGain(page, 0);
        await expect.poll(() => muteCounts(page, locale, purpose)).toEqual({ cause: 1, causeButtons: 1, now: 1, check: 0, liveRegions: 1 });
        await setOutputGain(page, 1);
        await expect.poll(() => muteCounts(page, locale, purpose)).toEqual({ cause: 0, causeButtons: 0, now: 0, check: 0, liveRegions: 0 });
    });
}

for (const size of sizes) for (const locale of locales) {
    test(`ピークの数字に見える名前が付き、右の列で折り返さず、はみ出さない（実行中、${size.width}×${size.height}、${locale}）`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size });
        const peak = column(page, locale).locator('p', { hasText: message(locale, 'home.outputPeak') });
        await expect(peak).toBeVisible();
        await expect(peak.getByText(message(locale, 'home.peakLabel'), { exact: true })).toBeVisible();
        await expect(peak).toContainText('−20.0 dBFS');
        const fit = await peak.evaluate(element => {
            const aside = element.closest('aside');
            if (!aside) throw new Error('右の列がありません');
            const own = element.getBoundingClientRect();
            const columnBox = aside.getBoundingClientRect();
            const label = [...element.children].find(child => child.getAttribute('aria-hidden') === 'true');
            const value = [...element.children].find(child => child.classList.contains('font-mono'));
            if (!label || !value) throw new Error('名前か数字がありません');
            const a = label.getBoundingClientRect();
            const b = value.getBoundingClientRect();
            return {
                columnWidth: Math.round(columnBox.width),
                lineHeight: own.height,
                fontSize: parseFloat(getComputedStyle(element).fontSize),
                sameRow: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 3,
                separate: a.right <= b.left + 0.5,
                inside: own.left >= columnBox.left - 1 && own.right <= columnBox.right + 1 && b.right <= columnBox.right + 1,
                clipped: element.scrollWidth > element.clientWidth + 1,
            };
        });
        expect(fit.columnWidth).toBe(212);
        expect(fit.lineHeight, '1行に収まる').toBeLessThan(fit.fontSize * 2);
        expect(fit).toMatchObject({ sameRow: true, separate: true, inside: true, clipped: false });
    });
}

test.describe('停止中', () => {
    test.use({ liveHome: true, stoppedHome: true });
    for (const size of sizes) for (const locale of locales) {
        test(`停止中のピークは「ピーク —」で、実行中と同じ行にそろう（${size.width}×${size.height}、${locale}）`, async ({ page }, info) => {
            await openHome(page, { state: 'stopped', locale, purpose: 'voice', theme: 'dark', size });
            const peak = column(page, locale).locator('p', { hasText: message(locale, 'home.outputPeakStopped') });
            await expect(peak).toBeVisible();
            await expect(peak.getByText(message(locale, 'home.peakLabel'), { exact: true })).toBeVisible();
            await expect(peak.getByText('—', { exact: true })).toBeVisible();
            const fit = await peak.evaluate(element => {
                const aside = element.closest('aside');
                if (!aside) throw new Error('右の列がありません');
                const own = element.getBoundingClientRect();
                const columnBox = aside.getBoundingClientRect();
                return { lineHeight: own.height, fontSize: parseFloat(getComputedStyle(element).fontSize), inside: own.right <= columnBox.right + 1, clipped: element.scrollWidth > element.clientWidth + 1 };
            });
            expect(fit.lineHeight).toBeLessThan(fit.fontSize * 2);
            expect(fit).toMatchObject({ inside: true, clipped: false });
            // 停止中は音が出ないが、ミュートの札と文は出さない。
            await expect.poll(() => muteCounts(page, locale, 'voice')).toEqual({ cause: 0, causeButtons: 0, now: 0, check: 0, liveRegions: 0 });
            await page.screenshot({ path: info.outputPath(`stopped-voice-${locale}-${size.width}x${size.height}.png`) });
        });
    }
});

import { test, expect } from './tauriFixture';
import { mustBox } from './mustBox';

test.use({ liveHome: true, registeredModes: true, builtinEnabled: true });
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});

for (const width of [1200, 1600, 1920, 2560]) {
    test(`VSTのページは右の列と重ならず、ホームへ戻って開き直せる ${width}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 768 });
        await page.goto('/');
        const toggle = page.locator('#home-vst-open');
        await toggle.click();
        const vstPage = page.locator('[data-vst-page]');
        await expect(vstPage).toBeVisible();
        await expect(page.locator('.home-content')).toHaveCount(0);
        await expect.poll(async () => {
            const gap = await page.evaluate(() => {
                const pageNode = document.querySelector('[data-vst-page]');
                const columnNode = document.querySelector('aside[aria-label="本番中の操作"]');
                if (!(pageNode instanceof HTMLElement) || !(columnNode instanceof HTMLElement)) throw new Error('列かページがありません');
                const pageBox = pageNode.getBoundingClientRect();
                const column = columnNode.getBoundingClientRect();
                return column.left - pageBox.right;
            });
            return gap >= -1;
        }).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 2560) await page.screenshot({ path: testInfo.outputPath('vst-page.png') });
        await page.keyboard.press('Escape');
        await expect(vstPage).toBeVisible();
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
        await expect(vstPage).toHaveCount(0);
        await expect(toggle).toHaveText('追加');
        await toggle.focus();
        await toggle.press('Enter');
        await expect(page.locator('#add-effect-btn')).toBeFocused();
        await expect(page.locator('.app-shell')).not.toHaveAttribute('data-panel-instant');
    });
}

test('最小画面でVSTのページを開いても右の列の出力の数字は残り、横メーターと大型メーターは出さない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
    const peak = column.locator('p', { hasText: /出力のピーク/ });
    await expect(peak).toBeVisible();
    await expect(column.getByRole('meter', { name: '出力', exact: true })).toHaveCount(0);
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    await page.locator('#home-vst-open').click();
    await expect(page.locator('[data-vst-page]')).toBeVisible();
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
    await expect(peak).toBeVisible();
    await expect(page.locator('#large-meter-suspended')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('vst-page-meter.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-vst-page]')).toBeVisible();
    await expect(peak).toBeVisible();
});

test('動きを減らす設定でもVSTのページは右の列と重ならない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 2560, height: 1369 });
    await page.goto('/');
    await page.locator('#home-vst-open').click();
    const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
    const peak = column.locator('p', { hasText: /出力のピーク/ });
    await expect(peak).toBeVisible();
    await expect(column.getByRole('meter', { name: '出力', exact: true })).toHaveCount(0);
    const pageBox = await mustBox(page.locator('[data-vst-page]'));
    const peakBox = await mustBox(peak);
    expect(peakBox.x).toBeGreaterThanOrEqual(pageBox.x + pageBox.width - 1);
    expect(await page.locator('.workspace-body').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

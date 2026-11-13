import { test, expect } from './tauriFixture';

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
                const pageBox = document.querySelector('[data-vst-page]')!.getBoundingClientRect();
                const meter = document.querySelector('[role="meter"][aria-label="出力"]')!.getBoundingClientRect();
                return meter.left - pageBox.right;
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

test('最小画面でVSTのページを開いても右の列の出力メーターは残り、大型メーターは出さない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    const meter = page.getByRole('meter', { name: '出力', exact: true });
    await expect(meter).toBeVisible();
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    await page.locator('#home-vst-open').click();
    await expect(page.locator('[data-vst-page]')).toBeVisible();
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
    await expect(meter).toBeVisible();
    await expect(page.locator('#large-meter-suspended')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('vst-page-meter.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-vst-page]')).toBeVisible();
    await expect(meter).toBeVisible();
});

test('動きを減らす設定でもVSTのページは右の列と重ならない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 2560, height: 1369 });
    await page.goto('/');
    await page.locator('#home-vst-open').click();
    const meter = page.getByRole('meter', { name: '出力', exact: true });
    await expect(meter).toBeVisible();
    const pageBox = (await page.locator('[data-vst-page]').boundingBox())!;
    const meterBox = (await meter.boundingBox())!;
    expect(meterBox.x).toBeGreaterThanOrEqual(pageBox.x + pageBox.width - 1);
    expect(await page.locator('.workspace-body').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

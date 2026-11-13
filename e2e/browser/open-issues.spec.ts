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
    test(`ホームとVSTを隣接させ開閉後も主要操作を保つ ${width}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 768 });
        await page.goto('/');
                const toggle = page.locator('#vst-panel-toggle');
        const panel = page.locator('#vst-panel');
        await toggle.click();
        await expect(panel).toHaveAttribute('data-state', 'open');
        await page.locator('.workspace-body').evaluate(async node => {
            await new Promise(requestAnimationFrame);
            await Promise.all(node.getAnimations({ subtree: true })
                .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
                .map(animation => animation.finished.catch(() => {})));
        });
        await expect.poll(async () => {
            const gap = await page.evaluate(() => {
                const p = document.querySelector('#vst-panel')!.getBoundingClientRect();
                const h = document.querySelector('.home-content')!.getBoundingClientRect();
                return p.left - h.right;
            });
            return gap >= 0 && gap <= 26;
        }).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 2560) await page.screenshot({ path: testInfo.outputPath('adjacent-home-vst.png') });
        await page.locator('#plugin-rack-heading').press('Escape');
        // 横並びではEscapeを閉じる操作に割り当てないため、専用の閉じる操作を使う。
        if (await panel.count()) await panel.getByRole('button', { name: 'VST構成を閉じる', exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(toggle).toBeFocused();
        await toggle.press('Enter');
        await expect(page.locator('#plugin-rack-heading')).toBeFocused();
        await expect(page.locator('.app-shell')).toHaveAttribute('data-panel-instant', 'true');
    });
}

test('最小画面でパネルを重ねても右の列の出力メーターは残り、大型メーターの一時非表示は出さない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    const meter = page.getByRole('meter', { name: '出力', exact: true });
    await expect(meter).toBeVisible();
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    await page.locator('#vst-panel-toggle').click();
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await expect(meter).toBeVisible();
    await expect(page.locator('#large-meter-suspended')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('suspended-meter.png') });
    await page.locator('#plugin-rack-heading').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#vst-panel')).toHaveCount(0);
    await expect(meter).toBeVisible();
});

test('動きを減らす設定でも広い画面のホームとパネルが隣接する', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 2560, height: 1369 });
    await page.goto('/');
    await page.locator('#vst-panel-toggle').click();
    await expect(page.getByRole('meter', { name: '出力', exact: true })).toBeVisible();
    const home = (await page.locator('.home-content').boundingBox())!, panel = (await page.locator('#vst-panel').boundingBox())!;
    expect(panel.x - home.x - home.width).toBeLessThanOrEqual(26);
    expect(await page.locator('.workspace-body').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

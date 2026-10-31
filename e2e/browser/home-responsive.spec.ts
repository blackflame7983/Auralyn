import { test, expect } from './tauriFixture';

test.use({ liveHome: true, builtinEnabled: true });

for (const theme of ['light', 'dark', 'gaming']) {
    for (const [width, height] of [[900, 600], [1024, 768], [1200, 1920], [1920, 1080]]) {
        test(`ホームの高さとVST併用 ${theme} ${width}×${height}`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height });
            await page.addInitScript(theme => {
                localStorage.setItem('vst_host_theme', theme);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, theme);
            await page.goto('/');
            const live = page.getByRole('region', { name: '本番', exact: true });
            const input = page.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
            await expect(input).toBeVisible();
            await expect(page.locator('#home-builtin')).toHaveAttribute('data-on', 'true');
            if (height >= 900) {
                expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(64);
            }
            await live.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
            // 合成通知で静止画にもレベルを残す。実音声やドライバーの試験ではない。
            await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.35, 0.3], output: [0.3, 0.25] }));
            await page.screenshot({ path: testInfo.outputPath('home.png') });
            await page.locator('#vst-panel-toggle').click();
            const panel = page.locator('#vst-panel');
            await expect(panel).toHaveAttribute('data-state', 'open');
            if (width >= 1200) {
                await expect(page.locator('main')).not.toHaveAttribute('inert', '');
                const meter = page.locator('.large-meter-motion');
                await expect(meter).toBeVisible();
                await expect.poll(async () => {
                    const p = (await panel.boundingBox())!, m = (await meter.boundingBox())!;
                    return m.x + m.width <= p.x + 1;
                }).toBe(true);
                const record = page.getByRole('button', { name: '録音して比較', exact: true });
                await expect(record).toBeInViewport();
                if (height < 1100) expect((await record.boundingBox())!.x + (await record.boundingBox())!.width).toBeLessThan((await meter.boundingBox())!.x);
                else {
                    await expect(meter).toHaveAttribute('data-horizontal', 'true');
                    expect((await meter.boundingBox())!.y).toBeGreaterThan((await record.boundingBox())!.y);
                }
                await expect(page.locator('#home-builtin').getByRole('switch')).toBeInViewport();
            } else {
                await expect(page.locator('main')).toHaveAttribute('inert', '');
                await expect(page.locator('.large-meter-motion')).toBeHidden();
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: testInfo.outputPath('panel.png') });
        });
    }
}

test('設定の拡大表示はポインター時だけで、動きを減らす設定では止まる', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.goto('/');
    const settings = page.getByRole('button', { name: '設定を開く', exact: true });
    const surface = page.locator('.settings-surface');
    await settings.click();
    expect(await surface.evaluate(e => getComputedStyle(e).animationName)).toBe('surface-open');
    const close = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
    await expect(close).toBeFocused();
    expect(await close.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('none');
    await page.keyboard.press('Escape');
    await settings.focus();
    await page.keyboard.press('Enter');
    expect(await surface.evaluate(e => getComputedStyle(e).animationName)).toBe('surface-appear');
    await expect(close).toBeFocused();
    expect(await close.evaluate(e => e.matches(':focus-visible'))).toBe(true);
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settings.click();
    expect(await surface.evaluate(e => getComputedStyle(e).animationName)).toBe('none');
});

test('縦横を切り替えても大型メーターの開閉と詳細表示を保つ', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 1600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
    const meter = page.locator('.large-meter-motion');
    await expect(meter).toHaveAttribute('data-horizontal', 'true');
    await meter.getByRole('button', { name: '詳細表示', exact: true }).click();
    await expect(meter.getByRole('button', { name: /マイク音量/ })).toHaveCount(0);
    await meter.getByRole('button', { name: 'ミニモード', exact: true }).focus();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(meter).not.toHaveAttribute('data-horizontal', 'true');
    await expect(meter).toHaveAttribute('data-detailed', 'true');
    await expect(meter).toBeVisible();
    await expect(meter.getByRole('button', { name: 'ミニモード', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 1200, height: 1600 });
    await expect(meter).toHaveAttribute('data-horizontal', 'true');
    await expect(meter).toHaveAttribute('data-detailed', 'true');
    await meter.getByRole('button', { name: '大型レベルメーターを閉じる', exact: true }).click();
    await expect(meter).toHaveCount(0);
    await expect(page.locator('#large-meter-toggle')).toBeFocused();
});

import { test, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';

test.use({ liveHome: true, builtinEnabled: true });

for (const theme of ['light', 'dark', 'gaming']) {
    for (const [width, height] of [[900, 600], [1024, 768], [1200, 1920], [1920, 1080]]) {
        test(`ホームの高さとVST併用 ${theme} ${width}×${height}`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height });
            await page.addInitScript(theme => {
                localStorage.setItem('vst_host_theme', theme);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('vst_host_setup_goal', 'obs');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, theme);
            await page.goto('/');
            await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
            const live = page.getByRole('region', { name: '本番', exact: true });
            await expect(live).toHaveAttribute('data-roomy', 'true');
            const input = page.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
            await expect(input).toBeVisible();
            await expect(page.locator('#home-builtin')).toHaveAttribute('data-on', 'true');
            if (height >= 900) {
                expect((await input.boundingBox())!.height).toBe(18);
                expect((await live.locator('.live-stage').boundingBox())!.height).toBeGreaterThanOrEqual(160);
            }
            await live.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
            // 合成通知で静止画にもレベルを残す。実音声やドライバーの試験ではない。
            await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.35, 0.3], output: [0.3, 0.25] }));
            await page.screenshot({ path: testInfo.outputPath('home.png') });
            if (await page.locator('.sound-tool-list > li > div > button').last().getAttribute('aria-expanded') !== 'true') await page.locator('.sound-tool-list > li > div > button').last().click();
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
                const record = page.getByRole('button', { name: 'ボイスチェック', exact: true });
                await expect(record).toBeInViewport();
                if (height < 1100) expect((await record.boundingBox())!.x + (await record.boundingBox())!.width).toBeLessThan((await meter.boundingBox())!.x);
                else {
                    await expect(meter).toHaveAttribute('data-horizontal', 'true');
                    expect((await meter.boundingBox())!.y).toBeGreaterThan((await record.boundingBox())!.y);
                }
                await page.locator('.sound-tool-list > li > div > button').nth(1).click();
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

// 最小窓で日英の操作と音声チェックが収まり、装飾のON/OFFや減光も保持されることを確かめる。
for (const locale of ['ja', 'en']) {
    for (const theme of ['light', 'dark', 'gaming']) {
        test(`オーロラ舞台の最小窓 ${locale} ${theme}`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width: 960, height: 640 });
            await page.addInitScript(({ locale, theme }) => {
                localStorage.setItem('vst_host_locale', locale);
                localStorage.setItem('vst_host_theme', theme);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('vst_host_setup_goal', 'obs');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, { locale, theme });
            await page.goto('/');
            await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
            const live = page.locator('.live-strip');
            await expect(live).toHaveAttribute('data-roomy', 'true');
            await settleLayoutMotion(page);
            const devices = live.locator('.live-device');
            await devices.evaluateAll(nodes => nodes.forEach(node => { node.textContent = 'Voicemeeter Insert Virtual ASIO (Virtual Audio Interface)'; }));
            await settleLayoutMotion(page);
            await expect(devices).toHaveCount(2);
            for (const device of await devices.all()) {
                await expect(device).toBeInViewport({ ratio: 1 });
                expect(await device.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true);
            }

            await expect(live.getByRole('heading', { name: locale === 'ja' ? 'いまの調整' : 'Custom sound' })).toBeVisible();
            expect(await page.locator('main').evaluate(e => ({ width: e.scrollWidth <= e.clientWidth, height: e.scrollHeight <= e.clientHeight }))).toEqual({ width: true, height: true });
            const tools = page.locator('.sound-tool-list > li > div > button');
            await expect(tools).toHaveCount(3);
            for (const tool of await tools.all()) await expect(tool).toHaveAttribute('aria-expanded', 'false');
            const tops = await tools.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
            expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
            const closedStageHeight = (await live.locator('.live-stage').boundingBox())!.height;
            await tools.first().click();
            await expect(live).toHaveAttribute('data-roomy', 'false');
            await expect(live).toHaveAttribute('data-compact', 'true');
            await settleLayoutMotion(page);
            expect((await live.locator('.live-stage').boundingBox())!.height).toBeLessThan(closedStageHeight);
            const panel = page.locator('#home-noise');
            await expect(panel).toBeInViewport({ ratio: 1 });
            expect((await panel.boundingBox())!.y + (await panel.boundingBox())!.height).toBeLessThanOrEqual(640);
            await tools.first().press('Escape');
            await expect(tools.first()).toBeFocused();
            await expect(live).toHaveAttribute('data-roomy', 'true');
            expect(await live.locator('.meter-visual').first().evaluate(e => e.getBoundingClientRect().height)).toBeCloseTo(18, 1); // 画素未満の誤差は許す
            const aurora = live.locator('.live-aurora');
            if (theme === 'gaming') await expect(aurora).toBeHidden();
            else {
                await expect(aurora).toBeVisible();
                await page.emulateMedia({ reducedMotion: 'reduce' });
                expect(await aurora.evaluate(e => getComputedStyle(e).transform)).toBe('none');
            }
            await page.screenshot({ path: testInfo.outputPath('stage.png') });
            await live.getByRole('button', { name: locale === 'ja' ? '大型レベルメーターを開く' : 'Open large level meter', exact: true }).click();
            await expect(live.locator('.live-output-meter')).toBeHidden();
            await expect(live.locator('.live-channel-actions').last()).toBeVisible();
        });
    }
}

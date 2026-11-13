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
            const live = page.getByRole('region', { name: 'いまの状態', exact: true });
            await expect(live).toBeVisible();
            const input = page.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
            await expect(input).toBeVisible();
            await expect(page.locator('#home-builtin')).toHaveAttribute('data-on', 'true');
            if (height >= 900) expect((await input.boundingBox())!.height).toBe(16);
            await expect(page.locator('.large-meter-motion')).toHaveCount(0);
            // 合成通知で静止画にもレベルを残す。実音声やドライバーの試験ではない。
            await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.35, 0.3], output: [0.3, 0.25] }));
            await page.screenshot({ path: testInfo.outputPath('home.png') });
            await page.locator('#vst-panel-toggle').click();
            const panel = page.locator('#vst-panel');
            await expect(panel).toHaveAttribute('data-state', 'open');
            const meter = page.getByRole('meter', { name: '出力', exact: true });
            await expect(meter).toBeVisible();
            if (width >= 1200) {
                await expect(page.locator('main')).not.toHaveAttribute('inert', '');
                await expect.poll(async () => {
                    const p = (await panel.boundingBox())!, m = (await meter.boundingBox())!;
                    // 出力メーターは右の列にあり、横並びのパネルとは重ならない。
                    return m.x >= p.x + p.width - 1 || p.x >= m.x + m.width - 1;
                }).toBe(true);
                await expect(page.getByRole('button', { name: 'ボイスチェック', exact: true })).toBeInViewport();
                await expect(page.locator('#home-builtin').getByRole('switch')).toBeInViewport();
            } else {
                await expect(page.locator('main')).toHaveAttribute('inert', '');
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

test('縦横を切り替えても右の列の出力メーターが残り、大型メーターは出さない', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 1600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    const meter = page.getByRole('meter', { name: '出力', exact: true });
    for (const size of [{ width: 1200, height: 1600 }, { width: 1920, height: 1080 }, { width: 1200, height: 1600 }]) {
        await page.setViewportSize(size);
        await expect(meter).toBeVisible();
        expect((await meter.boundingBox())!.height).toBe(16);
    }
});

// 最小窓で日英の操作と音声チェックが収まり、装飾のON/OFFや減光も保持されることを確かめる。
for (const locale of ['ja', 'en']) {
    for (const theme of ['light', 'dark', 'gaming']) {
        test(`いまの状態と音の流れの最小窓 ${locale} ${theme}`, async ({ page }, testInfo) => {
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
            const columnName = locale === 'ja' ? '本番中の操作' : 'Live controls';
            const live = page.getByRole('region', { name: locale === 'ja' ? 'いまの状態' : 'Current status', exact: true });
            const column = page.getByRole('complementary', { name: columnName, exact: true });
            await expect(live).toBeVisible();
            await settleLayoutMotion(page);
            const longName = 'Voicemeeter Insert Virtual ASIO (Virtual Audio Interface)';
            const devices = column.locator('p.truncate');
            await expect(devices).toHaveCount(2);
            await devices.evaluateAll((nodes, name) => nodes.forEach(node => { node.textContent = name; node.setAttribute('title', name); }), longName);
            await settleLayoutMotion(page);
            for (const device of await devices.all()) {
                await expect(device).toBeInViewport({ ratio: 1 });
                // 右の列では1行で省略し、全文は title に残す。
                expect(await device.evaluate(el => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollHeight <= el.clientHeight + 1 && el.getAttribute('title') === el.textContent)).toBe(true);
            }

            await expect(live.getByRole('heading', { name: locale === 'ja' ? 'いまの調整' : 'Custom sound' })).toBeVisible();
            expect(await page.locator('main').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
            const cards = page.locator('.sound-module-item');
            await expect(cards).toHaveCount(3);
            await expect(page.locator('.sound-module-item h3[aria-expanded]')).toHaveCount(0);
            await expect(page.locator('#vst-panel-toggle')).toHaveAttribute('aria-expanded', 'false');
            const switches = page.locator('.sound-module-item [role="switch"]');
            await expect(switches).toHaveCount(2);
            for (const control of await switches.all()) {
                await control.scrollIntoViewIfNeeded();
                await expect(control).toBeInViewport({ ratio: 1 });
                expect(await control.evaluate(el => {
                    const r = el.getBoundingClientRect();
                    return !el.closest('[inert]') && !el.parentElement!.closest('button')
                        && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                })).toBe(true);
            }
            const tops = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
            expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
            const nowHeight = (await live.boundingBox())!.height;
            const builtin = page.locator('#home-builtin');
            await expect(page.locator('#home-noise [data-home-tier="2"]')).toHaveCount(0);
            await expect(builtin.locator('[data-home-tier="2"]')).toBeVisible();
            await builtin.scrollIntoViewIfNeeded();
            expect((await live.boundingBox())!.height).toBeCloseTo(nowHeight, 1);
            expect(await column.locator('.meter-visual').first().evaluate(e => e.getBoundingClientRect().height)).toBeCloseTo(16, 1);
            const graph = page.getByRole('img', { name: locale === 'ja' ? '加工前と加工後の音量' : 'Level before and after processing', exact: true });
            await expect(graph).toBeVisible();
            await expect(page.locator('.live-aurora')).toHaveCount(0);
            await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.2, 0.16], output: [0.12, 0.1] }));
            await expect(graph).toHaveAttribute('data-flow', 'time');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.2, 0.16], output: [0.12, 0.1] }));
            await expect(graph).toHaveAttribute('data-flow', 'still');
            await page.screenshot({ path: testInfo.outputPath('stage.png') });
            await expect(column.getByRole('meter', { name: locale === 'ja' ? '出力' : 'Output', exact: true })).toBeVisible();
        });
    }
}

for (const theme of ['light', 'dark']) test(`音の流れはテーマにかかわらず描き、オーロラの帯は出さない ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(theme => {
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    }, theme);
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.2, 0.16], output: [0.12, 0.1] }));
    const graph = page.getByRole('img', { name: '加工前と加工後の音量', exact: true });
    await expect(graph).toHaveAttribute('data-flow', 'time');
    await expect(page.locator('.live-aurora')).toHaveCount(0);
    expect(await graph.evaluate(el => el.tagName)).toBe('CANVAS');
});

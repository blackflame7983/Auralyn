import type { Locator, Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

async function reachable(locator: Locator, page: Page) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport();
    // 重なり・操作を遮る要素も実ブラウザのhit testで検出する。
    await locator.click({ trial: true });
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

for (const theme of ['light', 'dark', 'gaming']) {
    test(`900×600 ${theme}: 初回画面の操作が見切れず、設定とライセンスを往復できる`, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(theme => localStorage.setItem('vst_host_theme', theme), theme);
        await page.goto('/');
        const skip = page.getByRole('button', { name: 'セットアップをスキップ' });
        await reachable(skip, page);
        await skip.click();
        const setup = page.getByRole('button', { name: 'マイクと出力先を設定する', exact: true });
        await reachable(setup, page);
        await setup.click();
        await page.getByRole('tab', { name: '外観', exact: true }).click();
        await reachable(page.getByRole('combobox', { name: '表示言語' }), page);
        const license = page.getByRole('button', { name: /ライセンス/ });
        await reachable(license, page);
        await license.click();
        const dialog = page.getByRole('dialog', { name: 'ライセンス情報 / OSS Attribution' });
        await expect(dialog).toBeVisible();
        await reachable(dialog.getByRole('button', { name: /閉じる/ }), page);
        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        await expect(license).toBeFocused();
    });
}

test('1024×768・200%ページ拡大: 設定をキーボードで操作し、閉じると入口へ戻る', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.goto('/');
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    const setup = page.getByRole('button', { name: 'マイクと出力先を設定する', exact: true });
    await setup.click();
    const dialog = page.getByRole('dialog').last();
    const tab = dialog.getByRole('tab', { name: '外観', exact: true });
    await reachable(tab, page);
    await tab.click();
    const language = dialog.getByRole('combobox', { name: '表示言語' });
    await reachable(language, page);
    await language.focus();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('combobox', { name: 'Display language' })).toHaveValue('en');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up microphone and output', exact: true })).toBeFocused();
});

// パネルが重なる幅でも、大型メーターの下にホームの操作を隠さない。
test('900〜1100px: VST 構成と大型メーターを開いてもホームの操作を覆わない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', output: 'Test headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await page.getByRole('button', { name: '大型レベルメーターを開く' }).click();
    const meter = page.locator('div.fixed.top-16');
    await expect(meter).toBeVisible();
    for (const width of [900, 1024, 1099, 1100, 1280]) {
        await page.setViewportSize({ width, height: 600 });
        const content = page.locator('main > .mx-auto');
        const contentBox = (await content.boundingBox())!;
        const meterBox = (await meter.boundingBox())!;
        const panelBox = (await page.locator('#vst-panel').boundingBox())!;
        expect(contentBox.width).toBeGreaterThan(280);
        expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(meterBox.x + 1);
        expect(meterBox.x + meterBox.width).toBeLessThanOrEqual(panelBox.x + 1);
        const live = page.getByRole('region', { name: '本番', exact: true });
        const gain = live.getByRole('button', { name: /100%/ });
        const toggle = live.getByRole('button', { name: '大型レベルメーターを閉じる' });
        await reachable(gain, page);
        await reachable(toggle, page);
        const gainBox = (await gain.boundingBox())!;
        const toggleBox = (await toggle.boundingBox())!;
        expect(Math.max(gainBox.x + gainBox.width, toggleBox.x + toggleBox.width)).toBeLessThanOrEqual(meterBox.x + 1);
        if (width === 900 || width === 1024) await page.screenshot({ path: testInfo.outputPath(`meter-panel-${width}.png`) });
    }
    await page.getByRole('button', { name: 'VST 構成を閉じる' }).click();
    expect((await meter.boundingBox())!.x + (await meter.boundingBox())!.width).toBe(1280);
});

// 未登録の本番モードだけでは検出できなかった、ミュート表示との組合せを維持する。
test.describe('登録済みの歌・雑談と右パネル', () => {
    test.use({ liveHome: true });
    for (const theme of ['light', 'dark', 'gaming']) {
        test(`${theme}: 右パネルを先に開いても大型メーターと本番モードを操作できる`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width: 900, height: 600 });
            await page.addInitScript(theme => {
                localStorage.setItem('vst_host_theme', theme);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('vst_host_tutorial_completed', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', 'listening');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, theme);
            await page.goto('/');
            const live = page.getByRole('region', { name: '本番', exact: true });
            await expect(live.getByRole('status').filter({ hasText: '出力ミュート・音量ゼロ' })).toBeVisible();
            // モーダルを閉じる際の読み直しで、登録済みモードを画面へ反映する。
            await page.getByRole('button', { name: 'セットアップを開く', exact: true }).click();
            await page.getByRole('button', { name: 'セットアップを閉じる', exact: true }).click();
            const modes = live.getByRole('group', { name: '歌・雑談の切替' });
            await expect(modes).toBeVisible();
            await page.locator('#vst-panel-toggle').click();
            await expect(page.locator('#vst-panel')).toBeVisible();
            await reachable(live.getByRole('button', { name: '大型レベルメーターを開く', exact: true }), page);
            await live.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
            const meter = page.locator('div.fixed.top-16');
            for (const width of [900, 960, 1024, 1099, 1100, 1280]) {
                await page.setViewportSize({ width, height: 600 });
                const meterBox = (await meter.boundingBox())!;
                for (const control of [modes.getByRole('button', { name: '歌', exact: true }), modes.getByRole('button', { name: '雑談', exact: true }), live.getByRole('button', { name: /100%/ }), live.getByRole('button', { name: '大型レベルメーターを閉じる', exact: true })]) {
                    await reachable(control, page);
                    const box = (await control.boundingBox())!;
                    expect(box.x + box.width).toBeLessThanOrEqual(meterBox.x + 1);
                }
                if (width === 900 || width === 1099) await page.screenshot({ path: testInfo.outputPath(`registered-modes-${width}.png`) });
            }
            // メーターだけ閉じても、再び開く入口を右パネルの下へ隠さない。
            await page.setViewportSize({ width: 1024, height: 600 });
            await live.getByRole('button', { name: '大型レベルメーターを閉じる', exact: true }).click();
            await reachable(live.getByRole('button', { name: '大型レベルメーターを開く', exact: true }), page);
        });
    }
});

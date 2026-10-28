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

import { test, expect } from './tauriFixture';
import { message } from '../../src/i18n/messages';

for (const theme of ['dark', 'light', 'gaming']) {
    test(`ハイコントラストでもメニューのフォーカスを実線で示す ${theme}`, async ({ page }) => {
        await page.emulateMedia({ forcedColors: 'active' });
        await page.addInitScript(theme => {
            localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_locale', 'ja');
            localStorage.setItem('vst_host_wizard_done', 'true');
        }, theme);
        await page.goto('/');
        await expect(page.getByText(message('ja', 'app.initializing'), { exact: true })).toHaveCount(0);
        const trigger = page.getByRole('button', { name: message('ja', 'header.helpOpen'), exact: true });
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        const items = page.getByRole('menuitem');
        await expect(items.first()).toBeFocused();
        const count = await items.count();
        expect(count).toBeGreaterThan(1);
        for (let index = 0; index < count; index++) {
            const item = items.nth(index);
            await expect(item).toBeFocused();
            await expect(item).toHaveAttribute('data-highlighted', '');
            await expect(item).toHaveCSS('outline-style', 'solid');
            await expect(item).toHaveCSS('outline-width', '2px');
            await expect(item).toHaveCSS('outline-offset', '-2px');
            if (index + 1 < count) await page.keyboard.press('ArrowDown');
        }
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
    });
}


test('ハイコントラストでセットアップのselectの輪郭が四辺ともスクロール領域内に収まる', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.addInitScript(() => { localStorage.setItem('vst_host_locale', 'ja'); });
    await page.goto('/');
    const wizard = page.getByRole('dialog');
    await wizard.getByRole('button', { name: message('ja', 'wizard.obs'), exact: true }).click();
    const select = wizard.getByRole('combobox', { name: '機器', exact: true });
    await select.focus();
    await expect(select).toBeFocused();
    await expect(select).toHaveCSS('outline-style', 'solid');
    await expect(select).toHaveCSS('outline-width', '2px');
    await expect(select).toHaveCSS('outline-offset', '-2px');
    const bounds = await select.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const outline = { left: rect.left - reach, right: rect.right + reach, top: rect.top - reach, bottom: rect.bottom + reach };
        // overflowで切り抜く祖先をすべて照合し、左右だけでなく上下の欠けも検出する。
        let contained = true;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const css = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            const left = box.left + parent.clientLeft;
            const top = box.top + parent.clientTop;
            if (css.overflowX !== 'visible') contained &&= outline.left >= left - 1 && outline.right <= left + parent.clientWidth + 1;
            if (css.overflowY !== 'visible') contained &&= outline.top >= top - 1 && outline.bottom <= top + parent.clientHeight + 1;
        }
        return contained && outline.left >= 0 && outline.right <= innerWidth && outline.top >= 0 && outline.bottom <= innerHeight;
    });
    expect(bounds).toBe(true);
});

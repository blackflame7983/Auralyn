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

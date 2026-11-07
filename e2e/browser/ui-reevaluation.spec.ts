import { test, expect } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';

test.use({ liveHome: false });

for (const locale of ['ja', 'en'] as const) {
    const t = (key: MessageKey) => message(locale, key);
    test(`中断案内からホームの実在する入口でセットアップを再開する（${locale}）`, async ({ page }) => {
        await page.setViewportSize({ width: 960, height: 640 });
        await page.addInitScript(locale => {
            localStorage.setItem('vst_host_locale', locale);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_tutorial_completed', 'true');
        }, locale);
        await page.goto('/');
        const prep = page.getByRole('region', { name: t('prep.title'), exact: true });
        const setup = prep.getByRole('button', { name: t('header.setupOpen'), exact: true });
        await setup.click();
        await page.getByRole('button', { name: t('wizard.close'), exact: true }).click();
        await expect(page.getByText(t('wizard.interruptHint'), { exact: true })).toBeVisible();
        await page.getByRole('button', { name: t('wizard.leave'), exact: true }).click();
        await setup.click();
        await expect(page.getByRole('button', { name: t('wizard.close'), exact: true })).toBeVisible();
    });

    test(`ホットキー保存欄の下端がスクロール領域と一致する（${locale}）`, async ({ page }) => {
        await page.setViewportSize({ width: 960, height: 640 });
        await page.addInitScript(locale => {
            localStorage.setItem('vst_host_locale', locale);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_tutorial_completed', 'true');
        }, locale);
        await page.goto('/');
        await page.getByRole('button', { name: t('header.audioSettingsOpen'), exact: true }).click();
        const settings = page.getByRole('dialog', { name: t('common.settings'), exact: true });
        await settings.getByRole('tab', { name: t('settings.shortcuts'), exact: true }).click();
        const save = settings.getByRole('button', { name: t('settings.ShortcutsPanel.390'), exact: true });
        await expect(save).toBeVisible();
        for (const fraction of [0, 0.5, 1]) {
            const edges = await save.evaluate((button, fraction) => {
                const footer = button.parentElement!;
                let scroll = footer.parentElement!;
                while (!/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement!;
                scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * fraction;
                return { footer: footer.getBoundingClientRect().bottom, scroll: scroll.getBoundingClientRect().bottom };
            }, fraction);
            expect(Math.abs(edges.footer - edges.scroll)).toBeLessThanOrEqual(2);
        }
    });
}

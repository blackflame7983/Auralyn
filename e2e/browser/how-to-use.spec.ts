import { test, expect } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';

test.use({ liveHome: true });

for (const locale of ['ja', 'en'] as const) for (const size of [{ width: 960, height: 640 }, { width: 1280, height: 800 }]) for (const zoom of [1, 1.5]) {
    test(`使い方の収まりと既存画面への移動 ${locale} ${size.width}x${size.height} ${zoom}`, async ({ page }) => {
        const t = (key: MessageKey) => message(locale, key);
        await page.setViewportSize(size);
        await page.addInitScript(locale => {
            localStorage.setItem('vst_host_locale', locale);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, locale);
        await page.goto('/');
        await expect(page.getByText(t('app.initializing'), { exact: true })).toHaveCount(0);
        // 既存の拡大表示試験と同じCSS zoomで表示の収まりを確認する。
        await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        const trigger = page.getByRole('button', { name: t('header.helpOpen'), exact: true });
        await trigger.click();
        await page.getByRole('menuitem', { name: new RegExp(t('help.title')) }).click();
        const dialog = page.getByRole('dialog', { name: t('help.title'), exact: true });
        for (const section of ['home', 'setup', 'trouble', 'terms', 'keys'] as const) {
            await dialog.getByRole('button', { name: t(`help.section.${section}`), exact: true }).click();
            await expect(dialog.getByRole('heading', { name: t(`help.section.${section}`), exact: true })).toBeVisible();
            const surface = dialog.locator('.modal-surface-base');
            const rect = (await surface.boundingBox())!;
            expect(rect.x).toBeGreaterThanOrEqual(0);
            expect(rect.y).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.width).toBeLessThanOrEqual(size.width + 1);
            expect(rect.y + rect.height).toBeLessThanOrEqual(size.height + 1);
            expect(await dialog.evaluate(root => [root, ...root.querySelectorAll('*')].every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
        }
        await dialog.getByRole('button', { name: t('help.section.setup'), exact: true }).click();
        await dialog.getByRole('button', { name: t('header.setupOpen'), exact: true }).click();
        const setup = page.getByRole('dialog', { name: t('wizard.title'), exact: true });
        await expect(setup).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(setup).toHaveCount(0);
        await page.keyboard.press('F1');
        await dialog.getByRole('button', { name: t('help.section.trouble'), exact: true }).click();
        await dialog.getByRole('button', { name: t('header.noSound'), exact: true }).first().click();
        const diagnosis = page.getByRole('dialog', { name: t('guide.copy.404'), exact: true });
        await expect(diagnosis).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(diagnosis).toHaveCount(0);
        await page.keyboard.press('F1');
        await dialog.getByRole('button', { name: t('help.section.keys'), exact: true }).click();
        await dialog.getByRole('button', { name: t('help.keys.settings'), exact: true }).click();
        const settings = page.getByRole('dialog', { name: t('common.settings'), exact: true });
        await expect(settings.getByRole('tab', { name: t('settings.shortcuts'), exact: true })).toHaveAttribute('data-state', 'active');
    });
}

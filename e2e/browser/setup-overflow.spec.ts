import { test, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';
import { message, type MessageKey } from '../../src/i18n/messages';

for (const locale of ['ja', 'en'] as const) for (const theme of ['dark', 'light', 'gaming']) for (const size of [{ width: 1024, height: 768 }, { width: 960, height: 640 }]) for (const zoom of [1, 1.5]) {
    test(`仮想ケーブルなし ${locale} ${theme} ${size.width}x${size.height} ${zoom}`, async ({ page }, info) => {
        const t = (key: MessageKey) => message(locale, key);
        await page.setViewportSize(size);
        await page.addInitScript(({ theme, locale }) => {
            localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_locale', locale);
        }, { theme, locale });
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); document.documentElement.style.setProperty('--ui-zoom', String(zoom)); }, zoom);
        const wizard = page.getByRole('dialog');
        await wizard.getByRole('radio', { name: t('wizard.obs'), exact: true }).click();
        await wizard.getByRole('button', { name: t('common.next'), exact: true }).click();
        await wizard.getByRole('radio', { name: t('guide.copy.202'), exact: true }).click();
        const download = wizard.getByRole('button', { name: t('guide.copy.216'), exact: true });
        await expect(download).toBeAttached();
        await settleLayoutMotion(page);
        await page.screenshot({ path: info.outputPath(`${locale}-${theme}-${size.width}-${zoom}.png`) });
        const actions = wizard.getByTestId('setup-actions');
        const body = wizard.locator('.modal-body-base');
        const footer = (await actions.boundingBox())!;
        const content = (await body.boundingBox())!;
        expect(content.y + content.height).toBeLessThanOrEqual(footer.y + 1);
        await expect(actions.getByRole('button', { name: t('common.back'), exact: true })).toBeInViewport();
        await expect(actions.getByRole('button', { name: t('common.next'), exact: true })).toBeInViewport();
        await expect(actions.getByRole('button', { name: t('common.next'), exact: true })).toBeDisabled();
        const next = actions.getByRole('button', { name: t('common.next'), exact: true });
        const reason = actions.getByRole('status');
        await expect(reason).toHaveText(t('wizard.selectOutputToContinue'));
        await expect(reason).toBeInViewport();
        await expect(next).toHaveAccessibleDescription(t('wizard.selectOutputToContinue'));
        const reasonRect = (await reason.boundingBox())!;
        const nextRect = (await next.boundingBox())!;
        const backRect = (await actions.getByRole('button', { name: t('common.back'), exact: true }).boundingBox())!;
        expect(backRect.x + backRect.width).toBeLessThanOrEqual(reasonRect.x);
        expect(reasonRect.x + reasonRect.width).toBeLessThanOrEqual(nextRect.x);
        expect(await reason.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await actions.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(reasonRect.y + reasonRect.height).toBeLessThanOrEqual(footer.y + footer.height);
        for (const control of [download, wizard.getByRole('button', { name: t('guide.copy.220'), exact: true })]) {
            await control.scrollIntoViewIfNeeded();
            await expect(control).toBeInViewport();
            const rect = (await control.boundingBox())!;
            expect(rect.y).toBeGreaterThanOrEqual(content.y - 1);
            expect(rect.y + rect.height).toBeLessThanOrEqual(footer.y + 1);
            expect(await control.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            })).toBe(true);
        }
        await download.focus();
        await page.keyboard.press('Tab');
        await expect(wizard.getByRole('button', { name: t('guide.copy.220'), exact: true })).toBeFocused();
        await settleLayoutMotion(page);
        await page.screenshot({ path: info.outputPath(`${locale}-${theme}-${size.width}-${zoom}-scrolled.png`) });
    });
}

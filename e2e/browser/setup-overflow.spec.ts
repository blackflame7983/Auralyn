import { test, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';

for (const theme of ['dark', 'light', 'gaming']) for (const size of [{ width: 1024, height: 768 }, { width: 960, height: 640 }]) for (const zoom of [1, 1.5]) {
    test(`仮想ケーブルなし ${theme} ${size.width}x${size.height} ${zoom}`, async ({ page }, info) => {
        await page.setViewportSize(size);
        await page.addInitScript(theme => localStorage.setItem('vst_host_theme', theme), theme);
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
        const wizard = page.getByRole('dialog');
        await wizard.getByRole('button', { name: 'OBSで配信', exact: true }).click();
        await wizard.getByRole('button', { name: '次へ', exact: true }).click();
        await wizard.getByRole('button', { name: '仮想ケーブルへ', exact: true }).click();
        const download = wizard.getByRole('button', { name: 'VB-CABLEをダウンロード', exact: true });
        await expect(download).toBeAttached();
        await settleLayoutMotion(page);
        await page.screenshot({ path: info.outputPath(`${theme}-${size.width}-${zoom}.png`) });
        const actions = wizard.getByTestId('setup-actions');
        const body = wizard.locator('.modal-body-base');
        const footer = (await actions.boundingBox())!;
        const content = (await body.boundingBox())!;
        expect(content.y + content.height).toBeLessThanOrEqual(footer.y + 1);
        await expect(actions.getByRole('button', { name: '戻る', exact: true })).toBeInViewport();
        await expect(actions.getByRole('button', { name: '次へ', exact: true })).toBeInViewport();
        await expect(actions.getByRole('button', { name: '次へ', exact: true })).toBeDisabled();
        for (const control of [download, wizard.getByRole('button', { name: '再検出', exact: true })]) {
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
        await expect(wizard.getByRole('button', { name: '再検出', exact: true })).toBeFocused();
        await settleLayoutMotion(page);
        await page.screenshot({ path: info.outputPath(`${theme}-${size.width}-${zoom}-scrolled.png`) });
    });
}

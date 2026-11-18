import { test, expect } from './tauriFixture';
import { openHome, type Locale } from './helpers/openHome';
import { message } from '../../src/i18n/messages';

// 音のトラブルの診断で確かめる相手の選択は、用語表の「送り先」で呼ぶ。使い道の切り替えに見せない（#774）。
test.use({ liveHome: true });

const openLabel = (locale: Locale) => locale === 'ja' ? '音のトラブルを診断' : 'Diagnose audio problems';

for (const locale of ['ja', 'en'] as const) {
    test(`${locale}: 診断の最初の画面は「送り先」で案内し、選び直しも同じ語で出す`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size: { width: 900, height: 600 } });
        await page.getByRole('button', { name: openLabel(locale), exact: true }).click();
        const dialog = page.getByRole('dialog');
        const saved = dialog.getByText(message(locale, 'troubleshoot.savedPurpose'), { exact: true });
        const change = dialog.getByRole('button', { name: message(locale, 'troubleshoot.changePurpose'), exact: true });
        await expect(saved).toBeVisible();
        await expect(change).toBeVisible();
        await expect(dialog).not.toContainText(locale === 'ja' ? '用途' : /purpose|different use/i);

        await change.click();
        await expect(dialog.getByText(message(locale, 'guide.copy.412'), { exact: true })).toBeVisible();
        await expect(dialog).not.toContainText(locale === 'ja' ? '用途' : /purpose|different use/i);
    });
}

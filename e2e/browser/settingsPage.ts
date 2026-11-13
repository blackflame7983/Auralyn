import { expect, type Locator, type Page } from '@playwright/test';
import { message, type MessageKey } from '../../src/i18n/messages';

/** 接続・音づくり・設定のページ。モーダルのダイアログではない。 */
export function settingsPage(page: Page): Locator {
    return page.locator('[data-settings-page]');
}

export function railButton(page: Page, locale: 'ja' | 'en', key: MessageKey): Locator {
    return page.getByRole('navigation', { name: message(locale, 'rail.label') }).getByRole('button', { name: message(locale, key), exact: true });
}

/** 保存していない変更の確認が出ていたら、捨てて移動する。 */
export async function discardUnsaved(page: Page, locale: 'ja' | 'en' = 'ja') {
    const dialog = page.getByRole('alertdialog', { name: message(locale, 'settings.leave.title') });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: message(locale, 'settings.leave.discard'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
}

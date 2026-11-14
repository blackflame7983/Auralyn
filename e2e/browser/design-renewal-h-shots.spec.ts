import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { message } from '../../src/i18n/messages';
import type { Locale } from '../../src/i18n/locale';

// 開発プレビューの画面記録。通常の試験と CI では撮らない。RENEWAL_SHOTS とは別にする。
const recordShots = process.env.RENEWAL_H_SHOTS === '1';
const dir = 'docs/verification/design-renewal-h';

type Shot = { name: string; locale: Locale; width: number; height: number; screen: string };

const shots: Shot[] = [
    { name: 'home-ja-960x640', locale: 'ja', width: 960, height: 640, screen: '' },
    { name: 'home-ja-1024x768', locale: 'ja', width: 1024, height: 768, screen: '' },
    { name: 'home-ja-1440x900', locale: 'ja', width: 1440, height: 900, screen: '' },
    { name: 'home-en-1440x900', locale: 'en', width: 1440, height: 900, screen: '' },
    { name: 'home-ja-1920x1080', locale: 'ja', width: 1920, height: 1080, screen: '' },
    { name: 'home-en-1920x1080', locale: 'en', width: 1920, height: 1080, screen: '' },
    { name: 'home-ja-2560x1440', locale: 'ja', width: 2560, height: 1440, screen: '' },
    { name: 'connect-ja-1024x768', locale: 'ja', width: 1024, height: 768, screen: 'settings-audio' },
    { name: 'connect-ja-1920x1080', locale: 'ja', width: 1920, height: 1080, screen: 'settings-audio' },
    { name: 'connect-en-1920x1080', locale: 'en', width: 1920, height: 1080, screen: 'settings-audio' },
    { name: 'sound-ja-1024x768', locale: 'ja', width: 1024, height: 768, screen: 'settings-sound' },
    { name: 'sound-ja-1920x1080', locale: 'ja', width: 1920, height: 1080, screen: 'settings-sound' },
    { name: 'sound-en-1920x1080', locale: 'en', width: 1920, height: 1080, screen: 'settings-sound' },
    { name: 'help-ja-1920x1080', locale: 'ja', width: 1920, height: 1080, screen: 'help' },
];

async function openPreview(page: Page, shot: Shot) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.addInitScript(({ locale }) => {
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
    }, { locale: shot.locale });
    const params = new URLSearchParams({ mock: 'live-home' });
    if (shot.screen) params.set('screen', shot.screen);
    await page.goto(`/?${params}`);
    await expect(page.getByText(message(shot.locale, 'app.initializing'), { exact: true })).toHaveCount(0);
    if (shot.screen === 'settings-sound') await expect(page.locator('[data-settings-page="sound"]')).toBeVisible();
    if (shot.screen === 'settings-audio') await expect(page.locator('[data-settings-page="connect"]')).toBeVisible();
    if (shot.screen === 'help') await expect(page.getByRole('dialog', { name: message(shot.locale, 'help.title') })).toBeVisible();
    if (!shot.screen) await expect(page.locator('.home-content')).toBeVisible();
}

test.describe('段階 H の画面記録', () => {
    test.skip(!recordShots, '画面の記録は RENEWAL_H_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            await openPreview(page, shot);
            if (!shot.screen) {
                const mute = await page.locator('#emergency-mute').boundingBox();
                expect(mute, '緊急ミュートが画面の中にある').not.toBeNull();
                expect(mute!.y).toBeGreaterThanOrEqual(0);
                expect(mute!.y + mute!.height).toBeLessThanOrEqual(shot.height + 1);
                expect(mute!.x + mute!.width).toBeLessThanOrEqual(shot.width + 1);
            }
            if (shot.screen === 'help') {
                const dialog = await page.getByRole('dialog', { name: message(shot.locale, 'help.title') }).boundingBox();
                expect(dialog).not.toBeNull();
                expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(shot.width + 2);
                expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(shot.height + 2);
            }
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
        });
    }
});

import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { message } from '../../src/i18n/messages';
import type { Locale } from '../../src/i18n/locale';

// 開発プレビューの画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';
const dir = 'docs/verification/design-renewal-g';

type Shot = {
    name: string;
    theme: string;
    locale: Locale;
    width: number;
    height: number;
    screen: string;
    music?: boolean;
    unsaved?: boolean;
    checkItalic?: boolean;
};

const shots: Shot[] = [
    { name: 'home-ja-gaming-960x640', theme: 'gaming', locale: 'ja', width: 960, height: 640, screen: '', checkItalic: true },
    { name: 'home-en-gaming-960x640', theme: 'gaming', locale: 'en', width: 960, height: 640, screen: '', checkItalic: true },
    { name: 'home-ja-gaming-900x600-music', theme: 'gaming', locale: 'ja', width: 900, height: 600, screen: '', music: true },
    { name: 'home-ja-gaming-1024x768', theme: 'gaming', locale: 'ja', width: 1024, height: 768, screen: '' },
    { name: 'home-en-gaming-1920x1080', theme: 'gaming', locale: 'en', width: 1920, height: 1080, screen: '' },
    { name: 'home-ja-aurora-1024x768', theme: 'dark', locale: 'ja', width: 1024, height: 768, screen: '' },
    { name: 'vst-ja-gaming-1024x768', theme: 'gaming', locale: 'ja', width: 1024, height: 768, screen: 'vst' },
    { name: 'sound-ja-gaming-960x640', theme: 'gaming', locale: 'ja', width: 960, height: 640, screen: 'settings-sound' },
    { name: 'connect-ja-gaming-960x640', theme: 'gaming', locale: 'ja', width: 960, height: 640, screen: 'settings-audio' },
    { name: 'appearance-ja-gaming-1024x768', theme: 'gaming', locale: 'ja', width: 1024, height: 768, screen: 'settings-appearance' },
    { name: 'appearance-en-gaming-960x640', theme: 'gaming', locale: 'en', width: 960, height: 640, screen: 'settings-appearance', checkItalic: true },
    { name: 'unsaved-ja-gaming-960x640', theme: 'gaming', locale: 'ja', width: 960, height: 640, screen: 'settings-audio', unsaved: true },
];

async function openPreview(page: Page, shot: Shot) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.addInitScript(({ theme, locale, music }) => {
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
    }, { theme: shot.theme, locale: shot.locale, music: Boolean(shot.music) });
    const params = new URLSearchParams({ mock: 'live-home' });
    if (shot.screen) params.set('screen', shot.screen);
    await page.goto(`/?${params}`);
    await expect(page.getByText(message(shot.locale, 'app.initializing'), { exact: true })).toHaveCount(0);
    if (shot.screen === 'vst') await expect(page.locator('[data-vst-page]')).toBeVisible();
    if (shot.screen === 'settings-sound') await expect(page.locator('[data-settings-page="sound"]')).toBeVisible();
    if (shot.screen === 'settings-audio' || shot.screen === 'settings-appearance') await expect(page.locator('[data-settings-page]')).toBeVisible();
    if (!shot.screen) await expect(page.locator('.home-content')).toBeVisible();
    if (shot.unsaved) {
        const surface = page.locator('[data-settings-page]');
        await surface.locator('summary').filter({ hasText: message(shot.locale, 'settings.audioTuning.title') }).click();
        await surface.getByRole('radio', { name: message(shot.locale, 'settings.AudioSettingsModal.054'), exact: true }).click();
        await page.getByRole('navigation', { name: message(shot.locale, 'rail.label') }).getByRole('button', { name: message(shot.locale, 'rail.home'), exact: true }).click();
        const dialog = page.getByRole('alertdialog', { name: message(shot.locale, 'settings.leave.title') });
        await expect(dialog).toBeVisible();
        const stay = dialog.getByRole('button', { name: message(shot.locale, 'settings.leave.stay'), exact: true });
        await stay.evaluate(element => {
            const target = element as HTMLElement;
            target.blur();
            target.focus({ focusVisible: true } as FocusOptions);
        });
    }
}

test.describe('段階 G の画面記録', () => {
    test.skip(!recordShots, '画面の記録は RENEWAL_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            await openPreview(page, shot);
            if (!shot.unsaved) {
                const mute = await page.locator('#emergency-mute').boundingBox();
                expect(mute, '緊急ミュートが画面の中にある').not.toBeNull();
                expect(mute!.y).toBeGreaterThanOrEqual(0);
                expect(mute!.y + mute!.height).toBeLessThanOrEqual(shot.height + 1);
                expect(mute!.x).toBeGreaterThanOrEqual(0);
                expect(mute!.x + mute!.width).toBeLessThanOrEqual(shot.width + 1);
            }
            if (shot.checkItalic) {
                const clipped = await page.evaluate(() => {
                    const bad: string[] = [];
                    for (const element of document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, legend, summary')) {
                        if (element.closest('.sr-only') || getComputedStyle(element).fontStyle !== 'italic') continue;
                        const box = element.getBoundingClientRect();
                        if (box.width < 8 || box.height < 8) continue;
                        if (element.scrollWidth > element.clientWidth + 1) bad.push(`clip:${element.tagName}:${(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`);
                        const next = element.nextElementSibling;
                        if (!next) continue;
                        const title = element.getBoundingClientRect();
                        const lead = next.getBoundingClientRect();
                        if (title.width > 0 && lead.width > 0 && title.right > lead.left + 1 && title.bottom > lead.top + 1 && title.top < lead.bottom - 1) {
                            bad.push(`overlap:${(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)}`);
                        }
                    }
                    return bad;
                });
                expect(clipped).toEqual([]);
            }
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
        });
    }
});

import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// 段階3の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-3';

async function openPeak(page: Page, shot: { width: number; height: number; locale: 'ja' | 'en'; music?: boolean; details?: boolean }) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.addInitScript(({ locale, music, details }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_theme', 'dark');
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
        if (details) localStorage.setItem('vst_host_beginner_mode', 'false');
    }, shot);
    await page.goto('/?mock=live-home&screen=settings-sound');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const surface = page.locator('[data-settings-page]');
    await expect(surface).toBeVisible();
    const pageTitle = shot.locale === 'ja' ? '音づくり' : 'Sound';
    await expect(surface.getByRole('heading', { level: 1, name: pageTitle, exact: true })).toBeVisible();
    const section = shot.locale === 'ja' ? '音量の保護' : 'Loudness protection';
    // タブがあるときはタブ名が区分を示す。音楽鑑賞だけ区画の見出しがある。
    if (shot.music) {
        await expect(surface.getByRole('heading', { name: section, exact: true })).toBeVisible();
    } else {
        const tab = surface.getByRole('tab', { name: section, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
    const peak = shot.locale === 'ja' ? '大きな音を抑える' : 'Reduce loud peaks';
    await expect(surface.getByRole('switch', { name: peak, exact: true })).toBeVisible();
    return surface;
}

test.describe('段階3の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    for (const shot of [
        { name: 'peak-ja-1024x768', width: 1024, height: 768, locale: 'ja' as const },
        { name: 'peak-ja-960x640', width: 960, height: 640, locale: 'ja' as const },
        { name: 'peak-ja-1920x1080', width: 1920, height: 1080, locale: 'ja' as const },
        { name: 'peak-en-1024x768', width: 1024, height: 768, locale: 'en' as const },
        { name: 'peak-ja-1024x768-details', width: 1024, height: 768, locale: 'ja' as const, details: true },
        { name: 'peak-en-1024x768-details', width: 1024, height: 768, locale: 'en' as const, details: true },
        { name: 'music-peak-ja-1024x768', width: 1024, height: 768, locale: 'ja' as const, music: true },
    ]) {
        test(shot.name, async ({ page }) => {
            const surface = await openPeak(page, shot);
            if (shot.details) {
                const ceiling = shot.locale === 'ja' ? '天井（dBFS）' : 'Ceiling (dBFS)';
                await expect(surface.getByRole('spinbutton', { name: ceiling }).first()).toBeVisible();
            }
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
        });
    }
});

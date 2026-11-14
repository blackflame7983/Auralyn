import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

// 段階7の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-7';

async function openHome(page: Page, locale: 'ja' | 'en', theme: 'dark' | 'light' | 'gaming', width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_wizard_done', 'true');
    }, { locale, theme });
    await page.goto('/');
    const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
    await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
    const voice = locale === 'ja' ? 'ボイスチェック' : 'Voice Check';
    await expect(page.getByRole('button', { name: voice, exact: true })).toBeVisible();
}

test.describe('段階7の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.use({ liveHome: true });
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    test('home-ja-dark-1024x768', async ({ page }) => {
        await openHome(page, 'ja', 'dark', 1024, 768);
        await page.screenshot({ path: `${dir}/home-ja-dark-1024x768.png`, animations: 'disabled' });
    });

    test('home-ja-light-1024x768', async ({ page }) => {
        await openHome(page, 'ja', 'light', 1024, 768);
        await page.screenshot({ path: `${dir}/home-ja-light-1024x768.png`, animations: 'disabled' });
    });

    test('home-ja-gaming-1024x768', async ({ page }) => {
        await openHome(page, 'ja', 'gaming', 1024, 768);
        await page.screenshot({ path: `${dir}/home-ja-gaming-1024x768.png`, animations: 'disabled' });
    });

    test('home-en-dark-1024x768', async ({ page }) => {
        await openHome(page, 'en', 'dark', 1024, 768);
        await page.screenshot({ path: `${dir}/home-en-dark-1024x768.png`, animations: 'disabled' });
    });

    test('home-ja-dark-960x640', async ({ page }) => {
        await openHome(page, 'ja', 'dark', 960, 640);
        await page.screenshot({ path: `${dir}/home-ja-dark-960x640.png`, animations: 'disabled' });
    });

    test('sound-ja-dark-1024x768', async ({ page }) => {
        await openHome(page, 'ja', 'dark', 1024, 768);
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '音づくり', exact: true }).click();
        await expect(page.getByRole('heading', { level: 1, name: '音づくり', exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/sound-ja-dark-1024x768.png`, animations: 'disabled' });
    });

    test('sound-en-dark-1024x768', async ({ page }) => {
        await openHome(page, 'en', 'dark', 1024, 768);
        await page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Sound', exact: true }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Sound', exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/sound-en-dark-1024x768.png`, animations: 'disabled' });
    });

    test('sound-ja-gaming-1024x768', async ({ page }) => {
        await openHome(page, 'ja', 'gaming', 1024, 768);
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '音づくり', exact: true }).click();
        await expect(page.getByRole('heading', { level: 1, name: '音づくり', exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/sound-ja-gaming-1024x768.png`, animations: 'disabled' });
    });
});

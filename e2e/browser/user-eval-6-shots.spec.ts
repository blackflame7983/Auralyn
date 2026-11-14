import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

// 段階6の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-6';

async function openApp(page: Page, locale: 'ja' | 'en', width: number, height: number, folders: string[] | null, preview: boolean) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(({ locale, folders }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        if (folders) localStorage.setItem('auralyn_vst_scan_folders', JSON.stringify(folders));
    }, { locale, folders });
    await page.goto(preview ? '/?previewScanFolders=1' : '/');
    const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
    await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
    const nav = locale === 'ja' ? '行き先' : 'Destinations';
    const add = locale === 'ja' ? 'VSTを追加' : 'Add VST';
    await page.getByRole('navigation', { name: nav }).getByRole('button', { name: 'VST', exact: true }).click();
    await page.getByRole('button', { name: add, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: add });
    await expect(dialog.getByRole('region', { name: locale === 'ja' ? '探すフォルダー' : 'Folders to search' })).toBeVisible();
    return dialog;
}

test.describe('段階6の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.use({ liveHome: true });
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    test('folders-ja-1024x768', async ({ page }) => {
        await openApp(page, 'ja', 1024, 768, null, false);
        await page.screenshot({ path: `${dir}/folders-ja-1024x768.png`, animations: 'disabled' });
    });

    test('folders-en-1024x768', async ({ page }) => {
        const dialog = await openApp(page, 'en', 1024, 768, null, false);
        // 閉じた区画を開いた状態も撮る。
        await dialog.getByRole('region', { name: 'Folders to search' }).locator('summary').click();
        await page.screenshot({ path: `${dir}/folders-en-1024x768.png`, animations: 'disabled' });
    });

    test('folders-ja-960x640', async ({ page }) => {
        const dialog = await openApp(page, 'ja', 960, 640, null, false);
        // 閉じた区画を開いた状態も撮る。
        await dialog.getByRole('region', { name: '探すフォルダー' }).locator('summary').click();
        await page.screenshot({ path: `${dir}/folders-ja-960x640.png`, animations: 'disabled' });
    });

    test('folders-found-ja-1024x768', async ({ page }) => {
        const dialog = await openApp(page, 'ja', 1024, 768, ['D:\\Custom\\VST3', 'D:\\Missing\\VST3'], true);
        await dialog.getByRole('button', { name: '更新', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Room を追加', exact: true })).toBeVisible();
        await expect(dialog.getByText('見つかりません', { exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/folders-found-ja-1024x768.png`, animations: 'disabled' });
    });

    test('folders-found-en-1024x768', async ({ page }) => {
        const dialog = await openApp(page, 'en', 1024, 768, ['D:\\Custom\\VST3', 'D:\\Missing\\VST3'], true);
        await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Add Room', exact: true })).toBeVisible();
        await expect(dialog.getByText('Not found', { exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/folders-found-en-1024x768.png`, animations: 'disabled' });
    });
});

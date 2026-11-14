import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// 段階2の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-2';

test.describe('段階2の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_locale', 'ja');
            localStorage.setItem('vst_host_wizard_done', 'true');
        });
    });

    test('home-ja-1024x768', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto('/?mock=live-home');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '音量を測る', exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/home-ja-1024x768.png`, animations: 'disabled' });
    });

    test('music-playback-ja-1024x768', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(() => localStorage.setItem('auralyn_display_purpose', 'music'));
        await page.goto('/?mock=live-home');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        const open = page.getByRole('button', { name: '再生の確認', exact: true });
        await expect(open).toBeEnabled();
        await open.click();
        await expect(page.getByRole('region', { name: '再生の確認', exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/music-playback-ja-1024x768.png`, animations: 'disabled' });
    });

    for (const shot of [
        { name: 'connect-ja-1024x768', screen: 'settings-audio', title: '接続' },
        { name: 'sound-ja-1024x768', screen: 'settings-sound', title: '音づくり' },
        { name: 'vst-ja-1024x768', screen: 'vst', title: 'VST' },
        { name: 'settings-ja-1024x768', screen: 'settings-appearance', title: '設定' },
    ]) {
        test(shot.name, async ({ page }) => {
            await page.setViewportSize({ width: 1024, height: 768 });
            await page.goto(`/?mock=live-home&screen=${shot.screen}`);
            await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
            await expect(page.getByRole('heading', { level: 1, name: shot.title, exact: true })).toBeVisible();
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
        });
    }

    test('voice-check-ja-960x640', async ({ page }) => {
        await page.setViewportSize({ width: 960, height: 640 });
        await page.goto('/?mock=live-home&screen=voice-check');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /録音開始/ })).toBeVisible();
        await page.screenshot({ path: `${dir}/voice-check-ja-960x640.png`, animations: 'disabled' });
    });

    test('plugins-ja-1024x768', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto('/?mock=live-home&screen=plugin-browser');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible();
        await page.screenshot({ path: `${dir}/plugins-ja-1024x768.png`, animations: 'disabled' });
    });
});

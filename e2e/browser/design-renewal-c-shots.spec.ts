import { test, expect } from '@playwright/test';

// 開発プレビューの画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';

const shots = [
    { mock: 'live-home', theme: 'dark', width: 960, height: 640 },
    { mock: 'live-home', theme: 'light', width: 1024, height: 768 },
    { mock: 'live-home', theme: 'gaming', width: 1920, height: 1080 },
    { mock: 'live-home', theme: 'dark', width: 900, height: 600, music: true },
    { mock: 'live-home', theme: 'light', width: 960, height: 640 },
    { mock: 'stopped-home', theme: 'light', width: 960, height: 640 },
    { mock: 'stopped-home', theme: 'gaming', width: 1024, height: 768 },
    { mock: 'stopped-home', theme: 'dark', width: 1920, height: 1080 },
    { mock: 'first-run', theme: 'dark', width: 1024, height: 768 },
    { mock: 'first-run', theme: 'light', width: 960, height: 640 },
] as const;

test.describe('段階 C の画面記録', () => {
    test.skip(!recordShots, '画面の記録は RENEWAL_SHOTS=1 のときだけ撮る');
    for (const shot of shots) {
        test(`${shot.mock} ${shot.theme} ${shot.width}x${shot.height}${'music' in shot ? ' music' : ''}`, async ({ page }) => {
            await page.setViewportSize({ width: shot.width, height: shot.height });
            await page.addInitScript(({ theme, music }) => {
                localStorage.setItem('vst_host_theme', theme);
                if (music) localStorage.setItem('auralyn_display_purpose', 'music');
            }, { theme: shot.theme, music: 'music' in shot });
            await page.goto(`/?mock=${shot.mock}`);
            await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
            if (shot.mock === 'first-run') await expect(page.getByRole('dialog', { name: 'セットアップ' })).toBeVisible();
            else await expect(page.getByRole('navigation', { name: '行き先', exact: true })).toBeVisible();
            const suffix = 'music' in shot ? '-music' : '';
            await page.screenshot({ path: `docs/verification/design-renewal-c/${shot.mock}-${shot.theme}-${shot.width}x${shot.height}${suffix}.png`, animations: 'disabled' });
        });
    }
});

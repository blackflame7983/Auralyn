import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// 段階1の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-1';

const shots = [
    { name: 'home-ja-960x640', mock: 'live-home', locale: 'ja', width: 960, height: 640, home: true },
    { name: 'home-ja-1024x768', mock: 'live-home', locale: 'ja', width: 1024, height: 768, home: true },
    { name: 'stopped-ja-960x640', mock: 'stopped-home', locale: 'ja', width: 960, height: 640, home: true },
    { name: 'music-home-ja-900x600', mock: 'live-home', locale: 'ja', width: 900, height: 600, music: true, home: true },
    { name: 'sound-ja-960x640', mock: 'live-home', locale: 'ja', width: 960, height: 640, screen: 'settings-sound' },
    { name: 'music-sound-ja-960x640', mock: 'live-home', locale: 'ja', width: 960, height: 640, music: true, screen: 'settings-sound' },
    { name: 'home-en-1024x768', mock: 'live-home', locale: 'en', width: 1024, height: 768, home: true },
    { name: 'sound-en-1024x768', mock: 'live-home', locale: 'en', width: 1024, height: 768, screen: 'settings-sound' },
] as const;

test.describe('段階1の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            await page.setViewportSize({ width: shot.width, height: shot.height });
            await page.addInitScript(({ locale, music }) => {
                localStorage.setItem('vst_host_locale', locale);
                localStorage.setItem('vst_host_wizard_done', 'true');
                if (music) localStorage.setItem('auralyn_display_purpose', 'music');
            }, { locale: shot.locale, music: 'music' in shot && shot.music });
            const screen = 'screen' in shot ? shot.screen : '';
            await page.goto(`/?mock=${shot.mock}${screen ? `&screen=${screen}` : ''}`);
            await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
            if ('home' in shot && shot.home) {
                await expect(page.getByRole('complementary', { name: shot.locale === 'ja' ? '本番中の操作' : 'Live controls', exact: true })).toBeVisible();
            } else {
                await expect(page.locator('[data-settings-page]')).toBeVisible();
            }
            if (shot.name === 'home-ja-960x640' || shot.name === 'home-ja-1024x768') {
                const badge = page.getByRole('button', { name: '出力ミュート・音量ゼロ', exact: true });
                await expect(badge).toBeVisible();
                const clipped = await badge.evaluate(element => element.scrollWidth > element.clientWidth + 1);
                expect(clipped).toBe(false);
                await expect(page.locator('#home-vst-open')).toHaveText('追加');
                await expect(page.getByRole('radio', { name: '弱', exact: true }).first()).toHaveAttribute('aria-checked', 'false');
                await expect(page.getByRole('radio', { name: '強', exact: true }).first()).toHaveAttribute('aria-checked', 'false');
            }
            if (shot.name === 'music-sound-ja-960x640') {
                await expect(page.getByRole('heading', { name: '音量の保護', exact: true })).toBeVisible();
                await expect(page.getByRole('region', { name: '配信用 true-peak 制限', exact: true })).toHaveCount(0);
            }
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
        });
    }
});

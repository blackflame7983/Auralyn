import { test, expect } from '@playwright/test';

// 開発プレビューの画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';

const shots = [
    { name: 'connect-ja-dark-960x640', screen: 'settings-audio', theme: 'dark', locale: 'ja', width: 960, height: 640 },
    { name: 'connect-en-light-960x640', screen: 'settings-audio', theme: 'light', locale: 'en', width: 960, height: 640 },
    { name: 'connect-ja-gaming-900x600-music', screen: 'settings-audio', theme: 'gaming', locale: 'ja', width: 900, height: 600, music: true },
    { name: 'connect-ja-light-1024x768', screen: 'settings-audio', theme: 'light', locale: 'ja', width: 1024, height: 768 },
    { name: 'sound-ja-dark-1024x768', screen: 'settings-sound', theme: 'dark', locale: 'ja', width: 1024, height: 768 },
    { name: 'sound-en-gaming-1920x1080', screen: 'settings-sound', theme: 'gaming', locale: 'en', width: 1920, height: 1080 },
    { name: 'appearance-ja-dark-960x640', screen: 'settings-appearance', theme: 'dark', locale: 'ja', width: 960, height: 640 },
    { name: 'appearance-en-light-1920x1080', screen: 'settings-appearance', theme: 'light', locale: 'en', width: 1920, height: 1080 },
    { name: 'shortcuts-ja-gaming-960x640', screen: 'settings-shortcuts', theme: 'gaming', locale: 'ja', width: 960, height: 640 },
    { name: 'obs-ja-dark-1024x768', screen: 'settings-obs', theme: 'dark', locale: 'ja', width: 1024, height: 768 },
    { name: 'system-ja-light-900x600-music', screen: 'settings-system', theme: 'light', locale: 'ja', width: 900, height: 600, music: true },
    { name: 'system-ja-gaming-1920x1080', screen: 'settings-system', theme: 'gaming', locale: 'ja', width: 1920, height: 1080 },
] as const;

test.describe('段階 D の画面記録', () => {
    test.skip(!recordShots, '画面の記録は RENEWAL_SHOTS=1 のときだけ撮る');
    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            await page.setViewportSize({ width: shot.width, height: shot.height });
            await page.addInitScript(({ theme, locale, music }) => {
                localStorage.setItem('vst_host_theme', theme);
                localStorage.setItem('vst_host_locale', locale);
                if (music) localStorage.setItem('auralyn_display_purpose', 'music');
            }, { theme: shot.theme, locale: shot.locale, music: 'music' in shot && shot.music });
            await page.goto(`/?mock=live-home&screen=${shot.screen}`);
            await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
            const surface = page.locator('[data-settings-page]');
            await expect(surface).toBeVisible();
            await page.screenshot({ path: `docs/verification/design-renewal-d/${shot.name}.png`, animations: 'disabled' });
            if (shot.screen === 'settings-audio' && shot.width === 960 && shot.height === 640) {
                const overflow = await surface.evaluate(root => {
                    const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')];
                    // 閉じた select は、候補の幅を scrollWidth に含める。表示のはみ出しには数えない。
                    return nodes.filter(el => el.tagName !== 'SELECT' && el.tagName !== 'OPTION' && !el.classList.contains('sr-only') && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible').map(el => `${el.tagName}.${el.className.toString().split(' ')[0]}:${(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)}`);
                });
                expect(overflow).toEqual([]);
            }
        });
    }

    test('未保存の確認 ja dark 960x640', async ({ page }) => {
        await page.setViewportSize({ width: 960, height: 640 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_theme', 'dark');
            localStorage.setItem('vst_host_locale', 'ja');
        });
        await page.goto('/?mock=live-home&screen=settings-audio');
        const surface = page.locator('[data-settings-page]');
        await expect(surface).toBeVisible();
        const tuning = surface.locator('summary').filter({ hasText: '接続方式・音切れの設定' });
        await tuning.click();
        await surface.getByRole('radio', { name: /途切れにくく/ }).click();
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
        await expect(page.getByRole('alertdialog', { name: '保存していない変更があります' })).toBeVisible();
        await page.screenshot({ path: 'docs/verification/design-renewal-d/unsaved-ja-dark-960x640.png', animations: 'disabled' });
    });
});

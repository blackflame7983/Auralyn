import { test, expect } from '@playwright/test';

// 開発プレビュー（?mock=）の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';

const shots = [
    { mock: 'live-home', theme: 'light', width: 960, height: 640 },
    { mock: 'live-home', theme: 'dark', width: 1024, height: 768 },
    { mock: 'live-home', theme: 'gaming', width: 1920, height: 1080 },
    { mock: 'live-home', theme: 'gaming', width: 900, height: 600, music: true },
    { mock: 'stopped-home', theme: 'light', width: 960, height: 640 },
    { mock: 'stopped-home', theme: 'dark', width: 1024, height: 768 },
    { mock: 'stopped-home', theme: 'gaming', width: 1920, height: 1080 },
    { mock: 'first-run', theme: 'light', width: 1024, height: 768 },
    { mock: 'first-run', theme: 'dark', width: 960, height: 640 },
    { mock: 'first-run', theme: 'gaming', width: 900, height: 600 },
] as const;

test.describe('段階 B の画面記録', () => {
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
            else await expect(page.getByRole('complementary', { name: '本番中の操作', exact: true })).toBeVisible();
            const suffix = 'music' in shot ? '-music' : '';
            await page.screenshot({ path: `docs/verification/design-renewal-b/${shot.mock}-${shot.theme}-${shot.width}x${shot.height}${suffix}.png`, animations: 'disabled' });
        });
    }

    test('音調整の列数と内側の幅', async ({ page }) => {
        test.skip(!recordShots, '画面の記録は RENEWAL_SHOTS=1 のときだけ測る');
        const measure = async (width: number, height: number, locale?: string) => {
            await page.setViewportSize({ width, height });
            if (locale) await page.addInitScript(locale => localStorage.setItem('vst_host_locale', locale), locale);
            await page.goto('/?mock=live-home');
            await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
            await expect(page.locator('.sound-tool-list')).toBeVisible();
            return page.locator('.sound-chain').evaluate(chain => {
                const list = chain.querySelector('.sound-tool-list') as HTMLElement;
                const tops = [...list.children].map(item => (item as HTMLElement).getBoundingClientRect().top);
                const cards = [...list.querySelectorAll('.sound-module-card')] as HTMLElement[];
                return {
                    chain: Math.round(chain.getBoundingClientRect().width),
                    columns: getComputedStyle(list).gridTemplateColumns,
                    sameRow: Math.max(...tops) - Math.min(...tops) <= 2,
                    overflow: cards.some(card => card.scrollWidth - card.clientWidth > 1),
                };
            });
        };
        const at960 = await measure(960, 640);
        const at1024 = await measure(1024, 768);
        // 帯の外寸が約590pxになる窓。声の種類が3列では欠けるため、ここでは1列になる。
        const about590 = await measure(834, 640);
        const en960 = await measure(960, 640, 'en');
        console.log(JSON.stringify({ at960, at1024, about590, en960 }));
        expect(at960.sameRow).toBe(true);
        expect(at960.overflow).toBe(false);
        expect(at1024.sameRow).toBe(true);
        expect(at1024.overflow).toBe(false);
        expect(about590.chain).toBeGreaterThan(560);
        expect(about590.chain).toBeLessThan(620);
        expect(about590.sameRow).toBe(false);
        expect(about590.overflow).toBe(false);
        expect(en960.sameRow).toBe(true);
        expect(en960.overflow).toBe(false);
    });
});

import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// 開発プレビューの画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';
const dir = 'docs/verification/design-renewal-f';

const session = JSON.stringify([
    { path: 'eq.vst3', name: 'Equalizer', vendor: 'Example', version: '1', enabled: true, muted: false, gain: 1 },
    { path: 'comp.vst3', name: 'Compressor', vendor: 'Example', version: '1', enabled: false, muted: false, gain: 1 },
    { path: 'reverb.vst3', name: 'Room', vendor: 'Example', version: '1', enabled: true, muted: false, gain: 1 },
]);

type Shot = {
    name: string;
    theme: string;
    locale: 'ja' | 'en';
    width: number;
    height: number;
    screen: string;
    music?: boolean;
    plugins?: boolean;
    search?: string;
    scanError?: boolean;
    check?: boolean;
};

const shots: Shot[] = [
    { name: 'vst-empty-ja-aurora-960x640', theme: 'dark', locale: 'ja', width: 960, height: 640, screen: 'vst', check: true },
    { name: 'vst-empty-en-light-960x640', theme: 'light', locale: 'en', width: 960, height: 640, screen: 'vst', check: true },
    { name: 'vst-plugins-ja-aurora-1280x800', theme: 'dark', locale: 'ja', width: 1280, height: 800, screen: 'vst', plugins: true },
    { name: 'vst-plugins-en-gaming-1920x1080', theme: 'gaming', locale: 'en', width: 1920, height: 1080, screen: 'vst', plugins: true },
    { name: 'vst-music-ja-aurora-900x600', theme: 'dark', locale: 'ja', width: 900, height: 600, screen: 'vst', music: true },
    { name: 'vst-music-en-light-1920x1080', theme: 'light', locale: 'en', width: 1920, height: 1080, screen: 'vst', music: true, plugins: true },
    { name: 'browser-empty-ja-aurora-1024x768', theme: 'dark', locale: 'ja', width: 1024, height: 768, screen: 'plugin-browser' },
    { name: 'browser-search-en-light-960x640', theme: 'light', locale: 'en', width: 960, height: 640, screen: 'plugin-browser', search: 'no-such-plugin' },
    { name: 'browser-error-ja-gaming-1280x800', theme: 'gaming', locale: 'ja', width: 1280, height: 800, screen: 'plugin-browser', scanError: true },
    { name: 'templates-ja-aurora-1024x768', theme: 'dark', locale: 'ja', width: 1024, height: 768, screen: 'template-wizard' },
    { name: 'templates-en-light-1920x1080', theme: 'light', locale: 'en', width: 1920, height: 1080, screen: 'template-wizard' },
    { name: 'home-ja-aurora-1280x800', theme: 'dark', locale: 'ja', width: 1280, height: 800, screen: '' },
    { name: 'home-en-light-1280x800', theme: 'light', locale: 'en', width: 1280, height: 800, screen: '' },
    { name: 'vst-empty-gaming-960x640', theme: 'gaming', locale: 'ja', width: 960, height: 640, screen: 'vst' },
];

async function openPreview(page: Page, shot: Shot) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.addInitScript(({ theme, locale, music, plugins, saved }) => {
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
        if (plugins) localStorage.setItem('vst_host_session_plugins', saved);
    }, { theme: shot.theme, locale: shot.locale, music: Boolean(shot.music), plugins: Boolean(shot.plugins), saved: session });
    const params = new URLSearchParams({ mock: 'live-home' });
    if (shot.screen) params.set('screen', shot.screen);
    if (shot.plugins) params.set('previewPlugins', '1');
    if (shot.scanError) params.set('previewScanError', '1');
    await page.goto(`/?${params}`);
    await expect(page.getByText(shot.locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…', { exact: true })).toHaveCount(0);
    if (shot.screen === 'vst') {
        await expect(page.locator('[data-vst-page]')).toBeVisible();
        if (shot.plugins) await expect(page.getByRole('heading', { name: 'Equalizer', level: 3 })).toBeVisible();
    }
    if (shot.screen === 'plugin-browser') {
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        if (shot.search) {
            await dialog.getByRole('textbox').fill(shot.search);
            await expect(dialog.getByRole('heading', { name: new RegExp(shot.search) })).toBeVisible();
        }
        if (shot.scanError) {
            await dialog.getByRole('button', { name: shot.locale === 'ja' ? 'すべて再スキャン' : 'Rescan all', exact: true }).click();
            await expect(dialog.getByRole('button', { name: shot.locale === 'ja' ? '再試行' : 'Try again', exact: true })).toBeVisible();
        }
    }
    if (shot.screen === 'template-wizard') await expect(page.getByRole('dialog')).toBeVisible();
    if (!shot.screen) await expect(page.locator('.home-content')).toBeVisible();
}

test.describe('段階 F の画面記録', () => {
    test.skip(!recordShots, '画面の記録は RENEWAL_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            await openPreview(page, shot);
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
            if (!shot.check) return;
            const root = page.locator('[data-vst-page]');
            const overflow = await root.evaluate(node => {
                const nodes = [node, ...node.querySelectorAll<HTMLElement>('*')];
                return nodes.filter(el => el.tagName !== 'SELECT' && el.tagName !== 'OPTION' && !el.classList.contains('sr-only') && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible').map(el => `${el.tagName}.${el.className.toString().split(' ')[0]}:${(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`);
            });
            const splitWords = await root.evaluate(node => {
                const bad: string[] = [];
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                const range = document.createRange();
                while (walker.nextNode()) {
                    const current = walker.currentNode;
                    const parent = current.parentElement;
                    if (!parent || parent.closest('.sr-only')) continue;
                    const text = current.textContent ?? '';
                    for (const match of text.matchAll(/[A-Za-z]{2,}/g)) {
                        range.setStart(current, match.index ?? 0);
                        range.setEnd(current, (match.index ?? 0) + match[0].length);
                        const rects = [...range.getClientRects()].filter(rect => rect.width > 0.5 && rect.height > 0.5);
                        if (rects.length > 1) bad.push(match[0]);
                    }
                }
                return bad;
            });
            expect(overflow).toEqual([]);
            expect(splitWords).toEqual([]);
        });
    }
});

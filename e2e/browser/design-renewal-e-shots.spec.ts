import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// 開発プレビューの画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';
const dir = 'docs/verification/design-renewal-e';

const shots = [
    { name: 'basic-ja-aurora-960x640', place: 'basic', theme: 'dark', locale: 'ja', width: 960, height: 640, check: true },
    { name: 'basic-en-light-960x640', place: 'basic', theme: 'light', locale: 'en', width: 960, height: 640, check: true },
    { name: 'modes-ja-gaming-1024x768', place: 'liveModes', theme: 'gaming', locale: 'ja', width: 1024, height: 768 },
    { name: 'singing-ja-aurora-1024x768', place: 'singing', theme: 'dark', locale: 'ja', width: 1024, height: 768 },
    { name: 'singing-en-light-1920x1080', place: 'singing', theme: 'light', locale: 'en', width: 1920, height: 1080 },
    { name: 'peak-ja-light-960x640', place: 'peak', theme: 'light', locale: 'ja', width: 960, height: 640 },
    { name: 'peak-en-gaming-1920x1080', place: 'peak', theme: 'gaming', locale: 'en', width: 1920, height: 1080 },
    { name: 'music-ja-aurora-900x600', place: 'music', theme: 'dark', locale: 'ja', width: 900, height: 600 },
    { name: 'music-en-gaming-1920x1080', place: 'music', theme: 'gaming', locale: 'en', width: 1920, height: 1080 },
    { name: 'hotkeys-ja-aurora-960x640', place: 'hotkeys', theme: 'dark', locale: 'ja', width: 960, height: 640, check: true },
    { name: 'hotkeys-en-light-960x640', place: 'hotkeys', theme: 'light', locale: 'en', width: 960, height: 640, check: true },
    { name: 'hotkeys-ja-gaming-1920x1080', place: 'hotkeys', theme: 'gaming', locale: 'ja', width: 1920, height: 1080 },
] as const;

const placeName = { ja: { basic: '基本', liveModes: '歌・雑談', singing: '歌向け', peak: '音量の保護' }, en: { basic: 'Basics', liveModes: 'Singing and talking', singing: 'Singing', peak: 'Loudness protection' } } as const;

async function openPreview(page: import('@playwright/test').Page, shot: { theme: string; locale: 'ja' | 'en'; width: number; height: number; place: 'basic' | 'liveModes' | 'singing' | 'peak' | 'music' | 'hotkeys' }) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.addInitScript(({ theme, locale, music }) => {
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
    }, { theme: shot.theme, locale: shot.locale, music: shot.place === 'music' });
    await page.goto(`/?mock=live-home&screen=${shot.place === 'hotkeys' ? 'settings-shortcuts' : 'settings-sound'}`);
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const surface = page.locator('[data-settings-page]');
    await expect(surface).toBeVisible();
    if (shot.place === 'hotkeys') {
        await expect(surface.getByRole('tab', { name: shot.locale === 'ja' ? 'ホットキー' : 'Hotkeys', exact: true })).toHaveAttribute('aria-selected', 'true');
    } else if (shot.place === 'music') {
        // 音楽鑑賞は起動時に VST パネルが開く。音づくりのページを撮るため、パネルだけ閉じる。
        await page.getByRole('button', { name: shot.locale === 'ja' ? 'VST構成を閉じる' : 'Close VST setup', exact: true }).click();
        await expect(surface.getByRole('heading', { name: placeName[shot.locale].peak, exact: true })).toBeVisible();
    } else if (shot.place === 'liveModes' || shot.place === 'singing' || shot.place === 'peak') {
        await surface.getByRole('tab', { name: placeName[shot.locale][shot.place], exact: true }).click();
        await expect(surface.getByRole('heading', { name: placeName[shot.locale][shot.place], exact: true })).toBeVisible();
    } else {
        await expect(surface.getByRole('heading', { name: placeName[shot.locale].basic, exact: true })).toBeVisible();
    }
    return surface;
}

test.describe('段階 E の画面記録', () => {
    test.skip(!recordShots, '画面の記録は RENEWAL_SHOTS=1 のときだけ撮る');
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            const surface = await openPreview(page, shot);
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
            if (!('check' in shot) || !shot.check) return;
            const overflow = await surface.evaluate(root => {
                const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')];
                return nodes.filter(el => el.tagName !== 'SELECT' && el.tagName !== 'OPTION' && !el.classList.contains('sr-only') && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible').map(el => `${el.tagName}.${el.className.toString().split(' ')[0]}:${(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`);
            });
            const splitWords = await surface.evaluate(root => {
                const bad: string[] = [];
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                const range = document.createRange();
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const parent = node.parentElement;
                    if (!parent || parent.closest('.sr-only') || parent.tagName === 'OPTION') continue;
                    const text = node.textContent ?? '';
                    for (const match of text.matchAll(/[A-Za-z]{2,}/g)) {
                        range.setStart(node, match.index ?? 0);
                        range.setEnd(node, (match.index ?? 0) + match[0].length);
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

    test('小区分の部品数と、保護・ホットキーの幅', async ({ page }) => {
        const surface = await openPreview(page, { theme: 'dark', locale: 'ja', width: 960, height: 640, place: 'basic' });
        const count = () => surface.evaluate(() => {
            const section = document.querySelector('#sound-section, #live-mode-section, #singing-settings');
            const nodes = section ? [...section.querySelectorAll('button, input, select, textarea, summary, a, [role="slider"]')] : [];
            const bar = [...document.querySelectorAll('[data-settings-page] > div, [data-settings-page] .border-t')].flatMap(el => [...el.querySelectorAll('button')]).filter(button => button.textContent?.includes('適用'));
            return nodes.length + new Set(bar).size;
        });
        const counts: Record<string, number> = { basic: await count() };
        for (const place of ['liveModes', 'singing', 'peak'] as const) {
            await surface.getByRole('tab', { name: placeName.ja[place], exact: true }).click();
            counts[place] = await count();
        }
        await surface.getByRole('tab', { name: '音量の保護', exact: true }).click();
        const peak = await surface.evaluate(() => {
            const names = ['ピーク保護をON', '配信用 true-peak 制限を ON'];
            const buttons = names.map(name => {
                const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name);
                const rect = button?.getBoundingClientRect();
                return rect ? { name, y: Math.round(rect.y), bottom: Math.round(rect.bottom), inView: rect.top >= 0 && rect.bottom <= window.innerHeight } : null;
            });
            const scroller = [...document.querySelectorAll('[data-settings-page] *')].find(el => {
                const style = getComputedStyle(el);
                return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
            });
            return { buttons, scrollHeight: scroller?.scrollHeight ?? 0, clientHeight: scroller?.clientHeight ?? 0 };
        });
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
        await surface.getByRole('tab', { name: 'ホットキー', exact: true }).click();
        const row = surface.locator('fieldset').filter({ has: page.getByRole('button', { name: '緊急ミュート（切替）のキーを入力', exact: true }) });
        const [nameBox, keyBox, enterBox, pageBox] = await Promise.all([
            row.locator('span').first().boundingBox(),
            row.locator('[data-shortcut-binding]').boundingBox(),
            row.getByRole('button', { name: '緊急ミュート（切替）のキーを入力', exact: true }).boundingBox(),
            surface.boundingBox(),
        ]);
        const hotkey = {
            nameY: nameBox?.y, keyY: keyBox?.y, enterY: enterBox?.y,
            trioWidth: nameBox && enterBox ? Math.round(enterBox.x + enterBox.width - nameBox.x) : null,
            pageWidth: pageBox ? Math.round(pageBox.width) : null,
        };
        const mid = (box?: { y: number; height: number } | null) => (box ? box.y + box.height / 2 : 0);
        expect(Math.abs(mid(nameBox) - mid(keyBox))).toBeLessThanOrEqual(4);
        expect(Math.abs(mid(keyBox) - mid(enterBox))).toBeLessThanOrEqual(4);
        writeFileSync(`${dir}/measures.json`, JSON.stringify({ counts, peak, hotkey }, null, 2));
    });
});

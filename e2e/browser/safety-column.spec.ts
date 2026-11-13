import { mkdirSync } from 'node:fs';
import { test, expect } from './tauriFixture';
import type { Page } from '@playwright/test';

mkdirSync('docs/verification/design-renewal-stage-a', { recursive: true });

const columnName = '本番中の操作';

const configuredStorage = () => {
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('auralyn_vst_panel_open', 'false');
    localStorage.setItem('vst_host_setup_goal', 'obs');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
};

async function ready(page: Page) {
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toBeVisible();
}

function column(page: Page) {
    return page.getByRole('complementary', { name: columnName });
}

/** 操作の矩形が列の中に収まり、列自体が縦にスクロールしていないこと。 */
async function expectColumnFits(page: Page, width: number, height: number, landmark: string, controls: { role: 'button' | 'slider' | 'switch'; name: string }[]) {
    await page.setViewportSize({ width, height });
    const aside = page.getByRole('complementary', { name: landmark });
    await expect(aside).toBeVisible();
    await expect(page.locator('footer')).toHaveCount(0);
    const box = (await aside.boundingBox())!;
    expect(Math.round(box.width)).toBe(212);
    expect(Math.round(box.x + box.width)).toBe(width);
    expect(Math.round(box.y + box.height)).toBe(height);
    expect(await aside.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    expect(await aside.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

    const locators = controls.map(control => aside.getByRole(control.role, { name: control.name, exact: true }));
    const rects = [];
    for (const control of locators) {
        await expect(control).toBeInViewport({ ratio: 1 });
        const fit = await control.evaluate(element => {
            const columnBox = element.closest('aside')!.getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            return {
                top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
                inside: rect.top >= columnBox.top - 1 && rect.bottom <= columnBox.bottom + 1
                    && rect.left >= columnBox.left - 1 && rect.right <= columnBox.right + 1,
                // スライダーのつまみは 24px の操作領域を疑似要素で持つ。文字の切れはボタン側で見る。
                clipped: element.getAttribute('role') !== 'slider'
                    && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1),
            };
        });
        expect(fit.inside).toBe(true);
        expect(fit.clipped).toBe(false);
        rects.push(fit);
    }
    for (let index = 1; index < rects.length; index += 1) {
        expect(rects[index].top).toBeGreaterThan(rects[index - 1].bottom - 1);
    }
    const details = rects[rects.length - 1];
    expect(box.y + box.height - details.bottom).toBeLessThanOrEqual(20);
}

test.describe('右の本番中の操作', () => {
    test.use({ liveHome: true, registeredModes: true });

    test('最小から広い窓まで、右の列の操作が切れずに見える', async ({ page }) => {
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        const names = [
            { role: 'button' as const, name: '緊急ミュート' },
            { role: 'slider' as const, name: '出力音量' },
            { role: 'switch' as const, name: 'VSTを外して比較' },
            { role: 'button' as const, name: '音声処理の詳細' },
        ];
        for (const size of [{ width: 960, height: 640 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }]) {
            await expectColumnFits(page, size.width, size.height, columnName, names);
            // 音調整の3枚は開閉せず、最小窓でも横に並ぶ。
            const tops = await page.locator('.sound-module-item').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
            expect(tops.length).toBeGreaterThanOrEqual(2);
            // 配信・通話の最小サイズでも、音調整は横に並んだままにする。
            expect(Math.abs(tops[1] - tops[0])).toBeLessThanOrEqual(8);
        }
        await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toHaveCount(1);
        await expect(page.getByRole('slider', { name: '出力音量', exact: true })).toHaveCount(1);
        await expect(page.getByRole('switch', { name: 'VSTを外して比較', exact: true })).toHaveCount(1);
        await expect(page.locator('header')).toHaveCount(0);
    });

    test('音楽鑑賞の最小 900×600 でも右の列の操作が見える', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'listening');
            localStorage.setItem('auralyn_display_purpose', 'music');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await ready(page);
        await expectColumnFits(page, 900, 600, columnName, [
            { role: 'button', name: '緊急ミュート' },
            { role: 'slider', name: '出力音量' },
            { role: 'switch', name: 'VSTを外して比較' },
            { role: 'button', name: '音声処理の詳細' },
        ]);
    });

    test('英語でも右の列の操作が列の中に収まる', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_locale', 'en');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Emergency mute', exact: true })).toBeVisible();
        await expectColumnFits(page, 960, 640, 'Live controls', [
            { role: 'button', name: 'Emergency mute' },
            { role: 'slider', name: 'Output volume' },
            { role: 'switch', name: 'Compare without VST' },
            { role: 'button', name: 'Audio processing details' },
        ]);
    });

    test('右パネルを重ねても右の列の3操作が押せる', async ({ page }) => {
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        for (const size of [{ width: 960, height: 640 }, { width: 1024, height: 768 }]) {
            await page.setViewportSize(size);
            await page.locator('#vst-panel-toggle').click();
            await expect(page.locator('#vst-panel')).toHaveAttribute('data-state', 'open');
            await expect(page.locator('main')).toHaveAttribute('inert', '');
            const aside = column(page);
            await expect(aside).not.toHaveAttribute('inert', '');
            const controls = [
                aside.getByRole('button', { name: '緊急ミュート', exact: true }),
                aside.getByRole('slider', { name: '出力音量', exact: true }),
                aside.getByRole('switch', { name: 'VSTを外して比較', exact: true }),
            ];
            for (const control of controls) {
                await control.click({ trial: true });
                const hit = await control.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return {
                        inColumn: Boolean(target?.closest('aside[aria-label="本番中の操作"]')),
                        covered: Boolean(target?.closest('.vst-panel-scrim')),
                    };
                });
                expect(hit).toEqual({ inColumn: true, covered: false });
            }
            await page.keyboard.press('Escape');
            await expect(page.locator('#vst-panel')).toHaveCount(0);
        }
    });

    test('Tab はレール、上の帯、中央、右の列の順に進む', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const regions: string[] = [];
        for (let step = 0; step < 160 && !regions.includes('column'); step += 1) {
            await page.keyboard.press('Tab');
            const region = await page.evaluate(() => {
                const current = document.activeElement as HTMLElement | null;
                if (!current || current === document.body) return '';
                if (current.closest('nav[aria-label="行き先"]')) return 'rail';
                if (current.closest('[data-status-band]')) return 'band';
                if (current.closest('aside[aria-label="本番中の操作"]')) return 'column';
                if (current.closest('main')) return 'main';
                return 'other';
            });
            if (region && regions[regions.length - 1] !== region) regions.push(region);
        }
        const rail = regions.indexOf('rail');
        const band = regions.indexOf('band');
        const main = regions.indexOf('main');
        const safety = regions.indexOf('column');
        expect(rail).toBe(0);
        expect(main).toBeGreaterThan(rail);
        expect(safety).toBeGreaterThan(main);
        // 帯に押せる操作があるときだけ、レールと中央のあいだに入る。
        if (band >= 0) {
            expect(band).toBeGreaterThan(rail);
            expect(main).toBeGreaterThan(band);
        }
    });
});

const shots: Record<string, Array<{ theme: 'dark' | 'light' | 'gaming'; width: number; height: number; panel?: boolean }>> = {
    live: [
        { theme: 'dark', width: 1024, height: 768 },
        { theme: 'light', width: 960, height: 640 },
        { theme: 'gaming', width: 900, height: 600 },
        { theme: 'dark', width: 1920, height: 1080 },
        { theme: 'dark', width: 1024, height: 768, panel: true },
    ],
    stopped: [
        { theme: 'light', width: 1024, height: 768 },
        { theme: 'gaming', width: 960, height: 640 },
        { theme: 'dark', width: 1920, height: 1080 },
        { theme: 'light', width: 900, height: 600 },
    ],
    first: [
        { theme: 'gaming', width: 1024, height: 768 },
        { theme: 'dark', width: 960, height: 640 },
        { theme: 'light', width: 900, height: 600 },
        { theme: 'light', width: 1920, height: 1080 },
    ],
};

// 画面の記録は docs/verification を書き換えるため、RENEWAL_SHOTS=1 を付けたときだけ撮る。通常の試験と CI では撮らない。
const recordShots = process.env.RENEWAL_SHOTS === '1';
const skipReason = '画面の記録は RENEWAL_SHOTS=1 のときだけ撮る';
async function shoot(page: Page, state: string, theme: string, width: number, height: number, panel = false) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(({ theme, configured }) => {
        localStorage.setItem('vst_host_theme', theme);
        if (configured) {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'obs');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        }
    }, { theme, configured: state !== 'first' });
    await page.goto('/');
    if (state === 'first') await expect(page.getByRole('dialog', { name: 'セットアップ' })).toBeVisible();
    else await ready(page);
    if (panel) {
        await page.locator('#vst-panel-toggle').click();
        await expect(page.locator('#vst-panel')).toBeVisible();
    }
    const suffix = panel ? '-panel' : '';
    await page.screenshot({ path: `docs/verification/design-renewal-stage-a/${state}-${theme}-${width}x${height}${suffix}.png` });
}

test.describe('段階 A の画面記録（稼働中）', () => {
    test.skip(!recordShots, skipReason);
    test.use({ liveHome: true, registeredModes: true });
    for (const shot of shots.live) {
        test(`${shot.theme} ${shot.width}×${shot.height}${shot.panel ? ' パネル' : ''}`, async ({ page }) => {
            await shoot(page, 'live', shot.theme, shot.width, shot.height, shot.panel);
        });
    }
});

test.describe('段階 A の画面記録（停止）', () => {
    test.skip(!recordShots, skipReason);
    test.use({ liveHome: true, stoppedHome: true, registeredModes: true });
    for (const shot of shots.stopped) {
        test(`${shot.theme} ${shot.width}×${shot.height}`, async ({ page }) => {
            await shoot(page, 'stopped', shot.theme, shot.width, shot.height);
        });
    }
});

test.describe('段階 A の画面記録（初回）', () => {
    test.skip(!recordShots, skipReason);
    test.use({ liveHome: false, stoppedHome: false, registeredModes: false });
    for (const shot of shots.first) {
        test(`${shot.theme} ${shot.width}×${shot.height}`, async ({ page }) => {
            await shoot(page, 'first', shot.theme, shot.width, shot.height);
        });
    }
});

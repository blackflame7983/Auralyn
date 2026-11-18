import { mkdirSync } from 'node:fs';
import { test, expect } from './tauriFixture';
import type { Locator, Page } from '@playwright/test';
import { uiScale } from '../../src/lib/largeWindow';
import { installOneVstRack } from './oneVstRack';
import { installLockedVstRack } from './lockedVstRack';

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
    expect(Math.round(box.width)).toBe(Math.round(212 * uiScale(width, height)));
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
            { role: 'button' as const, name: '操作をロック' },
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
        // 音楽鑑賞でも比較は右の列に常に出す（#653）。
        await expect(column(page).getByRole('switch', { name: 'VSTを外して比較', exact: true })).toBeVisible();
        await expect(page.getByRole('switch', { name: 'VSTを外して比較', exact: true })).toHaveCount(1);
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
            { role: 'switch', name: 'Bypass VST' },
            { role: 'button', name: 'Lock controls' },
            { role: 'button', name: 'Audio processing details' },
        ]);
    });

    test('英語 1024×768 の右の列で、聴き比べのスイッチが1行に収まる', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_locale', 'en');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto('/');
        const toggle = page.getByRole('complementary', { name: 'Live controls' }).getByRole('switch', { name: 'Bypass VST', exact: true });
        await expect(toggle).toBeVisible();
        const lines = await toggle.evaluate(element => {
            // 親の span は同じ文字を含むので、文字ノードを直接持つ span を測る。
            const label = [...element.querySelectorAll('span')].find(node => node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE && node.textContent === 'Bypass VST');
            const text = label?.firstChild;
            if (!text || text.nodeType !== Node.TEXT_NODE) return -1;
            const value = text.textContent ?? '';
            const range = document.createRange();
            const tops = new Set<number>();
            for (let index = 0; index < value.length; index += 1) {
                range.setStart(text, index);
                range.setEnd(text, index + 1);
                tops.add(Math.round(range.getBoundingClientRect().top));
            }
            return tops.size;
        });
        expect(lines).toBe(1);
    });

    test('VSTが1つも無いあいだは、比較が無効で理由が付く', async ({ page }) => {
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        const compare = column(page).getByRole('switch', { name: 'VSTを外して比較', exact: true });
        await expect(compare).toBeDisabled();
        await expect(compare).toHaveAttribute('title', 'VSTを追加すると比べられます');
        await expect(compare).toHaveAccessibleDescription('VSTを追加すると比べられます');
        await expect(compare).toBeInViewport({ ratio: 1 });
        await expect(column(page).getByText('VSTを追加すると比べられます', { exact: true })).toBeInViewport({ ratio: 1 });
    });

    for (const purpose of ['voice', 'music'] as const) {
        test(`VSTが無い理由の行があっても、900×600 の右の列の操作が切れない（日本語・${purpose}）`, async ({ page }) => {
            await page.addInitScript(p => {
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', p === 'music' ? 'listening' : 'obs');
                localStorage.setItem('auralyn_display_purpose', p);
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, purpose);
            await page.goto('/');
            await ready(page);
            await expect(column(page).getByText('VSTを追加すると比べられます', { exact: true })).toBeVisible();
            await expectColumnFits(page, 900, 600, columnName, [
                { role: 'button', name: '緊急ミュート' },
                { role: 'slider', name: '出力音量' },
                { role: 'switch', name: 'VSTを外して比較' },
                ...(purpose === 'voice' ? [{ role: 'button' as const, name: '操作をロック' }] : []),
                { role: 'button', name: '音声処理の詳細' },
            ]);
        });
    }

    test('オンのVSTが1つでもあれば、比較は押せる', async ({ page }) => {
        await page.addInitScript(installOneVstRack);
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        const compare = column(page).getByRole('switch', { name: 'VSTを外して比較', exact: true });
        await expect(compare).toBeEnabled();
        await expect(compare).not.toHaveAttribute('title', /.+/);
    });

    test('英語でも、VSTが無いあいだは比較が無効で理由が付く', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_locale', 'en');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Emergency mute', exact: true })).toBeVisible();
        const compare = page.getByRole('complementary', { name: 'Live controls' }).getByRole('switch', { name: 'Bypass VST', exact: true });
        await expect(compare).toBeDisabled();
        await expect(compare).toHaveAccessibleDescription('Add a VST to compare.');
        await expect(page.getByRole('complementary', { name: 'Live controls' }).getByText('Add a VST to compare.', { exact: true })).toBeVisible();
    });

    for (const purpose of ['voice', 'music'] as const) {
        test(`Add a VST to compare. の行があっても、900×600 の右の列の操作が切れない（英語・${purpose}）`, async ({ page }) => {
            await page.addInitScript(p => {
                localStorage.setItem('vst_host_locale', 'en');
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', p === 'music' ? 'listening' : 'obs');
                localStorage.setItem('auralyn_display_purpose', p);
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, purpose);
            await page.goto('/');
            await expect(page.getByRole('button', { name: 'Emergency mute', exact: true })).toBeVisible();
            await expect(page.getByRole('complementary', { name: 'Live controls' }).getByText('Add a VST to compare.', { exact: true })).toBeVisible();
            await expectColumnFits(page, 900, 600, 'Live controls', [
                { role: 'button', name: 'Emergency mute' },
                { role: 'slider', name: 'Output volume' },
                { role: 'switch', name: 'Bypass VST' },
                ...(purpose === 'voice' ? [{ role: 'button' as const, name: 'Lock controls' }] : []),
                { role: 'button', name: 'Audio processing details' },
            ]);
        });
    }

    test('VSTのページを開いても右の列の3操作が押せる', async ({ page }) => {
        await page.addInitScript(installOneVstRack);
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        for (const size of [{ width: 960, height: 640 }, { width: 1024, height: 768 }]) {
            await page.setViewportSize(size);
            await page.locator('#home-vst-open').click();
            await expect(page.locator('[data-vst-page]')).toBeVisible();
            await expect(page.locator('main')).not.toHaveAttribute('inert', '');
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
                        covered: Boolean(target?.closest('.vst-panel-scrim, [data-vst-page]')),
                    };
                });
                expect(hit).toEqual({ inColumn: true, covered: false });
            }
            await page.keyboard.press('Escape');
            await expect(page.locator('[data-vst-page]')).toBeVisible();
            await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
            await expect(page.locator('[data-vst-page]')).toHaveCount(0);
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

test.describe('歌・雑談を登録していない右の列（#764）', () => {
    test.use({ liveHome: true, registeredModes: false });

    for (const locale of ['ja', 'en'] as const) {
        const labels = locale === 'ja'
            ? { landmark: columnName, mute: '緊急ミュート', volume: '出力音量', compare: 'VSTを外して比較', lock: '操作をロック', details: '音声処理の詳細' }
            : { landmark: 'Live controls', mute: 'Emergency mute', volume: 'Output volume', compare: 'Bypass VST', lock: 'Lock controls', details: 'Audio processing details' };
        const controls = [
            { role: 'button' as const, name: labels.mute },
            { role: 'slider' as const, name: labels.volume },
            { role: 'switch' as const, name: labels.compare },
        ];
        for (const size of [{ width: 900, height: 600 }, { width: 1024, height: 768 }]) {
            test(`配信は未登録でも操作ロックを出し、${size.width}×${size.height} の右の列が切れない（${locale}）`, async ({ page }) => {
                await page.addInitScript(l => {
                    localStorage.setItem('vst_host_locale', l);
                    localStorage.setItem('vst_host_wizard_done', 'true');
                    localStorage.setItem('auralyn_vst_panel_open', 'false');
                    localStorage.setItem('vst_host_setup_goal', 'obs');
                    localStorage.setItem('auralyn_display_purpose', 'voice');
                    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
                }, locale);
                await page.goto('/');
                await expect(page.getByRole('button', { name: labels.mute, exact: true })).toBeVisible();
                const lock = page.getByRole('complementary', { name: labels.landmark }).getByRole('button', { name: labels.lock, exact: true });
                await expect(lock).toBeVisible();
                await expect(lock).toHaveAttribute('aria-pressed', 'false');
                await expectColumnFits(page, size.width, size.height, labels.landmark, [...controls, { role: 'button', name: labels.lock }, { role: 'button', name: labels.details }]);
            });
        }
    }

    test('音楽鑑賞は未登録で解除中なら操作ロックを出さず、右の列の操作は切れない', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'listening');
            localStorage.setItem('auralyn_display_purpose', 'music');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await ready(page);
        await expect(column(page).getByRole('switch', { name: 'VSTを外して比較', exact: true })).toBeVisible();
        await expect(column(page).getByRole('button', { name: '操作をロック', exact: true })).toHaveCount(0);
        await expectColumnFits(page, 900, 600, columnName, [
            { role: 'button', name: '緊急ミュート' },
            { role: 'slider', name: '出力音量' },
            { role: 'switch', name: 'VSTを外して比較' },
            { role: 'button', name: '音声処理の詳細' },
        ]);
    });
});

const appInput = { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Game', rawEndpointId: 'endpoint-1', purpose: 'voice' } };
const backendLockReason = '本番保護中はデバイス変更・スキャン・ラック／プロファイル置換はできません。停止・ミュートは利用できます。変更する場合は本番保護を解除してください';

test.describe('アプリの音声を入力にしているときの操作ロック（#764）', () => {
    test.use({ liveHome: true, registeredModes: false });

    for (const locale of ['ja', 'en'] as const) {
        const labels = locale === 'ja'
            ? { landmark: columnName, mute: '緊急ミュート', volume: '出力音量', compare: 'VSTを外して比較', lock: '操作をロック', details: '音声処理の詳細', reason: 'アプリの音声の入力では、操作をロックできません' }
            : { landmark: 'Live controls', mute: 'Emergency mute', volume: 'Output volume', compare: 'Bypass VST', lock: 'Lock controls', details: 'Audio processing details', reason: 'Controls can\'t be locked while the input is an app\'s audio.' };
        test(`保存した設定がアプリの音声なら、鍵を無効にして理由を伝え、900×600 の右の列が切れない（${locale}）`, async ({ page }) => {
            await page.addInitScript(({ l, source }) => {
                localStorage.setItem('vst_host_locale', l);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', 'obs');
                localStorage.setItem('auralyn_display_purpose', 'voice');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', output: 'スピーカー', outputId: 'headphones', inputSource: source, sampleRate: 48000, bufferSize: 512 }));
            }, { l: locale, source: appInput });
            await page.goto('/');
            await expect(page.getByRole('button', { name: labels.mute, exact: true })).toBeVisible();
            const lock = page.getByRole('complementary', { name: labels.landmark }).getByRole('button', { name: labels.lock, exact: true });
            await expect(lock).toBeDisabled();
            await expect(lock).toHaveAttribute('title', labels.reason);
            await expect(lock).toHaveAccessibleDescription(new RegExp(labels.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            await expectColumnFits(page, 900, 600, labels.landmark, [
                { role: 'button', name: labels.mute }, { role: 'slider', name: labels.volume }, { role: 'switch', name: labels.compare },
                { role: 'button', name: labels.lock }, { role: 'button', name: labels.details },
            ]);
        });
    }

    test('標準の機器入力なら、鍵は押せて、ツールチップが保護の範囲を伝える', async ({ page }) => {
        await page.addInitScript(configuredStorage);
        await page.goto('/');
        await ready(page);
        const lock = column(page).getByRole('button', { name: '操作をロック', exact: true });
        await expect(lock).toBeEnabled();
        await expect(lock).toHaveAttribute('title', /ロック中は機器変更やVSTラック・構成の置換はできません/);
    });
});

test.describe('操作ロック中の VST の削除と並べ替え（#764）', () => {
    test.use({ liveHome: true, registeredModes: false });

    for (const locale of ['ja', 'en'] as const) {
        const labels = locale === 'ja'
            ? { remove: 'E2E VST Aを削除', confirm: '削除する', title: 'プラグインの削除に失敗しました', body: '操作をロックしている間は、VST の追加・削除・並べ替え・構成の置き換えはできません。右の列の「操作をロック」を押すと解除できます。', lock: '操作をロック', landmark: columnName }
            : { remove: 'Remove E2E VST A', confirm: 'Remove', title: 'Could not remove the plugin', body: 'While controls are locked, you can\'t add, remove or reorder VSTs or replace the setup. Press “Lock controls” in the right column to unlock.', lock: 'Lock controls', landmark: 'Live controls' };
        test(`ロック中に VST を削除しようとすると、アプリの文で理由と解除のしかたを見せ、バックエンドの原文は出さず、ラックは変わらない（${locale}）`, async ({ page }) => {
            await page.addInitScript(installLockedVstRack, { reason: backendLockReason });
            await page.addInitScript(({ l }) => {
                localStorage.setItem('vst_host_locale', l);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', 'obs');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
            }, { l: locale });
            await page.setViewportSize({ width: 900, height: 600 });
            await page.goto('/');
            await expect(page.getByRole('button', { name: locale === 'ja' ? '緊急ミュート' : 'Emergency mute', exact: true })).toBeVisible();
            await expect(page.getByRole('complementary', { name: labels.landmark }).getByRole('button', { name: labels.lock, exact: true })).toHaveAttribute('aria-pressed', 'true');
            await page.locator('#home-vst-open').click();
            await expect(page.locator('[data-vst-page]')).toBeVisible();
            const cards = page.locator('[data-vst-page]');
            await expect(cards.getByText('E2E VST A', { exact: true }).first()).toBeVisible();
            await expect(cards.getByText('E2E VST B', { exact: true }).first()).toBeVisible();
            await cards.getByRole('button', { name: labels.remove, exact: true }).click();
            await page.getByRole('button', { name: labels.confirm, exact: true }).click();
            const notice = page.locator('[data-sonner-toast]');
            await expect(notice.getByText(labels.title, { exact: true })).toBeVisible();
            await expect(notice).toContainText(labels.body);
            await expect(notice).not.toContainText(backendLockReason);
            await expect(notice).not.toContainText(/未翻訳|untranslated/i);
            await expect(cards.getByText('E2E VST A', { exact: true }).first()).toBeVisible();
            await expect(cards.getByText('E2E VST B', { exact: true }).first()).toBeVisible();
            expect(await page.evaluate((): unknown => Reflect.get(window, '__e2eRefusedWhileLocked'))).toEqual(['remove_plugin']);
        });
    }
});

/** 通知の層は画面の下に敷かれ、モーダルの裏に隠れる。理由はダイアログの中に、最前面で見えること。 */
async function expectFrontmost(target: Locator) {
    await expect(target).toBeVisible();
    await expect.poll(() => target.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return top !== null && element.contains(top);
    })).toBe(true);
}

test.describe('操作ロック中に、ダイアログの中から VST を追加・適用したとき（#764）', () => {
    test.use({ liveHome: true, registeredModes: false });

    for (const locale of ['ja', 'en'] as const) {
        const labels = locale === 'ja'
            ? { mute: '緊急ミュート', add: 'VSTを追加', addNamed: 'E2E Compressor を追加', templates: 'VST構成テンプレート', use: 'この構成を使う', apply: 'VST構成を置き換える',
                body: '操作をロックしている間は、VST の追加・削除・並べ替え・構成の置き換えはできません。右の列の「操作をロック」を押すと解除できます。' }
            : { mute: 'Emergency mute', add: 'Add VST', addNamed: 'Add E2E Compressor', templates: 'VST setup templates', use: 'Use this setup', apply: 'Replace the VST setup',
                body: 'While controls are locked, you can\'t add, remove or reorder VSTs or replace the setup. Press “Lock controls” in the right column to unlock.' };

        const open = async (page: Page, rack: { empty?: boolean }) => {
            await page.addInitScript(installLockedVstRack, { reason: backendLockReason, catalog: true, ...rack });
            await page.addInitScript(({ l }) => {
                localStorage.setItem('vst_host_locale', l);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', 'obs');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
            }, { l: locale });
            await page.setViewportSize({ width: 900, height: 600 });
            await page.goto('/');
            await expect(page.getByRole('button', { name: labels.mute, exact: true })).toBeVisible();
            await page.locator('#home-vst-open').click();
            await expect(page.locator('[data-vst-page]')).toBeVisible();
        };

        test(`ロック中に「${labels.add}」から追加すると、理由は開いたまま追加の画面の中に見え、通知を二重に出さない（${locale}）`, async ({ page }) => {
            await open(page, {});
            await page.locator('[data-vst-page]').getByRole('button', { name: labels.add, exact: true }).first().click();
            const dialog = page.getByRole('dialog', { name: labels.add });
            await dialog.getByRole('button', { name: labels.addNamed, exact: true }).click();
            const reason = dialog.getByText(labels.body, { exact: true });
            await expectFrontmost(reason);
            await expect(dialog).toBeVisible();
            await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
            await expect(dialog).not.toContainText(backendLockReason);
            if (locale === 'ja') await expect(reason).toHaveCSS('word-break', 'auto-phrase');
            expect(await page.evaluate((): unknown => Reflect.get(window, '__e2eRefusedWhileLocked'))).toEqual(['load_plugin']);
        });

        test(`ロック中にテンプレートを適用すると、理由は開いたままテンプレートの画面の中に見え、通知を二重に出さない（${locale}）`, async ({ page }) => {
            await open(page, { empty: true });
            await page.locator('[data-vst-page]').getByRole('button', { name: labels.templates, exact: true }).click();
            const dialog = page.getByRole('dialog');
            await dialog.getByRole('button', { name: labels.use, exact: true }).first().click();
            const slots = dialog.getByRole('combobox');
            await slots.nth(1).selectOption({ label: 'E2E Compressor' });
            await slots.nth(2).selectOption({ label: 'E2E Limiter' });
            await dialog.getByRole('button', { name: labels.apply, exact: true }).click();
            const reason = dialog.getByText(labels.body, { exact: true });
            await expectFrontmost(reason);
            await expect(dialog).toBeVisible();
            await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
            await expect(dialog).not.toContainText(backendLockReason);
            await expect(dialog.getByRole('button', { name: labels.apply, exact: true })).toBeEnabled();
            if (locale === 'ja') await expect(reason).toHaveCSS('word-break', 'auto-phrase');
            expect(await page.evaluate((): unknown => Reflect.get(window, '__e2eRefusedWhileLocked'))).toEqual(['load_plugin']);
        });
    }
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
        await page.locator('#home-vst-open').click();
        await expect(page.locator('[data-vst-page]')).toBeVisible();
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

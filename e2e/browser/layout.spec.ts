import type { Locator, Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

test.describe('通常のホーム表示', () => {
    test.use({ liveHome: true, registeredModes: false });
    for (const source of ['本番帯', '大型メーター併用']) {
    test(`${source}のマイク音量を開いて横並びから重ね表示へ縮めると、閉じてVST操作へ移る`, async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 768 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.locator('#vst-panel')).toBeVisible();
        if (source === '大型メーター併用') {
            await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
            await page.locator('.large-meter-motion').getByRole('button', { name: '詳細表示', exact: true }).click();
        }
        const region = page.getByRole('region', { name: '本番', exact: true });
        await region.getByRole('button', { name: 'マイク音量 100%', exact: true }).click();
        const popup = page.getByRole('dialog', { name: 'マイク音量', exact: true });
        await expect(popup.getByRole('slider')).toBeFocused();
        await page.setViewportSize({ width: 960, height: 640 });
        await expect(page.locator('main')).toHaveAttribute('inert', '');
        await expect(popup).not.toBeVisible();
        await expect(page.locator('#plugin-rack-heading')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#vst-panel')).toHaveCount(0);
        await expect(page.locator('#vst-panel-toggle')).toBeFocused();
        expect(await page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([]);
    });
    }
    test('広い画面は入出力を並べ、狭い画面は出力の操作をフッターに保つ', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        for (const width of [960, 1280, 1920, 2560]) {
            await page.setViewportSize({ width, height: 768 });
            const summary = page.locator('.live-output-summary');
            if (width === 960) await expect(summary).toBeHidden();
            else {
                await expect(summary).toBeVisible();
                const input = (await page.getByRole('meter', { name: 'マイクの入力レベル', exact: true }).boundingBox())!;
                const output = (await summary.getByRole('meter').boundingBox())!;
                expect(output.y).toBe(input.y);
                expect(input.width).toBeGreaterThan(120);
                expect(output.width).toBeGreaterThan(120);
                const trigger = summary.getByRole('button', { name: '出力音量', exact: true });
                await trigger.click();
                const popover = page.getByRole('dialog', { name: '出力音量', exact: true });
                await expect(popover).toBeVisible();
                await expect(popover.getByRole('slider')).toBeFocused();
                if (width === 1280) await page.screenshot({ path: testInfo.outputPath('inline-output-volume.png') });
                await page.keyboard.press('Escape');
                await expect(popover).not.toBeVisible();
                await expect(trigger).toBeFocused();
            }
        }
    });
    test('出力の小窓とフッターは同じ音量を使い、縮小すると閉じて操作を戻す', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 768 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        const trigger = page.locator('.live-output-summary').getByRole('button', { name: '出力音量', exact: true });
        await trigger.click();
        const popup = page.getByRole('dialog', { name: '出力音量', exact: true });
        const slider = popup.getByRole('slider');
        await expect(slider).toHaveAttribute('aria-valuenow', '100');
        expect(await page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([]);
        await trigger.click();
        await expect(popup).not.toBeVisible();
        await trigger.click();
        const inputTrigger = page.getByRole('button', { name: 'マイク音量 100%', exact: true });
        await inputTrigger.click();
        const inputPopup = page.getByRole('dialog', { name: 'マイク音量', exact: true });
        await expect(popup).not.toBeVisible();
        await expect(inputPopup.getByRole('slider')).toBeFocused();
        await page.keyboard.press('Escape');
        await trigger.click();
        await expect(slider).toBeFocused();
        await slider.press('Home');
        await expect.poll(() => page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([0]);
        const footerSlider = page.locator('footer').getByRole('slider', { name: '出力音量', exact: true });
        await expect(footerSlider).toHaveAttribute('aria-valuenow', '0');
        await page.evaluate(() => (window as any).__e2eSetOutputGain(0.5));
        await expect(slider).toHaveAttribute('aria-valuenow', '50');
        await expect(footerSlider).toHaveAttribute('aria-valuenow', '50');
        await page.setViewportSize({ width: 960, height: 640 });
        await expect(popup).not.toBeVisible();
        await expect(footerSlider).toBeFocused();
        expect(await page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([0]);
        // 境界幅でVSTを横に開き、入口が隠れてもパネルへ移ったフォーカスを奪わない。
        await page.setViewportSize({ width: 1536, height: 768 });
        await trigger.click();
        await expect(popup).toBeVisible();
        await page.locator('#vst-panel-toggle').click();
        await expect(popup).not.toBeVisible();
        await expect(page.locator('#plugin-rack-heading')).toBeFocused();
        await expect(footerSlider).toBeEnabled();
    });
    test('復元警告なしで、ミュート表示による折返しと高さの変化がない', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_theme', 'gaming');
            localStorage.setItem('vst_host_setup_goal', 'listening');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByRole('region', { name: 'VST保存済み構成の保護' })).toHaveCount(0);
        await expect(page.locator('header').getByText('音声処理中', { exact: true })).toHaveCount(0);
        const routing = page.locator('[data-live-routing]');
        // 長い機器名は実寸で検査し、IPC側の保存値や音声処理には触れない。
        await routing.locator('button').first().locator('span').evaluate(element => { element.textContent = 'Voicemeeter Insert Virtual ASIO'; });
        for (const width of [960, 1024]) {
            await page.setViewportSize({ width, height: 640 });
            const samples = [];
            for (const muted of [false, true, false]) {
                await page.evaluate(muted => (window as any).__e2eSetOutputMuted(muted), muted);
                const badge = routing.getByRole('status', { includeHidden: true });
                if (muted) await expect(badge).toBeVisible(); else await expect(badge).toBeHidden();
                samples.push({ row: await routing.boundingBox(), button: await routing.getByRole('button', { name: 'モードを登録', exact: true }).boundingBox() });
            }
            expect(samples[1]).toEqual(samples[0]); expect(samples[2]).toEqual(samples[0]);
            expect(samples[0].row!.height).toBeLessThan(36);
            await page.evaluate(() => (window as any).__e2eSetOutputMuted(true));
            const recovery = routing.getByRole('button', { name: '出力ミュート・音量ゼロ', exact: true });
            await expect(recovery).toBeInViewport();
            await recovery.click();
            await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toBeFocused();
            // 復旧操作へ案内するだけで、ミュートを勝手に解除しない。
            await expect(recovery).toBeVisible();
            const footer = page.locator('footer');
            const box = (await footer.boundingBox())!;
            expect(box.y + box.height).toBe(640);
            expect(box.height).toBeLessThan(64);
            await page.screenshot({ path: testInfo.outputPath(`normal-home-${width}.png`) });
        }
    });
});

test.describe('操作部品のサイズとテーマ', () => {
    test.use({ liveHome: true, registeredModes: false, builtinEnabled: true });
    test('各テーマの角丸・候補色とエフェクト量の操作幅を保つ', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'listening');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        for (const theme of ['light', 'dark', 'gaming']) {
            await page.goto('/');
            await page.evaluate(theme => {
                document.documentElement.classList.toggle('dark', theme !== 'light');
                document.documentElement.classList.toggle('gaming', theme === 'gaming');
            }, theme);
            const button = page.getByRole('button', { name: '録音して比較', exact: true });
            expect(await button.evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThanOrEqual(8);
            await page.getByRole('button', { name: 'セットアップを開く', exact: true }).click();
            await page.getByRole('button', { name: '自分で聴く', exact: true }).click();
            const select = page.getByRole('combobox', { name: '入力デバイス', exact: true });
            await expect(select).toBeVisible();
            const styles = await select.evaluate(element => {
                const option = element.querySelector('option')!;
                const reference = document.createElement('span');
                reference.style.color = 'hsl(var(--popover-foreground))';
                reference.style.backgroundColor = 'hsl(var(--popover))';
                element.parentElement!.append(reference);
                const expected = getComputedStyle(reference);
                const actual = getComputedStyle(option);
                const result = { scheme: getComputedStyle(element).colorScheme, background: actual.backgroundColor, foreground: actual.color, expectedBackground: expected.backgroundColor, expectedForeground: expected.color };
                reference.remove(); return result;
            });
            expect(styles.scheme).toBe(theme === 'light' ? 'light' : 'dark');
            expect(styles.background).toBe(styles.expectedBackground);
            expect(styles.foreground).toBe(styles.expectedForeground);
            await page.keyboard.press('Escape');
        }
        // ウィザードの中断確認を含む状態を破棄して、ホームの操作幅だけを検査する。
        await page.goto('/');
        // 初期化中も背後にホームは存在するため、描画だけでなく実際に操作できるまで待つ。
        await page.getByRole('button', { name: '録音して比較', exact: true }).click({ trial: true });
        for (const width of [960, 1024, 1440, 1920]) {
            await page.setViewportSize({ width, height: 768 });
            const range = page.getByRole('slider', { name: '内蔵ボイスチェーンのエフェクト量', exact: true });
            const box = (await range.boundingBox())!;
            // 20段階の操作に6px以上/段を確保し、長大なバーにしない。
            expect(box.width).toBeGreaterThanOrEqual(120);
            expect(box.width).toBeLessThanOrEqual(240);
            await expect(range).toHaveAttribute('step', '5');
            await page.screenshot({ path: testInfo.outputPath(`controls-${width}.png`) });
        }
    });
});

async function reachable(locator: Locator, page: Page) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport();
    // 重なり・操作を遮る要素も実ブラウザのhit testで検出する。
    await locator.click({ trial: true });
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

for (const theme of ['light', 'dark', 'gaming']) {
    test(`900×600 ${theme}: 初回画面の操作が見切れず、設定とライセンスを往復できる`, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(theme => localStorage.setItem('vst_host_theme', theme), theme);
        await page.goto('/');
        const skip = page.getByRole('button', { name: 'セットアップをスキップ' });
        await reachable(skip, page);
        await skip.click();
        const setup = page.getByRole('button', { name: 'マイクと出力先を設定する', exact: true });
        await reachable(setup, page);
        await setup.click();
        await page.getByRole('tab', { name: '外観', exact: true }).click();
        await reachable(page.getByRole('combobox', { name: '表示言語' }), page);
        const license = page.getByRole('button', { name: /ライセンス/ });
        await reachable(license, page);
        await license.click();
        const dialog = page.getByRole('dialog', { name: 'ライセンス情報 / OSS Attribution' });
        await expect(dialog).toBeVisible();
        await reachable(dialog.getByRole('button', { name: /閉じる/ }), page);
        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        await expect(license).toBeFocused();
    });
}

test('1024×768・200%ページ拡大: 設定をキーボードで操作し、閉じると入口へ戻る', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.goto('/');
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    const setup = page.getByRole('button', { name: 'マイクと出力先を設定する', exact: true });
    await setup.click();
    const dialog = page.getByRole('dialog').last();
    const tab = dialog.getByRole('tab', { name: '外観', exact: true });
    await reachable(tab, page);
    await tab.click();
    const language = dialog.getByRole('combobox', { name: '表示言語' });
    await reachable(language, page);
    await language.focus();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('combobox', { name: 'Display language' })).toHaveValue('en');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up microphone and output', exact: true })).toBeFocused();
});

// 重ね表示では背後を操作させず、ヘッダーとフッターの本番操作は使える。
test('最小〜最大: VST は作業幅を保って重なり、広い窓ではメーターと並ぶ', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', output: 'Test headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
    const meter = page.locator('.large-meter-motion');
    await expect(meter).toBeVisible();
    expect((await meter.boundingBox())!.width).toBe(64);
    for (const width of [900, 960, 1024, 1280, 1440, 1536, 1920]) {
        await page.setViewportSize({ width, height: 768 });
        const main = page.locator('main');
        await page.locator('#vst-panel-toggle').click();
        await expect(page.locator('#vst-panel')).toHaveAttribute('data-state', 'open');
        const overlays = width < 1200;
        if (overlays) {
            await expect(main).toHaveAttribute('inert', '');
            await expect(meter).toBeHidden();
            await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThanOrEqual(Math.min(width, 1020) - 1);
        } else {
            await expect(main).not.toHaveAttribute('inert', '');
            await expect(meter).toBeVisible();
            // メーターはパネル端ではなく、ホームの右隣へ置く。
            await expect.poll(() => page.evaluate(() => {
                const meterBox = document.querySelector('.large-meter-motion')!.getBoundingClientRect();
                const contentBox = document.querySelector('main > .mx-auto')!.getBoundingClientRect();
                return meterBox.left - contentBox.right;
            })).toBeLessThanOrEqual(24);
        }
        await reachable(page.getByRole('button', { name: '緊急ミュート', exact: true }), page);
        await reachable(page.getByRole('slider', { name: '出力音量', exact: true }), page);
        if (width === 960 || width === 1536) await page.screenshot({ path: testInfo.outputPath(`vst-responsive-${width}.png`) });
        if (overlays) await page.keyboard.press('Escape');
        else await page.getByRole('button', { name: 'VST 構成を閉じる', exact: true }).click();
        await expect(page.locator('#vst-panel')).toHaveCount(0);
        await expect(main).not.toHaveAttribute('inert', '');
        await expect(page.locator('#vst-panel-toggle')).toBeFocused();
        await expect(meter).toBeVisible();
        await reachable(page.getByRole('region', { name: '本番', exact: true }).getByRole('button', { name: '大型レベルメーターを閉じる', exact: true }), page);
    }
});

test('細身・詳細メーターはホームの近くに並び、目盛りが状態表示やバーの外へはみ出さない', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', output: 'Test headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
    const meter = page.locator('.large-meter-motion');
    await expect(meter).toBeVisible();
    for (const width of [960, 1024, 1920, 2560]) {
        await page.setViewportSize({ width, height: width <= 1024 ? 640 : 1080 });
        for (const detailed of [false, true]) {
            if (detailed) await meter.getByRole('button', { name: '詳細表示', exact: true }).click();
            await meter.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))); });
            await expect.poll(() => page.evaluate(() => {
                const content = document.querySelector('main > .mx-auto')!.getBoundingClientRect();
                const meter = document.querySelector('.large-meter-motion')!.getBoundingClientRect();
                return meter.left - content.right;
            })).toBeLessThanOrEqual(24);
            const content = (await page.locator('main > .mx-auto').boundingBox())!;
            const box = (await meter.boundingBox())!;
            expect(box.width).toBe(detailed ? 96 : 64);
            expect(box.x - content.x - content.width).toBeGreaterThanOrEqual(8);
            const track = (await meter.getByRole('meter').boundingBox())!;
            const status = (await meter.getByRole('status').boundingBox())!;
            for (const mark of ['0', '-6', '-12', '-24', '-48']) {
                const tick = (await meter.getByText(mark, { exact: true }).boundingBox())!;
                expect(tick.y).toBeGreaterThanOrEqual(track.y - 1);
                expect(tick.y).toBeGreaterThanOrEqual(status.y + status.height + 4);
                expect(tick.y + tick.height).toBeLessThanOrEqual(track.y + track.height + 1);
            }
            if (width === 960 || width === 2560) await page.screenshot({ path: testInfo.outputPath(`meter-spacing-${width}-${detailed ? 'detail' : 'slim'}.png`) });
            if (detailed) await meter.getByRole('button', { name: 'ミニモード', exact: true }).click();
        }
    }
});

test.describe('登録済みの歌・雑談と右パネル', () => {
    test.use({ liveHome: true });
    for (const theme of ['light', 'dark', 'gaming']) {
        test(`${theme}: 重ね表示の終了で本番モード・メーターへ戻れ、横並びでは同時操作できる`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width: 960, height: 640 });
            await page.addInitScript(theme => {
                localStorage.setItem('vst_host_theme', theme);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('vst_host_tutorial_completed', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_setup_goal', 'listening');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, theme);
            await page.goto('/');
            await page.getByRole('button', { name: 'セットアップを開く', exact: true }).click();
            await page.getByRole('button', { name: 'セットアップを閉じる', exact: true }).click();
            const live = page.getByRole('region', { name: '本番', exact: true });
            const modes = live.getByRole('group', { name: 'モード切替' });
            await expect(modes).toBeVisible();
            await live.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
            await page.locator('#vst-panel-toggle').click();
            await expect(page.locator('main')).toHaveAttribute('inert', '');
            await expect(page.locator('.large-meter-motion')).toBeHidden();
            await page.locator('.vst-panel-scrim').click({ position: { x: 20, y: 20 } });
            await expect(page.locator('#vst-panel')).toHaveCount(0);
            for (const name of ['歌唱モード', '雑談モード']) await reachable(modes.getByRole('button', { name, exact: true }), page);
            await expect(page.locator('.large-meter-motion')).toBeVisible();
            await page.locator('#vst-panel-toggle').click();
            await page.setViewportSize({ width: 1600, height: 900 });
            await expect(page.locator('main')).not.toHaveAttribute('inert', '');
            for (const name of ['歌唱モード', '雑談モード']) await reachable(modes.getByRole('button', { name, exact: true }), page);
            await reachable(live.getByRole('button', { name: /100%/ }), page);
            await page.screenshot({ path: testInfo.outputPath(`registered-modes-${theme}.png`) });
        });
    }
});

// 開閉を連続しても古い終了処理で閉じず、閉じ始めた内容には触れない。
for (const width of [960, 1280, 1600]) {
test(`右パネルの出入り・連続開閉・ホームの幅復帰 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
    });
    await page.goto('/');
    const toggle = page.locator('#vst-panel-toggle');
    await toggle.click();
    const panel = page.locator('#vst-panel');
    await expect(panel).toHaveAttribute('data-state', 'open');
    expect(await panel.evaluate(e => e.getAnimations().some(a => a.playState === 'running'))).toBe(true);
    await page.getByRole('button', { name: 'VST 構成を閉じる', exact: true }).click();
    await expect(panel).toHaveAttribute('inert', '');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await expect(toggle).toBeFocused();
    // スクロール待ちを挟まず、終了途中に同じ実ボタンから再度開く。
    await toggle.evaluate((e: HTMLButtonElement) => e.click());
    await expect(panel).toHaveAttribute('data-state', 'open');
    await expect(panel).not.toHaveAttribute('inert', '');
    await page.waitForTimeout(300);
    await expect(page.getByRole('complementary')).toBeVisible();
    const widths = await panel.evaluate(async e => {
        const main = document.querySelector('main')!;
        const samples = [{ time: 0, width: main.getBoundingClientRect().width }];
        const start = performance.now();
        (e.querySelector('button[aria-label="VST 構成を閉じる"]') as HTMLButtonElement).click();
        await new Promise<void>(resolve => {
            const frame = () => {
                samples.push({ time: performance.now() - start, width: main.getBoundingClientRect().width });
                if (performance.now() - start >= 360) resolve();
                else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        });
        return samples;
    });
    const first = widths[0].width, last = widths[widths.length - 1].width;
    if (width <= 1020) expect(Math.abs(last - first)).toBeLessThan(1);
    else expect(last - first).toBeGreaterThan(200);
    // 途中の幅が存在し、パネルを外す最後の瞬間にも数百pxの飛びがない。
    if (width > 1020) expect(widths.filter(s => s.width > first + 1 && s.width < last - 1).length).toBeGreaterThan(2);
    const late = widths.filter(s => s.time > 200);
    expect(Math.max(...late.slice(1).map((s, i) => Math.abs(s.width - late[i].width)))).toBeLessThan(15);
    await expect(panel).toHaveCount(0);
    await expect(toggle).toBeFocused();
});
}

test('動きを減らす設定では右パネルを移動せず、キーボードでは即座に開閉する', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
    });
    await page.goto('/');
    const toggle = page.locator('#vst-panel-toggle');
    await toggle.click();
    const panel = page.locator('#vst-panel');
    expect(await panel.evaluate(e => getComputedStyle(e).transform)).toBe('none');
    expect(await panel.evaluate(e => e.getAnimations().every(a => !(a instanceof CSSTransition) || a.transitionProperty === 'opacity'))).toBe(true);
    await page.getByRole('button', { name: 'VST 構成を閉じる', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAttribute('data-state', 'open');
    expect(await panel.evaluate(e => e.getAnimations().length)).toBe(0);
    const close = page.getByRole('button', { name: 'VST 構成を閉じる', exact: true });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(toggle).toBeFocused();
});

test.describe('メーター数値の幅', () => {
    test.use({ liveHome: true });
    test('クリップの発生・解除と無音への変化で横・縦メーターの寸法が変わらない', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 960, height: 640 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
        const large = page.locator('.large-meter-motion');
        const input = page.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
        const output = page.getByRole('meter', { name: '出力', exact: true });
        const emit = (value: number) => page.evaluate(value => (window as any).__e2eEmit('audio-level', { input: [value, value], output: [value, value] }), value);
        for (const detailed of [false, true]) {
            if (detailed) await large.getByRole('button', { name: '詳細表示', exact: true }).click();
            await emit(0.1);
            await expect(input).toHaveAttribute('aria-valuenow', '-20');
            const baseline = await Promise.all([input, output.nth(0), output.nth(1)].map(locator => locator.boundingBox()));
            await emit(1.2);
            const resets = page.getByRole('button', { name: /クリップ表示を消す/ });
            await expect(resets).toHaveCount(3);
            for (const [i, locator] of [input, output.nth(0), output.nth(1)].entries()) {
                const clipped = (await locator.boundingBox())!;
                expect(clipped).toEqual(baseline[i]);
            }
            await page.screenshot({ path: testInfo.outputPath(`clip-${detailed ? 'detail' : 'slim'}.png`) });
            // 出力は2か所で共有し、入力の履歴とは独立して解除する。
            await large.getByRole('button', { name: /クリップ表示を消す/ }).click();
            await expect(resets).toHaveCount(1);
            await resets.click();
            await emit(0);
            await expect(large.getByRole('status')).toHaveText('無音');
            for (const [i, locator] of [input, output.nth(0), output.nth(1)].entries()) {
                expect(await locator.boundingBox()).toEqual(baseline[i]);
            }
            // 不正なレベル通知は更新待ちになり、状態欄で縦バーを縮めない。
            await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [], output: [] }));
            await expect(large.getByRole('status')).toHaveText('未受信');
            expect(await large.getByRole('meter').boundingBox()).toEqual(baseline[1]);
        }
    });
    test('数値の桁が変わっても入力メーターのバー幅と隣の操作位置は変わらない', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        const live = page.getByRole('region', { name: '本番', exact: true });
        const bar = live.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
        await expect(bar).toBeVisible();
        const value = bar.locator('..').locator(':scope > span').first();
        const control = live.getByRole('button', { name: /マイク音量/ });
        const samples: { bar: number; value: number; control: number }[] = [];
        // 音声処理には触れず、実UIの値の欄に異なる桁数を入れてレイアウトだけを検査する。
        for (const text of ['-9.9 dBFS', '-10.0 dBFS', '-100.0 dBFS', '−∞ dBFS', '']) {
            await value.evaluate((element, text) => { element.textContent = text; }, text);
            samples.push({ bar: (await bar.boundingBox())!.width, value: (await value.boundingBox())!.width, control: (await control.boundingBox())!.x });
        }
        for (const sample of samples) {
            expect(sample.bar).toBeCloseTo(samples[0].bar, 3);
            expect(sample.value).toBeCloseTo(samples[0].value, 3);
            expect(sample.control).toBeCloseTo(samples[0].control, 3);
        }
    });
});

test('メニューは短く閉じて入口へ戻り、動きを減らす場合は即座に消える', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'ヘルプメニューを開く', exact: true });
    const menu = page.locator('[data-radix-menu-content]');
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        await trigger.click();
        await expect(menu).toHaveAttribute('data-state', 'open');
        const closing = await menu.evaluate(element => {
            // 開くアニメーションの途中でも閉じられる。
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return new Promise<{ state: string | null; pointer: string; animations: string[] }>(resolve => requestAnimationFrame(() => resolve({
                state: element.getAttribute('data-state'), pointer: getComputedStyle(element).pointerEvents,
                animations: element.getAnimations().map(animation => (animation as CSSAnimation).animationName),
            })));
        });
        if (reducedMotion === 'no-preference') {
            expect(closing.state).toBe('closed');
            expect(closing.pointer).toBe('none');
            expect(closing.animations).toContain('surface-disappear');
        } else expect(closing.animations).toHaveLength(0);
        await expect(menu).toHaveCount(0);
        await expect(trigger).toBeFocused();
    }
    // 小さくした詳細アイコンから診断内容へ到達できる。
    const details = page.getByRole('button', { name: '音声処理の詳細', exact: true });
    await details.click();
    await expect(page.getByRole('dialog', { name: '音声処理の詳細', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toBeFocused();
});

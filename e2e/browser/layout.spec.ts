import type { Locator, Page } from '@playwright/test';
import { test, expect } from './tauriFixture';
import { uiScale } from '../../src/lib/largeWindow';
import { settleLayoutMotion } from './layoutMotion';

test.describe('通常のホーム表示', () => {
    test.use({ liveHome: true, registeredModes: false });
    test('右の列のマイク音量はVSTのページでも残り、Escapeではページを閉じない', async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 768 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await page.locator('#home-vst-open').click();
        await expect(page.locator('[data-vst-page]')).toBeVisible();
        const slider = page.getByRole('complementary', { name: '本番中の操作', exact: true }).getByRole('slider', { name: /マイク音量/ });
        await expect(slider).toBeEnabled();
        await page.setViewportSize({ width: 960, height: 640 });
        await expect(page.locator('main')).not.toHaveAttribute('inert', '');
        await expect(slider).toBeEnabled();
        await expect(slider.locator('xpath=ancestor::*[@inert]')).toHaveCount(0);
        await page.getByRole('heading', { name: 'VST', level: 1 }).focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-vst-page]')).toBeVisible();
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
        await expect(page.locator('[data-vst-page]')).toHaveCount(0);
        await expect(page.locator('#home-vst-open')).toBeVisible();
        expect(await page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([]);
        await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    });
    test('狭い画面でも入出力と出力音量を保つ', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        for (const width of [960, 1280, 1920, 2560]) {
            await page.setViewportSize({ width, height: 768 });
            const column = page.getByRole('complementary', { name: '本番中の操作' });
            const input = (await column.getByRole('meter', { name: 'マイクの入力レベル', exact: true }).boundingBox())!;
            const output = (await column.getByRole('meter', { name: '出力', exact: true }).boundingBox())!;
            expect(output.y).toBeGreaterThan(input.y);
            expect(input.width).toBeGreaterThan(40);
            expect(output.width).toBeGreaterThan(40);
            await expect(column.getByRole('button', { name: '出力音量', exact: true })).toHaveCount(0);
            const slider = page.getByRole('complementary', { name: '本番中の操作' }).getByRole('slider', { name: '出力音量', exact: true });
            await expect(page.getByRole('slider', { name: '出力音量', exact: true })).toHaveCount(1);
            await expect(slider).toBeInViewport({ ratio: 1 });
            if (width === 1280) await page.screenshot({ path: testInfo.outputPath('footer-output-volume.png') });
        }
    });
    test('右の列の出力音量は外部更新と縮小後の操作に追従する', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 768 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        const slider = page.getByRole('complementary', { name: '本番中の操作' }).getByRole('slider', { name: '出力音量', exact: true });
        await expect(page.getByRole('slider', { name: '出力音量', exact: true })).toHaveCount(1);
        await expect(slider).toHaveAttribute('aria-valuenow', '100');
        expect(await page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([]);
        await slider.focus();
        await slider.press('Home');
        await expect.poll(() => page.evaluate(() => (window as any).__e2eOutputGainWrites)).toEqual([0]);
        await page.evaluate(() => (window as any).__e2eSetOutputGain(0.5));
        await expect(slider).toHaveAttribute('aria-valuenow', '50');
        await page.setViewportSize({ width: 960, height: 640 });
        await expect(slider).toBeFocused();
        await page.locator('#home-vst-open').click();
        await expect(page.locator('[data-vst-page]')).toBeVisible();
        await expect(page.locator('main')).not.toHaveAttribute('inert', '');
        await slider.focus();
        await slider.press('Home');
        await expect(slider).toHaveAttribute('aria-valuenow', '0');
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
        await expect(page.locator('header')).toHaveCount(0);
        const column = page.getByRole('complementary', { name: '本番中の操作' });
        const routing = column.getByRole('heading', { name: '出力', exact: true }).locator('xpath=..');
        // 長い機器名は1行に収め、IPC側の保存値や音声処理には触れない。
        await column.locator('p.truncate').last().evaluate(element => { element.textContent = 'Voicemeeter Insert Virtual ASIO'; element.setAttribute('title', 'Voicemeeter Insert Virtual ASIO'); });
        for (const width of [960, 1024]) {
            await page.setViewportSize({ width, height: 640 });
            const samples = [];
            for (const muted of [false, true, false]) {
                await page.evaluate(muted => (window as any).__e2eSetOutputMuted(muted), muted);
                const badge = routing.getByRole('status', { includeHidden: true });
                if (muted) await expect(badge).toBeVisible(); else await expect(badge).toBeHidden();
                // 幅の変更で区画が滑って移る間（#298）は測らず、配置が落ち着いてから比べる。
                await settleLayoutMotion(page);
                samples.push({ row: await routing.boundingBox(), button: await page.getByRole('button', { name: '歌・雑談の設定', exact: true }).boundingBox() });
            }
            expect(samples[1]).toEqual(samples[0]); expect(samples[2]).toEqual(samples[0]);
            expect(samples[0].row!.height).toBeLessThan(96);
            await page.evaluate(() => (window as any).__e2eSetOutputMuted(true));
            const recovery = routing.getByRole('button', { name: '出力ミュート・音量ゼロ', exact: true });
            await expect(recovery).toBeInViewport();
            await recovery.click();
            await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toBeFocused();
            // 復旧操作へ案内するだけで、ミュートを勝手に解除しない。
            await expect(recovery).toBeVisible();
            const column = page.getByRole('complementary', { name: '本番中の操作' });
            const box = (await column.boundingBox())!;
            expect(Math.round(box.x + box.width)).toBe(width);
            expect(Math.round(box.y + box.height)).toBe(640);
            expect(Math.round(box.width)).toBe(212);
            expect(await column.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
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
            const button = page.getByRole('button', { name: 'ボイスチェック', exact: true });
            // ゲーミングの操作は切り欠きの 6px。オーロラとライトは 10px のまま（8px 未満にはしない）。
            const radius = await button.evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius));
            expect(radius).toBe(theme === 'gaming' ? 6 : 10);
            await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
            await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
            await page.getByRole('tab', { name: 'システム', exact: true }).click();
            await page.getByRole('button', { name: 'セットアップを開く', exact: true }).click();
            await page.getByRole('radio', { name: '自分で聴く', exact: true }).click();
            const select = page.getByRole('combobox', { name: '機器', exact: true });
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
        await page.getByRole('button', { name: 'ボイスチェック', exact: true }).click({ trial: true });
        for (const width of [960, 1024, 1440, 1920]) {
            await page.setViewportSize({ width, height: 768 });
            const range = page.getByRole('slider', { name: '声の整え具合', exact: true });
            const track = range.locator('xpath=ancestor::*[@data-orientation="horizontal"][last()]');
            const box = (await track.boundingBox())!;
            // 20段階の操作に6px以上/段を確保し、長大なバーにしない。
            expect(box.width).toBeGreaterThanOrEqual(120);
            expect(box.width).toBeLessThanOrEqual(240);
            // 幅だけを確かめる。値を動かすと確定して音声処理へ送るため、この画面試験では操作しない（刻みは単体試験で確かめる）。
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
        // 未設定のホームは次の1歩を主ボタンにし、オーディオの設定はレールの接続から開く（#297）。
        await reachable(page.getByRole('button', { name: '送り先を決める', exact: true }), page);
        const setup = page.getByRole('button', { name: '接続（オーディオの設定）', exact: true });
        await reachable(setup, page);
        await setup.click();
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
        const leave = page.getByRole('alertdialog', { name: '保存していない変更があります' });
        if (await leave.isVisible()) await leave.getByRole('button', { name: '変更を捨てて移動', exact: true }).click();
        await page.getByRole('tab', { name: '外観', exact: true }).click();
        await reachable(page.getByRole('combobox', { name: '表示言語' }), page);
        await page.getByRole('tab', { name: 'システム', exact: true }).click();
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
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; document.documentElement.style.setProperty('--ui-zoom', '2'); });
    const setup = page.getByRole('button', { name: '接続（オーディオの設定）', exact: true });
    await setup.click();
    const rail = page.getByRole('navigation', { name: '行き先' });
    await rail.getByRole('button', { name: '設定', exact: true }).click();
    const leave = page.getByRole('alertdialog', { name: '保存していない変更があります' });
    if (await leave.isVisible()) await leave.getByRole('button', { name: '変更を捨てて移動', exact: true }).click();
    const surface = page.locator('[data-settings-page]');
    const tab = surface.getByRole('tab', { name: '外観', exact: true });
    await reachable(tab, page);
    await tab.click();
    const language = surface.getByRole('combobox', { name: '表示言語' });
    await reachable(language, page);
    await language.focus();
    await page.keyboard.press('ArrowDown');
    await expect(surface.getByRole('combobox', { name: 'Display language' })).toHaveValue('en');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(surface).toBeVisible();
    await page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Home', exact: true }).click();
    await expect(surface).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connection (audio settings)', exact: true })).toBeVisible();
});

// VST は中央のページ。右の列の本番操作は、狭い窓でも広い窓でもページの外で使える。
test('最小〜最大: VSTのページは右の列と重ならず、Escapeでは閉じない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', output: 'Test headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    const meter = page.getByRole('meter', { name: '出力', exact: true });
    await expect(meter).toBeVisible();
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    for (const width of [900, 960, 1024, 1280, 1440, 1536, 1920]) {
        await page.setViewportSize({ width, height: 768 });
        const main = page.locator('main');
        await page.locator('#home-vst-open').click();
        const vstPage = page.locator('[data-vst-page]');
        await expect(vstPage).toBeVisible();
        await expect(meter).toBeVisible();
        await expect(main).not.toHaveAttribute('inert', '');
        await expect.poll(async () => {
            const panel = (await vstPage.boundingBox())!;
            const meterBox = (await meter.boundingBox())!;
            return meterBox.x >= panel.x + panel.width - 1 || panel.x >= meterBox.x + meterBox.width - 1;
        }).toBe(true);
        await reachable(page.getByRole('button', { name: '緊急ミュート', exact: true }), page);
        await reachable(page.getByRole('slider', { name: '出力音量', exact: true }), page);
        if (width === 960 || width === 1536) await page.screenshot({ path: testInfo.outputPath(`vst-responsive-${width}.png`) });
        await page.keyboard.press('Escape');
        await expect(vstPage).toBeVisible();
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
        await expect(vstPage).toHaveCount(0);
        await expect(main).not.toHaveAttribute('inert', '');
        await expect(page.locator('#home-vst-open')).toBeVisible();
        await expect(meter).toBeVisible();
    }
});

test('右の列の横メーターは列の中に収まり、状態文はバーの中に重なる', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', output: 'Test headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
    const meter = column.getByRole('meter', { name: '出力', exact: true });
    for (const width of [960, 1024, 1920, 2560]) {
        await page.setViewportSize({ width, height: width <= 1024 ? 640 : 1080 });
        const columnBox = (await column.boundingBox())!;
        const box = (await meter.boundingBox())!;
        expect(box.height).toBeCloseTo(16 * uiScale(width, width <= 1024 ? 640 : 1080), 1);
        expect(box.x).toBeGreaterThanOrEqual(columnBox.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(columnBox.x + columnBox.width + 1);
        const status = meter.locator('[data-meter-status]');
        await expect(status).toBeVisible();
        expect(await status.evaluate(el => {
            const bar = el.closest('[role="meter"]')!.getBoundingClientRect();
            const text = el.getBoundingClientRect();
            return text.left >= bar.left - 1 && text.right <= bar.right + 1 && text.top >= bar.top - 1 && text.bottom <= bar.bottom + 1;
        })).toBe(true);
        if (width === 960 || width === 2560) await page.screenshot({ path: testInfo.outputPath(`meter-spacing-${width}.png`) });
    }
});

test.describe('登録済みの歌・雑談とVSTのページ', () => {
    test.use({ liveHome: true });
    for (const theme of ['light', 'dark', 'gaming']) {
        test(`${theme}: ページを開いても右の列は押せ、ホームへ戻るとモードを操作できる`, async ({ page }, testInfo) => {
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
            const modes = page.getByRole('region', { name: '状態の帯', exact: true }).getByRole('radiogroup', { name: 'モード切替' });
            await expect(modes).toBeVisible();
            const meter = page.getByRole('meter', { name: '出力', exact: true });
            await page.locator('#home-vst-open').click();
            await expect(page.locator('[data-vst-page]')).toBeVisible();
            await expect(page.locator('main')).not.toHaveAttribute('inert', '');
            await expect(page.locator('.vst-panel-scrim')).toHaveCount(0);
            await expect(meter).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.locator('[data-vst-page]')).toBeVisible();
            await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
            await expect(page.locator('[data-vst-page]')).toHaveCount(0);
            for (const name of ['歌', '雑談']) await reachable(modes.getByRole('radio', { name, exact: true }), page);
            await expect(meter).toBeVisible();
            await page.locator('#home-vst-open').click();
            await page.setViewportSize({ width: 1600, height: 900 });
            await expect(page.locator('main')).not.toHaveAttribute('inert', '');
            await expect(meter).toBeVisible();
            await reachable(page.getByRole('slider', { name: /100%/ }), page);
            await page.screenshot({ path: testInfo.outputPath(`registered-modes-${theme}.png`) });
        });
    }
});

// VST はページなので、開いても作業幅は変わらない。予約幅の補間はなくした。
// 入口は設定済みのホームにだけ出る（#297）。
test.describe('VSTのページの出入り', () => {
    test.use({ liveHome: true, registeredModes: false });
    for (const width of [960, 1280, 1600]) {
        test(`VSTのページは作業幅を変えず、Escapeでは閉じない ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 768 });
            await page.addInitScript(() => {
                localStorage.setItem('vst_host_wizard_done', 'true');
            });
            await page.goto('/');
            const toggle = page.locator('#home-vst-open');
            await expect(toggle).toBeVisible();
            await settleLayoutMotion(page);
            const closedMainWidth = (await page.locator('main').boundingBox())!.width;
            await expect(toggle).toHaveText('追加');
            await toggle.click();
            const vstPage = page.locator('[data-vst-page]');
            await expect(vstPage).toBeVisible();
            await expect(page.locator('#vst-panel, .vst-panel-space, .vst-panel-scrim')).toHaveCount(0);
            await settleLayoutMotion(page);
            expect(Math.abs((await page.locator('main').boundingBox())!.width - closedMainWidth)).toBeLessThan(1);
            await expect(page.locator('#add-effect-btn')).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(vstPage).toBeVisible();
            await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
            await expect(vstPage).toHaveCount(0);
            await expect(toggle).toBeVisible();
        });
    }

    test('動きの設定にかかわらずVSTのページは移動せず、キーボードで開く', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
        });
        await page.goto('/');
        const toggle = page.locator('#home-vst-open');
        const moved = () => page.evaluate(() => {
            const root = document.querySelector('[data-vst-page]');
            return Boolean(root?.getAnimations().some(animation => {
                const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
                return frames.some(frame => frame.transform !== undefined && frame.transform !== 'none');
            }));
        });
        await toggle.click();
        const vstPage = page.locator('[data-vst-page]');
        await expect(vstPage).toBeVisible();
        expect(await moved()).toBe(false);
        await page.keyboard.press('Escape');
        await expect(vstPage).toBeVisible();
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
        await expect(vstPage).toHaveCount(0);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(toggle).toHaveText('追加');
        await toggle.focus();
        await page.keyboard.press('Enter');
        await expect(vstPage).toBeVisible();
        await expect(page.locator('#add-effect-btn')).toBeFocused();
        expect(await moved()).toBe(false);
    });
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
        await expect(page.locator('.large-meter-motion')).toHaveCount(0);
        const input = page.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
        const output = page.getByRole('meter', { name: '出力', exact: true });
        // 実機と同様に通知を継続し、段階ごとに目標値を切り替える。
        await page.evaluate(() => {
            const state = { value: null as number | null };
            (window as any).__layoutMeterState = state;
            setInterval(() => {
                if (state.value !== null) (window as any).__e2eEmit('audio-level', { input: [state.value, state.value], output: [state.value, state.value] });
            }, 100);
        });
        const emit = (value: number | null) => page.evaluate(value => {
            (window as any).__layoutMeterState.value = value;
            (window as any).__e2eEmit('audio-level', value === null ? { input: [], output: [] } : { input: [value, value], output: [value, value] });
        }, value);
        {
            await expect(output).toHaveCount(1);
            for (const locator of [input, output]) {
                await expect(locator).toBeVisible();
                await (await locator.elementHandle())!.waitForElementState('stable');
            }
            await emit(0.1);
            await expect.poll(async () => {
                const value = await input.getAttribute('aria-valuenow');
                return value !== null && Number.isFinite(Number(value)) && Math.abs(Number(value) + 20) < 0.05;
            }).toBe(true);
            // 状態の文言が変わるとホームの区画が位置を補間する（#298）。動きの途中ではなく、止まった位置で比べる。
            await settleLayoutMotion(page);
            const baseline = await Promise.all([input, output].map(locator => locator.boundingBox()));
            await emit(1.2);
            const resets = page.getByRole('button', { name: /クリップ表示を消す/ });
            await expect(resets).toHaveCount(2);
            await settleLayoutMotion(page);
            for (const [i, locator] of [input, output].entries()) {
                const clipped = (await locator.boundingBox())!;
                expect(clipped).toEqual(baseline[i]);
            }
            await page.screenshot({ path: testInfo.outputPath('clip.png') });
            // 出力のクリップは、入力の履歴とは独立して解除する。
            await emit(0.1);
            await page.getByRole('button', { name: '出力のクリップ表示を消す', exact: true }).click();
            await expect(resets).toHaveCount(1);
            await resets.click();
            await emit(0);
            await settleLayoutMotion(page);
            await expect(output.locator('[data-meter-status]')).toHaveText('無音');
            for (const [i, locator] of [input, output].entries()) {
                expect(await locator.boundingBox()).toEqual(baseline[i]);
            }
            // 不正なレベル通知は更新待ちになり、バーの寸法は変えない。
            await emit(null);
            await expect(output.locator('[data-meter-status]')).toHaveText('受信待ち');
            expect(await output.boundingBox()).toEqual(baseline[1]);
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
        const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
        const bar = column.getByRole('meter', { name: 'マイクの入力レベル', exact: true });
        await expect(bar).toBeVisible();
        const value = bar.locator('..').locator(':scope > span').first();
        const control = column.getByRole('slider', { name: /マイク音量/ });
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

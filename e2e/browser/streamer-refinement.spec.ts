import { test, expect } from './tauriFixture';

test.use({ liveHome: true, registeredModes: true, builtinEnabled: true });
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});

test('通常の声ON・残響OFFは一部ONと表示せず、設定の内訳は情報ボタンで確認できる', async ({ page }) => {
    await page.goto('/');
    const row = page.locator('#home-builtin');
    await expect(row).toHaveAttribute('data-on', 'true');
    await expect(row).not.toContainText('一部ON');
    await row.getByRole('button', { name: '声を整える機能の処理内容', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('声の処理：ON');
    await expect(page.getByRole('dialog')).toContainText('残響：OFF');
});

test('マウスで開き直したパネルは見出し枠を出さず、キーボードでは枠を保つ', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
        const toggle = page.locator('#vst-panel-toggle');
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#vst-panel')).toHaveCount(0);
    await toggle.click();
    const heading = page.locator('#plugin-rack-heading');
    await expect(heading).toBeFocused();
    expect(await heading.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('none');
    await page.keyboard.press('Escape');
    await expect(page.locator('#vst-panel')).toHaveCount(0);
    await toggle.press('Enter');
    await expect(heading).toBeFocused();
    expect(await heading.evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe('none');
});

test('右の列のマイク音量は画面の高さを変えても残り、大型メーターは出さない', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 1200 });
    await page.goto('/');
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    const slider = page.getByRole('complementary', { name: '本番中の操作', exact: true }).getByRole('slider', { name: /マイク音量/ });
    await slider.focus();
    for (const height of [1000, 1200]) {
        await page.setViewportSize({ width: 1200, height });
        await expect(slider).toBeVisible();
        await expect(slider).toBeFocused();
    }
});

test('音量変更失敗は原因の原文を出さず、保存を保留して再試行できる', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let attempts = 0;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
            if (command === 'set_input_gain') {
                if (++attempts === 1) throw new Error('IPC transport lost');
                return;
            }
            return original(command, args);
        };
    });
    await page.goto('/');
    const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
    await column.getByRole('slider', { name: /マイク音量/ }).press('ArrowRight');
    await expect(column.getByRole('alert')).toContainText('接続を確認して再試行');
    await expect(column).not.toContainText('IPC transport lost');
    await page.screenshot({ path: testInfo.outputPath('input-volume-failure.png') });
    expect(await page.evaluate(() => localStorage.getItem('vst_host_input_gain'))).not.toBe('101');
    await column.getByRole('button', { name: '再試行', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('vst_host_input_gain'))).toBe('101');
    await expect(column.getByRole('alert')).toHaveCount(0);
});

test('緊急ミュートの通信失敗では外部アプリでのミュートと設定への入口を示す', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === 'toggle_global_mute'
            ? Promise.reject(new Error('IPC transport lost')) : original(command, args);
    });
    await page.goto('/');
    await page.getByRole('button', { name: '緊急ミュート', exact: true }).click();
    const failure = page.locator('[data-sonner-toast]').filter({ hasText: 'ミュートの切替を確認できません' });
    await expect(failure).toContainText('配信・通話アプリ側でミュート');
    await expect(failure).not.toContainText('IPC transport lost');
    await failure.evaluate(async element => {
        await new Promise(requestAnimationFrame);
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    // 通知は中央の列の中に出る。右の列には重ならず、列の位置も動かさない。
    const column = (await page.getByRole('complementary', { name: '本番中の操作' }).boundingBox())!;
    const rail = (await page.getByRole('navigation', { name: '行き先', exact: true }).boundingBox())!;
    const toast = (await failure.boundingBox())!;
    expect(toast.x + toast.width).toBeLessThanOrEqual(column.x + 1);
    expect(Math.abs(column.y - rail.y)).toBeLessThanOrEqual(1);
    const mute = (await page.getByRole('button', { name: '緊急ミュート', exact: true }).boundingBox())!;
    expect(mute.y - column.y).toBeLessThanOrEqual(16);
    await page.screenshot({ path: testInfo.outputPath('mute-failure.png') });
    await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toHaveAttribute('aria-pressed', 'false');
    // cold loadのモジュール取得と、取得後のdialog表示を別々に確認する。
    // 事前読込みはせず、この操作が実際に設定画面の取得を始めることも検証する。
    const [settingsModule] = await Promise.all([
        // 開発サーバーは元のファイル、CI の本番ビルドは分割された部品を返す。
        page.waitForResponse(response => /^\/(?:src\/components\/features\/AudioSettings\/AudioSettingsModal\.tsx|assets\/AudioSettingsModal-[\w-]+\.js)$/.test(new URL(response.url()).pathname)),
        failure.getByRole('button', { name: '設定を開く', exact: true }).click(),
    ]);
    expect(settingsModule.ok()).toBe(true);
    await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible({ timeout: 15_000 });
});

test('出力音量の失敗は右の列で再試行でき、確認できるまでは保存値を変えない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let attempts = 0;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === 'set_output_gain' && ++attempts === 1
            ? Promise.reject(new Error('pipe disconnected')) : original(command, args);
    });
    await page.goto('/');
    const popup = page.getByRole('complementary', { name: '本番中の操作' });
    await popup.getByRole('slider', { name: '出力音量', exact: true }).press('ArrowRight');
    await expect(popup.getByRole('alert')).toContainText('音量を確認できません');
    expect(await page.evaluate(() => localStorage.getItem('vst_host_output_gain'))).not.toBe('101');
    // 定期取得で表示が旧値へ戻っても、再試行は失敗した101%を送る。
    await expect(popup.getByRole('slider', { name: '出力音量', exact: true })).toHaveAttribute('aria-valuenow', '100');
    await page.screenshot({ path: testInfo.outputPath('output-volume-failure.png') });
    await popup.getByRole('button', { name: '再試行', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('vst_host_output_gain'))).toBe('101');
});

test('モードの初回読込に失敗してもホームから再取得して復帰できる', async ({ page }) => {
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let fail = true;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => {
            if (command === 'live_modes' && fail) { fail = false; return Promise.reject(new Error('lost connection')); }
            return original(command, args);
        };
    });
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('モードの状態を取得できません');
    await page.getByRole('button', { name: 'モードの状態を再取得', exact: true }).click();
    await expect(page.getByRole('radio', { name: '歌', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('登録したモードの違いが分かり、歌向けの調整へ直接移れる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '歌・雑談の設定', exact: true }).click();
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    // CIでは設定画面の遅延読込を待ってから、内容と移動を検証する。
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(settings).toBeVisible({ timeout: 15_000 });
    const modes = settings.locator('#live-mode-settings');
    await expect(modes).toContainText('歌唱と雑談に同じ設定');
    await expect(modes).toContainText('声 ON・残響 OFF');
    await modes.getByRole('button', { name: '歌モードの音を調整', exact: true }).click();
    await expect(page.locator('#singing-settings')).toHaveAttribute('open', '');
    await expect(page.locator('#singing-settings > summary')).toBeFocused();
    await page.getByRole('button', { name: 'モード登録へ戻る', exact: true }).click();
    await expect(page.locator('#live-mode-settings > h3')).toBeFocused();
});

test('再評価用の正常ホームは警告状態と分け、縦長でも出力メーターを離さない', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.evaluate(() => {
        (window as any).__e2eSetOutputMuted(false);
        setInterval(() => (window as any).__e2eEmit('audio-level', { input: [0.32, 0.28], output: [0.25, 0.2] }), 100);
    });
    await expect(page.locator('#vst-panel-toggle')).toHaveText('追加');
    await expect(page.getByRole('region', { name: 'VST保存済み構成の保護', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '出力ミュート・音量ゼロ', exact: true })).toHaveCount(0);
    for (const [width, height] of [[1024, 768], [1920, 1080], [1200, 1849]]) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: testInfo.outputPath(`healthy-${width}x${height}.png`) });
    }
    await page.locator('#vst-panel-toggle').click();
    await expect(page.locator('#vst-panel')).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#vst-panel-toggle')).toHaveCount(0);
    await expect(page.locator('#vst-panel').getByRole('button', { name: 'VSTを追加', exact: true })).toHaveCount(1);
    const meter = page.getByRole('meter', { name: '出力', exact: true });
    await expect(meter).toBeVisible();
    await expect(page.locator('.large-meter-motion')).toHaveCount(0);
    await page.locator('.app-shell').evaluate(async element => {
        await new Promise(requestAnimationFrame);
        await Promise.all(element.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
    });
    expect(await page.locator('.home-content').evaluate(e => e.getBoundingClientRect().right)).toBeLessThan((await page.locator('#vst-panel').boundingBox())!.x);
    const column = (await page.getByRole('complementary', { name: '本番中の操作', exact: true }).boundingBox())!;
    const meterBox = (await meter.boundingBox())!;
    expect(meterBox.x).toBeGreaterThanOrEqual(column.x - 1);
    expect(meterBox.x + meterBox.width).toBeLessThanOrEqual(column.x + column.width + 1);
    await page.screenshot({ path: testInfo.outputPath('healthy-portrait-panel.png') });
});

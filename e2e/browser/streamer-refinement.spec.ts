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
    await row.getByRole('button', { name: '内蔵ボイスチェーンの処理内容', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('声の処理: 設定 ON');
    await expect(page.getByRole('dialog')).toContainText('残響: 設定 OFF');
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

test('音量小窓を開いたまま大型メーターが縦横を切り替えても入力調整とフォーカスを保つ', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 1200 });
    await page.goto('/');
    await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
    const meter = page.locator('.large-meter-motion');
    await meter.getByRole('button', { name: '詳細表示', exact: true }).click();
    await expect(meter.getByRole('button', { name: /マイク音量/ })).toHaveCount(0);
    await page.locator('.live-strip').getByRole('button', { name: 'マイク音量 100%', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'マイク音量', exact: true });
    for (const height of [1000, 1200]) {
        await page.setViewportSize({ width: 1200, height });
        await expect(popup).toBeVisible();
        await expect(popup.getByRole('slider')).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.live-strip').getByRole('button', { name: 'マイク音量 100%', exact: true })).toBeFocused();
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
    await page.getByRole('button', { name: 'マイク音量 100%', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'マイク音量', exact: true });
    await popup.getByRole('slider').press('ArrowRight');
    await expect(popup.getByRole('alert')).toContainText('接続を確認して再試行');
    await expect(popup).not.toContainText('IPC transport lost');
    await page.screenshot({ path: testInfo.outputPath('input-volume-failure.png') });
    expect(await page.evaluate(() => localStorage.getItem('vst_host_input_gain'))).not.toBe('101');
    await popup.getByRole('button', { name: '再試行', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('vst_host_input_gain'))).toBe('101');
    await expect(popup.getByRole('alert')).toHaveCount(0);
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
    expect((await failure.boundingBox())!.y + (await failure.boundingBox())!.height).toBeLessThanOrEqual((await page.locator('footer').boundingBox())!.y);
    await page.screenshot({ path: testInfo.outputPath('mute-failure.png') });
    await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await failure.getByRole('button', { name: '設定を開く', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible();
});

test('出力音量の失敗は小窓でも再試行でき、確認できるまでは保存値を変えない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let attempts = 0;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === 'set_output_gain' && ++attempts === 1
            ? Promise.reject(new Error('pipe disconnected')) : original(command, args);
    });
    await page.goto('/');
    await page.locator('.live-output-summary').getByRole('button', { name: '出力音量', exact: true }).click();
    const popup = page.getByRole('dialog', { name: '出力音量', exact: true });
    await popup.getByRole('slider').press('ArrowRight');
    await expect(popup.getByRole('alert')).toContainText('音量を確認できません');
    expect(await page.evaluate(() => localStorage.getItem('vst_host_output_gain'))).not.toBe('101');
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
    await expect(page.getByRole('button', { name: '歌唱モード', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('登録したモードの違いが分かり、歌向けの調整へ直接移れる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    const modes = page.locator('#live-mode-settings');
    await expect(modes).toContainText('歌唱と雑談に同じ設定');
    await expect(modes).toContainText('声 ON・残響 OFF');
    await modes.getByRole('button', { name: '歌唱モードの音を調整', exact: true }).click();
    await expect(page.locator('#singing-settings')).toHaveAttribute('open', '');
    await expect(page.locator('#singing-settings > summary')).toBeFocused();
    await page.getByRole('button', { name: 'モード登録へ戻る', exact: true }).click();
    await expect(page.locator('#live-mode-settings > summary')).toBeFocused();
});

test('再評価用の正常ホームは警告状態と分け、縦長でも出力メーターを離さない', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.evaluate(() => {
        (window as any).__e2eSetOutputMuted(false);
        setInterval(() => (window as any).__e2eEmit('audio-level', { input: [0.32, 0.28], output: [0.25, 0.2] }), 100);
    });
    await expect(page.locator('#vst-panel-toggle')).toHaveText('追加');
    await expect(page.getByRole('region', { name: 'VST保存済み構成の保護', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ミュート・出力音量を確認', exact: true })).toHaveCount(0);
    for (const [width, height] of [[1024, 768], [1920, 1080], [1200, 1849]]) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: testInfo.outputPath(`healthy-${width}x${height}.png`) });
    }
    await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).click();
    await page.locator('#vst-panel-toggle').click();
    const meter = page.locator('.large-meter-motion');
    await expect(meter).toHaveAttribute('data-horizontal', 'true');
    await page.locator('.app-shell').evaluate(async element => {
        await new Promise(requestAnimationFrame);
        await Promise.all(element.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
    });
    expect(await page.locator('.home-content').evaluate(e => e.getBoundingClientRect().right)).toBeLessThan((await page.locator('#vst-panel').boundingBox())!.x);
    // 下部領域の中央へ押し下げず、直前の内容から通常の余白で続ける。
    expect(await meter.evaluate(e => e.getBoundingClientRect().top - e.parentElement!.getBoundingClientRect().top)).toBeLessThanOrEqual(32);
    await page.screenshot({ path: testInfo.outputPath('healthy-portrait-panel.png') });
});

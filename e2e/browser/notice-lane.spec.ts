import { test, expect } from './tauriFixture';

test.use({ liveHome: true });

test('複数通知を展開・縮小しても本文と重ならず、退場後は高さを戻す', async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === 'toggle_global_mute'
            ? Promise.reject(new Error('テスト用の通信失敗')) : original(command, args);
    });
    await page.goto('/');
    await expect(page.locator('#emergency-mute')).toBeVisible();
    await page.evaluate(() => {
        (window as any).__e2eEmit('global-mute-changed', true);
        (window as any).__e2eEmit('global-mute-changed', false);
    });
    await page.locator('#emergency-mute').click();
    const notifications = page.locator('[data-sonner-toast][data-visible="true"]');
    await expect(notifications).toHaveCount(3);
    const lane = page.locator('.notice-lane');
    for (const width of [1440, 960, 900]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
        await notifications.first().hover();
        await expect.poll(async () => page.evaluate(() => {
            const lane = document.querySelector('.notice-lane')!.getBoundingClientRect();
            const main = document.querySelector('main')!.getBoundingClientRect();
            return [...document.querySelectorAll('[data-sonner-toast][data-visible="true"]')].every(node => {
                const box = node.getBoundingClientRect();
                return box.top >= lane.top - 1 && box.bottom <= lane.bottom + 1 && box.bottom <= main.top + 1;
            });
        })).toBe(true);
        await expect(page.getByRole('complementary', { name: '本番中の操作' }).getByRole('slider', { name: '出力音量', exact: true })).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: info.outputPath('three-notifications.png') });
    // 通常通知が消えた後も、無期限の通信失敗通知は本文を覆わず、再試行への入口を保つ。
    await page.mouse.move(0, 0);
    await expect(notifications).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(async () => {
        const notification = (await notifications.first().boundingBox())!;
        const box = (await lane.boundingBox())!;
        return Math.abs(box.height - notification.height);
    }).toBeLessThanOrEqual(1);
    await expect(notifications.getByRole('button', { name: '設定を開く', exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__e2eEmit('global-mute-changed', true));
    await page.mouse.move(0, 0);
    await expect(notifications).toHaveCount(0, { timeout: 10_000 });
    await expect(lane).toHaveCSS('min-height', '0px');
});

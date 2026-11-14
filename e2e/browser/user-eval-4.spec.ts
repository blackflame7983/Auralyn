import { test, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';

test.use({ liveHome: true, builtinEnabled: true });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});

test('配信のいまの状態に、モードと送る音とミュートが出る', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    const now = page.getByRole('region', { name: 'いまの状態', exact: true });
    await expect(now.getByText('モード', { exact: true })).toBeVisible();
    await expect(now.getByRole('heading', { name: 'いまの調整', exact: true })).toBeVisible();
    await expect(now.locator('[data-now-mute="clear"]')).toHaveText('ミュートしていない');
    await expect(now.getByRole('meter', { name: '送る音', exact: true })).toBeVisible();
    await expect(now.locator('[data-now-incoming]')).toBeVisible();
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(true));
    await expect(now.locator('[data-now-mute="muted"]')).toHaveText('出力ミュート・音量ゼロ');
});

test('無音・待機では声の流れに文字が出て、音が来ているときだけ波形を描く', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    const flow = page.getByRole('region', { name: '声の流れ', exact: true });
    const graph = flow.getByRole('img', { name: '加工前と加工後の音量', exact: true });
    await expect(flow.locator('[data-flow-status="waiting"]')).toHaveText('レベル未受信');
    await expect(graph).toHaveAttribute('data-flow', 'idle');
    await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0, 0], output: [0, 0] }));
    await expect(flow.locator('[data-flow-status="silent"]')).toHaveText('無音');
    await expect(graph).toHaveAttribute('data-flow', 'idle');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(flow.locator('[data-flow-status="silent"]')).toHaveCSS('animation-name', 'none');
    await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.2, 0.16], output: [0.12, 0.1] }));
    await expect(graph).toHaveAttribute('data-flow', 'still');
    await expect(flow.locator('[data-flow-status]')).toHaveCount(0);
});

test('音楽鑑賞は再生元から出力を示し、聴く音の大きさを出す', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => localStorage.setItem('auralyn_display_purpose', 'music'));
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    const now = page.getByRole('region', { name: 'いまの状態', exact: true });
    await expect(now.getByRole('heading', { name: 'CABLE Output → スピーカー', exact: true })).toBeVisible();
    await expect(now.getByText('モード', { exact: true })).toHaveCount(0);
    await expect(now.getByText('再生元', { exact: true })).toBeVisible();
    await expect(now.getByRole('meter', { name: '出力の大きさ', exact: true })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('マイク');
});

for (const size of [
    { width: 960, height: 640 },
    { width: 1024, height: 768 },
    { width: 1920, height: 1080 },
]) {
    test(`いまの状態と音調整の1段目が ${size.width}×${size.height} の窓に収まる`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.goto('/');
        await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
        await settleLayoutMotion(page);
        const now = page.getByRole('region', { name: 'いまの状態', exact: true });
        await expect(now).toBeVisible();
        const card = page.locator('.sound-module-item').first();
        await expect(card).toBeVisible();
        const box = (await card.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
        expect(await page.locator('main').evaluate(element => element.scrollTop === 0 && element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
        await expect(column.getByRole('button', { name: '緊急ミュート', exact: true })).toBeInViewport();
        await expect(column.getByRole('switch', { name: 'VSTを外して比較', exact: true })).toBeInViewport();
    });
}

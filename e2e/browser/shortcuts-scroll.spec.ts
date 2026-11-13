import { test, expect } from './tauriFixture';

test.use({ liveHome: true });

// ホットキーのタブは、設定の本文だけがスクロールし、タブの内側に2つ目のスクロールを作らない（#354）。
for (const size of [{ width: 960, height: 640 }, { width: 1280, height: 800 }]) {
    test(`ホットキーのタブはスクロールが1つ（${size.width}x${size.height}）`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
        const dialog = page.locator('[data-settings-page]');
        await dialog.getByRole('tab', { name: 'ホットキー', exact: true }).click();
        await expect(dialog.getByRole('button', { name: '推奨のキーをまとめて入力' })).toBeVisible();
        const scrollers = await dialog.evaluate(root => [root, ...root.querySelectorAll('*')].filter(el => {
            const style = getComputedStyle(el);
            return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        }).length);
        expect(scrollers).toBe(1);
    });
}

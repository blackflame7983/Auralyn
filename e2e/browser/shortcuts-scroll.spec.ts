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

test('960x640で一覧からキーを選んで割り当てを変えられる', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
    const dialog = page.locator('[data-settings-page]');
    await dialog.getByRole('tab', { name: 'ホットキー', exact: true }).click();
    const row = dialog.locator('fieldset').filter({ has: page.getByRole('button', { name: '緊急ミュート（切替）のキーを入力', exact: true }) });
    const name = row.locator('span').first();
    const binding = row.locator('[data-shortcut-binding]');
    const enter = row.getByRole('button', { name: '緊急ミュート（切替）のキーを入力', exact: true });
    await expect(binding).toHaveText('未設定');
    await expect(binding.locator('kbd')).toHaveCount(0);
    const [nameBox, keyBox, enterBox] = await Promise.all([name.boundingBox(), binding.boundingBox(), enter.boundingBox()]);
    const mid = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(mid(nameBox!) - mid(keyBox!))).toBeLessThanOrEqual(4);
    expect(Math.abs(mid(keyBox!) - mid(enterBox!))).toBeLessThanOrEqual(4);
    await row.getByRole('button', { name: '緊急ミュート（切替）のキーを一覧から選ぶ', exact: true }).click();
    const modifier = dialog.getByRole('combobox', { name: '緊急ミュート（切替）の修飾キー', exact: true });
    const list = dialog.getByRole('combobox', { name: '緊急ミュート（切替）の通常キー', exact: true });
    await expect(modifier).toBeVisible();
    await expect(list).toBeVisible();
    await modifier.selectOption('Alt');
    await list.selectOption('KeyZ');
    const assigned = binding.locator('kbd');
    await expect(assigned).toHaveText('Alt + Z');
    await expect(assigned).toHaveCSS('border-top-style', 'solid');
});

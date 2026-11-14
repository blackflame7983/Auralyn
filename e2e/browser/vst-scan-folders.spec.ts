import { test, expect } from './tauriFixture';

test.use({ liveHome: true });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});

async function openBrowser(page: import('@playwright/test').Page) {
    await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'VST', exact: true }).click();
    await page.getByRole('button', { name: 'VSTを追加', exact: true }).click();
    return page.getByRole('dialog', { name: 'VSTを追加' });
}

test('標準のフォルダーは外せない。足したフォルダーは再読み込み後も残る', async ({ page }) => {
    await page.goto('/');
    const dialog = await openBrowser(page);
    const folders = dialog.getByRole('region', { name: '探すフォルダー' });
    await expect(folders).toContainText('対応しているのはVST3だけです。標準の2つのフォルダーは外せません。');
    await expect(folders).toContainText('C:\\Program Files\\Common Files\\VST3');
    await expect(folders).toContainText('C:\\Program Files\\Steinberg\\VST3');
    await expect(folders.getByRole('button', { name: /を外す/ })).toHaveCount(0);
    await folders.getByRole('textbox', { name: 'フォルダーのパス' }).fill('D:\\Custom\\VST3');
    await folders.getByRole('button', { name: 'フォルダーを追加', exact: true }).click();
    await expect(folders.getByRole('button', { name: 'D:\\Custom\\VST3 を外す' })).toBeVisible();
    await page.reload();
    const again = await openBrowser(page);
    await expect(again.getByRole('button', { name: 'D:\\Custom\\VST3 を外す' })).toBeVisible();
    await expect(again.getByRole('button', { name: /Program Files\\Common Files\\VST3 を外す/ })).toHaveCount(0);
});

test('見つからないフォルダーを知らせ、足したフォルダーのVST3を一覧に出す', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('auralyn_vst_scan_folders', JSON.stringify(['D:\\Custom\\VST3', 'D:\\Missing\\VST3']));
    });
    await page.goto('/?previewScanFolders=1');
    const dialog = await openBrowser(page);
    await dialog.getByRole('button', { name: '更新', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Room を追加', exact: true })).toBeVisible();
    const folders = dialog.getByRole('region', { name: '探すフォルダー' });
    await expect(folders.getByText('見つかりません', { exact: true })).toBeVisible();
    await expect(folders.getByRole('button', { name: 'D:\\Custom\\VST3 を外す' })).toBeVisible();
    await expect(folders.getByRole('button', { name: 'D:\\Missing\\VST3 を外す' })).toBeVisible();
});

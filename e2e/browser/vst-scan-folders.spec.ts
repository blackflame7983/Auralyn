import { test, expect } from './tauriFixture';
import { shortWrappedLines } from './helpers/shortLines';

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
    await page.locator('#add-effect-btn').click();
    return page.getByRole('dialog', { name: 'VSTを追加' });
}

test('標準のフォルダーは外せない。足したフォルダーは再読み込み後も残る', async ({ page }) => {
    await page.goto('/');
    const dialog = await openBrowser(page);
    const find = dialog.getByRole('button', { name: 'VSTを探す', exact: true });
    await expect(find).toBeVisible();
    await expect(find).toHaveClass(/bg-primary/);
    await expect(dialog.getByRole('button', { name: 'すべて再スキャン', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '更新', exact: true })).toHaveCount(0);
    const folders = dialog.getByRole('region', { name: '探すフォルダー' });
    // ふだんは閉じている。VST の一覧を先に見せるため。
    await expect(folders.locator('details')).not.toHaveAttribute('open', '');
    await folders.locator('summary').click();
    await expect(folders).toContainText('対応しているのはVST3だけです。標準の2つのフォルダーは外せません。');
    await expect(folders).toContainText('C:\\Program Files\\Common Files\\VST3');
    await expect(folders).toContainText('C:\\Program Files\\Steinberg\\VST3');
    await expect(folders.getByRole('button', { name: /を外す/ })).toHaveCount(0);
    await folders.getByRole('textbox', { name: 'フォルダーのパス' }).fill('D:\\Custom\\VST3');
    await folders.getByRole('button', { name: 'フォルダーを追加', exact: true }).click();
    await expect(folders.getByRole('button', { name: 'D:\\Custom\\VST3 を外す' })).toBeVisible();
    await page.reload();
    const again = await openBrowser(page);
    await again.getByRole('region', { name: '探すフォルダー' }).locator('summary').click();
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
    await expect(dialog.getByRole('button', { name: 'すべて再スキャン', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'VSTを探す', exact: true })).toHaveCount(0);
    const folders = dialog.getByRole('region', { name: '探すフォルダー' });
    // 見つからないフォルダーがあるときは、開いて理由を見せる。
    await expect(folders.locator('details')).toHaveAttribute('open', '');
    await expect(folders.getByText('見つかりません', { exact: true })).toBeVisible();
    await expect(folders.getByRole('button', { name: 'D:\\Custom\\VST3 を外す' })).toBeVisible();
    await expect(folders.getByRole('button', { name: 'D:\\Missing\\VST3 を外す' })).toBeVisible();
});

const session = JSON.stringify([
    { path: 'eq.vst3', name: 'Equalizer', vendor: 'Example', version: '1', enabled: true, muted: false, gain: 1 },
]);

async function openVst(page: import('@playwright/test').Page, options: { locale: 'ja' | 'en'; music?: boolean; plugins?: boolean; width: number; height: number }) {
    await page.addInitScript(({ locale, music, plugins, saved }) => {
        localStorage.setItem('vst_host_locale', locale);
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
        if (plugins) localStorage.setItem('vst_host_session_plugins', saved);
    }, { locale: options.locale, music: Boolean(options.music), plugins: Boolean(options.plugins), saved: session });
    await page.setViewportSize({ width: options.width, height: options.height });
    await page.goto(options.plugins ? '/?previewPlugins=1' : '/');
    await page.getByRole('navigation', { name: options.locale === 'ja' ? '行き先' : 'Destinations' }).getByRole('button', { name: 'VST', exact: true }).click();
    await expect(page.locator('[data-vst-page]')).toBeVisible();
    if (options.plugins) await expect(page.getByRole('heading', { name: 'Equalizer', level: 3 })).toBeVisible();
}

for (const locale of ['ja', 'en'] as const) {
    for (const [width, height] of [[900, 600], [1024, 768]] as const) {
        test(`VSTの説明は ${width}×${height} の${locale}で1〜2文字の行にならない`, async ({ page }) => {
            await openVst(page, { locale, width, height });
            await expect(shortWrappedLines(page.locator('.page-heading-lead'))).resolves.toEqual([]);
        });
        test(`並びがあるときも VSTの説明は ${width}×${height} の${locale}で1〜2文字の行にならない`, async ({ page }) => {
            await openVst(page, { locale, width, height, plugins: true });
            await expect(shortWrappedLines(page.locator('.page-heading-lead'))).resolves.toEqual([]);
        });
    }
}

test('音楽鑑賞でも説明は見出しの下にあり、1〜2文字の行にならない', async ({ page }) => {
    await openVst(page, { locale: 'ja', music: true, width: 1024, height: 768 });
    const heading = page.locator('.page-heading');
    const place = await heading.evaluate(header => {
        const title = header.querySelector('h1')?.getBoundingClientRect();
        const lead = header.querySelector('.page-heading-lead')?.getBoundingClientRect();
        if (!title || !lead) return null;
        return { below: lead.top >= title.bottom - 4, wide: lead.width >= header.getBoundingClientRect().width - 8 };
    });
    expect(place).toEqual({ below: true, wide: true });
    await expect(shortWrappedLines(page.locator('.page-heading-lead'))).resolves.toEqual([]);
});

test('ホームの追加から開くと、空の案内のVSTを追加に焦点が移る', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    const toggle = page.locator('#home-vst-open');
    await expect(toggle).toHaveText('追加');
    await toggle.click();
    const vstPage = page.locator('[data-vst-page]');
    await expect(vstPage).toBeVisible();
    await expect(vstPage.getByRole('button', { name: 'VSTを追加', exact: true })).toHaveCount(1);
    await expect(vstPage.locator('.page-heading').getByRole('button', { name: 'VSTを追加', exact: true })).toHaveCount(0);
    await expect(page.locator('#add-effect-btn')).toBeFocused();
});

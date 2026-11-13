import { test, expect } from './tauriFixture';

for (const registeredModes of [false, true]) test.describe(`歌・雑談の登録=${registeredModes}`, () => {
test.use({ liveHome: true, stoppedHome: true, registeredModes });
for (const theme of ['dark', 'light', 'gaming']) {
    test(`設定済み停止ホーム ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(theme => {
            localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, theme);
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        const strip = page.getByRole('region', { name: 'いまの状態', exact: true });
        const band = page.getByRole('region', { name: '状態の帯', exact: true });
        await expect(band.getByText('音声停止中', { exact: true })).toHaveCount(1);
        await expect(strip.getByText('音声停止中', { exact: true })).toHaveCount(0);
        const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
        await expect(column.getByRole('meter', { name: 'マイクの入力レベル', exact: true })).toHaveAttribute('aria-valuetext', /音声停止中/);
        await expect(column.getByRole('meter', { name: '出力', exact: true })).toHaveAttribute('aria-valuetext', /音声停止中/);
        const chain = page.getByRole('region', { name: '音調整', exact: true });
        await expect(chain.getByText('状態を読み取れません', { exact: true })).toHaveCount(0);
        await expect(chain.locator('[data-tone="warn"]')).toHaveCount(0);
        await expect(chain.getByText('音声停止中', { exact: true })).toHaveCount(0);
        await expect(chain.getByText('—', { exact: true })).toHaveCount(3);
        await expect(chain.getByText('状態を読み取れない項目があります。設定で確認してください。', { exact: true })).toHaveCount(0);
        await expect(strip.locator('.now-action').getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        await expect(page.getByText('音声を開始すると、ここで音を調整できます。')).toHaveCount(0);
        await expect(page.getByText('音声停止中（開始後に反映）')).toHaveCount(0);
        const check = page.getByRole('region', { name: '音声チェック', exact: true });
        await expect(check.getByRole('button', { name: '接続の詳細', expanded: false })).toBeVisible();
        await expect(check.getByRole('button', { name: 'セットアップを開く', exact: true })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`${theme}-stopped.png`) });
        await check.getByRole('button', { name: '接続の詳細' }).click();
        await expect(check.getByRole('button', { name: '接続の詳細' })).toHaveAttribute('aria-expanded', 'true');
    });
}

});

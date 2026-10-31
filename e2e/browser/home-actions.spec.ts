import { test, expect } from './tauriFixture';

test.use({ liveHome: true, builtinEnabled: true, registeredModes: false });
test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
    });
});

test('未選択の主操作から送り先へキーボードで移動し、選択後は通常の次操作に戻る', async ({ page }, info) => {
    await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    const choose = page.getByRole('button', { name: '送り先を選ぶ', exact: true });
    await expect(choose).toBeInViewport();
    await choose.focus();
    await page.keyboard.press('Enter');
    const radio = page.getByRole('radio', { name: 'OBSで配信', exact: true });
    await expect(radio).toBeFocused();
    await expect(radio.locator('..')).toBeInViewport();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: '通話（Discordなど）', exact: true })).toBeChecked();
    await expect(choose).toHaveCount(0);
    await expect(page.getByRole('button', { name: '音調整', exact: true })).toHaveClass(/bg-primary/);
    await page.screenshot({ path: info.outputPath('destination.png') });
});

for (const theme of ['light', 'dark', 'gaming']) {
    test(`音調整の寸法とメーター注意域 ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(theme => {
            localStorage.setItem('vst_host_theme', theme);
            // 音声は使わず、両セグメントが有効な条件の表示を比較する。
            const original = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                const result = await original(command, args);
                if (command === 'get_engine_runtime_stats') {
                    result.noiseReductionEnabled = true;
                    result.noiseReductionMode = 'low';
                    result.latencyMetadata.stageBreakdown.nr.enabled = true;
                }
                return result;
            };
        }, theme);
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        const low = page.locator('#home-noise').getByRole('button', { name: '弱', exact: true });
        const broadcast = page.locator('#home-builtin').getByRole('button', { name: '配信', exact: true });
        await expect(low).toBeVisible();
        const a = (await low.boundingBox())!, b = (await broadcast.boundingBox())!;
        expect(a.width).toBe(b.width); expect(a.height).toBe(b.height);
        await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.71, 0.7], output: [0.71, 0.7] }));
        await expect(page.locator('.live-strip .bg-meter-warning').first()).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${theme}.png`) });
    });
}

test.describe('設定済みの停止中', () => {
    test.use({ stoppedHome: true });
    test('別経路で音声が復旧したら開始失敗の警告を解除する', async ({ page }, info) => {
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.evaluate(() => { (window as any).__e2eStartFailure = true; });
        await page.getByRole('button', { name: '音声を開始', exact: true }).click();
        const error = page.getByRole('alert').filter({ hasText: '音声を開始できませんでした' });
        await expect(error).toBeVisible();
        await error.getByText('確認条件・履歴', { exact: true }).click();
        await expect(error).toContainText('機器が見つかりません');
        await expect(error).not.toContainText('Error: Error:');
        await page.screenshot({ path: info.outputPath('error-details.png') });
        // ホームや設定のcallbackを通さず、別の開始経路から届く通知を再現する。
        await page.evaluate(async () => {
            (window as any).__e2eStartFailure = false;
            await (window as any).__TAURI_INTERNALS__.invoke('start_audio');
        });
        await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toHaveCount(0);
        await expect(error).toHaveCount(0);
    });
    test('音声開始後の設定失敗を、開始自体の失敗と区別する', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.evaluate(() => { (window as any).__e2eChannelFailure = true; });
        await page.getByRole('button', { name: '音声を開始', exact: true }).click();
        const error = page.getByRole('alert').filter({ hasText: '音声は開始しましたが' });
        await expect(error).toBeVisible();
        await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toHaveCount(0);
        await expect(page.getByText('音声を開始できませんでした。', { exact: false })).toHaveCount(0);
        await error.getByRole('button', { name: '入出力を変更' }).click();
        await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible();
        expect(await page.evaluate(() => (window as any).__e2eStarts.length)).toBe(1);
        await page.evaluate(() => { (window as any).__e2eChannelFailure = false; });
        await page.getByRole('button', { name: '保存して再起動', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '設定', exact: true })).toHaveCount(0);
        await expect(error).toHaveCount(0);
    });
    test('開始の主操作が最小窓内に1つあり、保存済み機器で開始できる', async ({ page }, info) => {
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        const start = page.getByRole('button', { name: '音声を開始', exact: true });
        await expect(start).toHaveCount(1);
        await expect(start).toBeInViewport();
        await expect(page.getByRole('button', { name: '入出力を変更', exact: true })).not.toHaveClass(/bg-primary/);
        await expect(page.getByText('音声停止中', { exact: true })).toHaveCount(1);
        await page.screenshot({ path: info.outputPath('stopped.png') });
        await start.click();
        await expect(start).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as any).__e2eStarts)).toEqual([
            expect.objectContaining({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones' }),
        ]);
        await expect(page.getByRole('button', { name: '送り先を選ぶ' })).toBeVisible();
    });
    test('開始できないときは原因と設定への操作を示す', async ({ page }, info) => {
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.evaluate(() => { (window as any).__e2eStartFailure = true; });
        await page.getByRole('button', { name: '音声を開始', exact: true }).click();
        const error = page.getByRole('alert').filter({ hasText: '音声を開始できませんでした' });
        await expect(error).toBeInViewport();
        await error.getByText('確認条件・履歴', { exact: true }).click();
        await expect(error).toContainText('機器が見つかりません');
        await page.screenshot({ path: info.outputPath('start-failed.png') });
        await error.getByRole('button', { name: '入出力を変更', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible();
    });
});

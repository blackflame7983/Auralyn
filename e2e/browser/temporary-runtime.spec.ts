import { test, expect } from './tauriFixture';

// VST パネルは設定済みのホームにだけ出る。未設定のホームは音の流れと次の1歩だけにする（#297）。
test.use({ liveHome: true });

test('未保存設定の退避範囲を確認し、開始失敗後も同じ画面で設定を保持する', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        const internal = (window as any).__TAURI_INTERNALS__;
        const original = internal.invoke;
        (window as any).__temporaryRequests = [];
        internal.invoke = async (command: string, args: unknown) => {
            if (command === 'restart_temporary_session') {
                (window as any).__temporaryRequests.push(args);
                throw new Error('退避できない入力です');
            }
            return original(command, args);
        };
    });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    // ラックの開閉ボタンは、VST の読み込みが済んで空と分かると「追加」に名前が変わる。名前ではなく id で掴む。
        const rack = page.locator('#vst-panel-toggle');
    if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
    await page.getByRole('button', { name: '設定の保存・復帰', exact: true }).click();
    const panel = page.locator('details').filter({ has: page.locator('summary', { hasText: '共有PCで今回だけ使う' }) });
    await panel.locator('summary').click();
    const acknowledgement = panel.getByRole('checkbox', { name: '音声の停止と、保存対象・対象外を確認しました' });
    const start = panel.getByRole('button', { name: '一時利用で再起動', exact: true });
    await acknowledgement.check();
    await expect(start).toBeEnabled();
    await panel.getByRole('checkbox', { name: '対応する未保存設定を退避してから開始する' }).check();
    await expect(acknowledgement).not.toBeChecked();
    await expect(start).toBeDisabled();
    await expect(panel.getByText('現在の音声設定を退避します。通常設定へ戻した後、復旧画面から手動で戻します。')).toBeVisible();
    await panel.getByText('対象範囲', { exact: true }).click();
    await expect(panel).toContainText('分離出力・歌／雑談モード・関連VSTも退避');
    await expect(panel).toContainText('アプリ入力は1つの返し先で');
    await expect(panel).toContainText('自動復帰しません');
    await acknowledgement.check();
    const audioBefore = await page.evaluate(() => localStorage.getItem('vst_host_audio_config'));
    await start.click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel).toContainText('詳細（原文）：退避できない入力です');
    expect(await page.evaluate(() => (window as any).__temporaryRequests)).toEqual([{ temporary: true, preserveRuntime: true }]);
    expect(await page.evaluate(() => localStorage.getItem('vst_host_audio_config'))).toBe(audioBefore);
    await expect(start).toBeEnabled();
    await start.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('temporary-checkpoint-failed.png') });
});

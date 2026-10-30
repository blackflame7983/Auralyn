import { test, expect } from './tauriFixture';

test.use({ liveHome: true, registeredModes: false });

test('未登録の入口から歌・雑談を登録し、ホームの切替と編集へ戻れる', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_setup_goal', 'listening');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    const register = page.getByRole('button', { name: 'モードを登録', exact: true });
    await expect(register).toBeVisible();
    await page.getByRole('button', { name: '音量チェックを開始', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('出力音量を測る');
    await page.getByRole('button', { name: '大型レベルメーターを開く', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('出力レベルを大きく見る');
    await register.click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(dialog.getByRole('tab', { name: '音づくり', exact: true })).toHaveAttribute('data-state', 'active');
    const section = dialog.locator('#live-mode-settings');
    await expect(section).toHaveAttribute('open', '');
    await expect(section.locator('summary').first()).toBeFocused();
    const saveSinging = section.getByRole('button', { name: '適用済み設定を歌唱モードへ登録', exact: true });
    const saveTalk = section.getByRole('button', { name: '適用済み設定を雑談モードへ登録', exact: true });
    await expect(saveSinging).toBeInViewport();
    await expect(saveTalk).toBeInViewport();
    await expect.poll(() => page.evaluate(() => (window as any).__e2eModeWrites.length)).toBe(0);
    await expect(section).toContainText('雑談は残響OFF');
    await page.screenshot({ path: testInfo.outputPath('live-registration.png') });
    await saveSinging.click();
    await expect(section.getByText('登録済み', { exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    const live = page.getByRole('region', { name: '本番', exact: true });
    const modes = live.getByRole('group', { name: 'モード切替', exact: true });
    await expect(modes.getByRole('button', { name: '歌唱モード', exact: true })).toBeEnabled();
    await expect(modes.getByRole('button', { name: '雑談モード', exact: true })).toBeDisabled();
    await expect(live.getByRole('button', { name: '歌・雑談の登録を編集', exact: true })).toBeFocused();
    await live.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    await expect(saveTalk).toBeInViewport();
    await saveTalk.click();
    await expect(section.getByText('登録済み', { exact: true })).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(modes.getByRole('button', { name: '雑談モード', exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).__e2eModeWrites.length)).toBe(2);
    await expect(register).toHaveCount(0);
});

test('設定の通常操作を先に置き、アイコンと必要時の説明で意味を確認できる', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.goto('/');
    await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    for (const name of ['オーディオ', '音づくり', 'OBS連携', '外観', 'ホットキー', 'システム']) {
        const tab = dialog.getByRole('tab', { name, exact: true });
        await expect(tab.locator('svg[aria-hidden=true]')).toHaveCount(1);
    }
    const driver = dialog.getByRole('combobox', { name: 'オーディオドライバ', exact: true });
    const permissions = dialog.getByText('マイクのアクセス許可を確認する', { exact: true });
    expect(await driver.evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('[role=tabpanel] details:last-child')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(driver).toBeInViewport();
    await expect(permissions).not.toBeInViewport();
    await dialog.getByRole('tab', { name: '音づくり', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '内蔵ボイスチェーン', exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: '内蔵ボイスチェーンの処理内容', exact: true }).click();
    const help = page.getByRole('dialog', { name: '内蔵ボイスチェーンの処理内容', exact: true });
    await expect(help).toContainText('低音の整理');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sound-settings.png') });
});

import { test, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';
import { message } from '../../src/i18n/messages';

test.use({ liveHome: true, registeredModes: false });

for (const input of ['pointer', 'keyboard'] as const) test(`詳しく調整は選択イベントを移動先にせず、通常の音づくり欄を開く（${input}）`, async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_setup_goal', 'obs');
    });
    await page.goto('/');
    const more = page.getByRole('button', { name: 'その他の操作', exact: true });
    if (input === 'pointer') await more.click(); else await more.press('Enter');
    const adjust = page.getByRole('menuitem', { name: '詳しく調整', exact: true });
    if (input === 'pointer') await adjust.click(); else await adjust.press('Enter');
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(settings.getByRole('tab', { name: '音づくり', exact: true })).toHaveAttribute('data-state', 'active');
    await expect(settings.getByRole('heading', { name: 'ノイズ低減', exact: true })).toBeInViewport();
    await expect(settings.locator('#singing-settings')).not.toHaveAttribute('open');
});

test('未登録の入口から歌・雑談を登録し、ホームの切替と編集へ戻れる', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_setup_goal', 'listening');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    const actions = page.getByRole('button', { name: '歌・雑談の設定', exact: true });
    const register = page.getByRole('button', { name: 'モードを登録', exact: true });
    await expect(actions).toBeVisible();
    // 背後のホームは初期化中も存在する。起動完了後の配置を待ってからhoverする。
    await expect(page.getByText(message('ja', 'app.initializing'), { exact: true })).toHaveCount(0);
    await settleLayoutMotion(page);
    await expect(page.getByRole('complementary', { name: '本番中の操作', exact: true }).getByRole('heading', { name: 'マイク', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '大型レベルメーターを開く', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '音量チェックを開始', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('出力音量を測る');
    await actions.click();
    await register.click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(dialog.getByRole('tab', { name: '音づくり', exact: true })).toHaveAttribute('data-state', 'active');
    const section = dialog.locator('#live-mode-settings');
    await expect(section.getByRole('heading', { name: 'モード登録', exact: true })).toBeFocused();
    const saveSinging = section.getByRole('button', { name: '適用済み設定を歌モードへ登録', exact: true });
    const saveTalk = section.getByRole('button', { name: '適用済み設定を雑談モードへ登録', exact: true });
    await expect(saveSinging).toBeInViewport();
    await expect(saveTalk).toBeInViewport();
    await expect.poll(() => page.evaluate(() => (window as any).__e2eModeWrites.length)).toBe(0);
    await section.getByRole('button', { name: 'モード登録とプロファイル保存の違い' }).click();
    const help = page.getByRole('dialog', { name: 'モード登録とプロファイル保存の違い' });
    await expect(help).toContainText('雑談では残響をOFFにします');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as any).__e2eModeWrites.length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('live-registration.png') });
    await saveSinging.click();
    await expect(section.getByText('登録済み', { exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    const modes = page.getByRole('region', { name: '状態の帯', exact: true }).getByRole('radiogroup', { name: 'モード切替', exact: true });
    await expect(modes.getByRole('radio', { name: '歌', exact: true })).toBeEnabled();
    await expect(modes.getByRole('radio', { name: '雑談', exact: true })).toBeDisabled();
    await expect(actions).toBeFocused();
    await actions.click();
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    await expect(saveTalk).toBeInViewport();
    await saveTalk.click();
    await expect(section.getByText('登録済み', { exact: true })).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(modes.getByRole('radio', { name: '雑談', exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).__e2eModeWrites.length)).toBe(2);
    await expect(register).toHaveCount(0);
    await actions.click();
    await expect(page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
});

test('設定の通常操作を先に置き、アイコンと必要時の説明で意味を確認できる', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.goto('/');
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    for (const name of ['オーディオ', '音づくり', 'OBS連携', '外観', 'ホットキー', 'システム']) {
        const tab = dialog.getByRole('tab', { name, exact: true });
        await expect(tab.locator('svg[aria-hidden=true]')).toHaveCount(1);
    }
    const driver = dialog.getByRole('combobox', { name: '接続方式', exact: true });
    const permissions = dialog.getByText('マイクのアクセス許可を確認する', { exact: true });
    const tuning = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '接続方式・音切れの設定' }) }).first();
    await expect(tuning).not.toHaveAttribute('open', '');
    await tuning.locator('summary').click();
    await driver.scrollIntoViewIfNeeded();
    await expect(driver).toBeInViewport();
    await expect(permissions).not.toBeInViewport();
    await dialog.getByRole('tab', { name: '音づくり', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '声を整える', exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: '声を整える機能の処理内容', exact: true }).click();
    const help = page.getByRole('dialog', { name: '声を整える機能の処理内容', exact: true });
    await expect(help).toContainText('低音の整理');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sound-settings.png') });
});

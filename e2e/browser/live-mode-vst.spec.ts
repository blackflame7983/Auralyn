import { test, expect } from './tauriFixture';

test.use({ liveHome: true, registeredModes: true, builtinEnabled: true });
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        const writes: any[] = [];
        let profiles: any = {};
        let version = '1';
        let transaction: any = null;
        let settled = false;
        let recovering = false;
        (window as any).__issue151 = {
            writes,
            finish: () => { transaction = null; settled = !recovering; (window as any).__e2eEmit('live-modes-invalidated', null); },
            fail: (needsRecovery: boolean) => { transaction = { id: 'test', phase: needsRecovery ? 'recovery_required' : 'failed', target: 'singing', error: 'VSTの復元に失敗しました', recoveryAvailable: needsRecovery }; (window as any).__e2eEmit('live-modes-invalidated', null); },
        };
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
            if (command === 'list_profiles') return [
                { name: '歌用VST', hasPlugins: true, isBackup: false },
                { name: 'VSTなしの構成', hasPlugins: true, isBackup: false },
                { name: '機器のみ', hasPlugins: false, isBackup: false },
            ];
            if (command !== 'live_modes') return original(command, args);
            const request = args.request;
            if (request.action === 'bind_profile') {
                if (request.expectedVersion !== version) throw new Error('version changed');
                profiles = { ...profiles, [request.mode]: request.name ? { name: request.name, revision: 'a'.repeat(64) } : null };
                version = String(Number(version) + 1); writes.push(request);
            } else if (request.action === 'singing_on' || request.action === 'talk_on') {
                transaction = { id: 'test', phase: 'loading', target: request.action === 'singing_on' ? 'singing' : 'talk', error: null, recoveryAvailable: false };
                writes.push(request);
            } else if (request.action === 'recover') {
                recovering = true;
                transaction = { ...transaction, phase: 'restoring', recoveryAvailable: false }; writes.push(request);
            } else if (request.action !== 'snapshot') return original(command, args);
            const value = await original('live_modes', { request: { action: 'snapshot' } });
            return { ...value, definitions: { ...value.definitions, version, profiles }, transaction,
                phase: settled ? 'settled' : 'custom', target: settled ? 'singing' : null, applied: settled ? 'singing' : null };
        };
    });
});

test('登録したVST構成で切替を始め、進行中は二重操作を防ぎ完了後に再開できる', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    const modes = page.locator('#live-mode-settings');
    const select = modes.getByLabel('歌唱モードの VST プロファイル', { exact: true });
    await expect(select.locator('option')).toHaveCount(3);
    await select.selectOption('歌用VST');
    await expect(modes).toContainText('切替中は音が止まります');
    await modes.getByRole('button', { name: '歌唱モードの関連付けを保存', exact: true }).click();
    await expect(modes).toContainText('現在の関連付け: 歌用VST');
    await page.keyboard.press('Escape');
    const singing = page.getByRole('button', { name: '歌唱モード', exact: true });
    await singing.click();
    await expect(singing).toBeDisabled();
    await expect(page.getByText('VST と内蔵設定を切替中です。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '緊急ミュート', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('switching.png') });
    await page.evaluate(() => (window as any).__issue151.finish());
    await expect(singing).toBeEnabled();
    await expect(singing).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as any).__issue151.writes.map((item: any) => item.action))).toEqual(['bind_profile', 'singing_on']);
});

test('復旧が必要な失敗では通常切替を止め、明示復旧の完了まで再開しない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toBeHidden();
    await page.evaluate(() => (window as any).__issue151.fail(true));
    const singing = page.getByRole('button', { name: '歌唱モード', exact: true });
    await expect(singing).toBeDisabled();
    const recover = page.getByRole('button', { name: '以前の状態を復旧する', exact: true });
    await expect(recover).toBeVisible();
    await recover.press('Enter');
    await expect(page.getByText('以前の状態を復旧中です。', { exact: true })).toBeVisible();
    await expect(singing).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('recovery.png') });
    await page.evaluate(() => (window as any).__issue151.finish());
    await expect(singing).toBeEnabled();
    await expect(singing).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => (window as any).__issue151.writes.map((item: any) => item.action))).toEqual(['recover']);
});

test('元の状態へ戻せた失敗は警告を残しつつ再試行できる', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toBeHidden();
    await page.evaluate(() => (window as any).__issue151.fail(false));
    const singing = page.getByRole('button', { name: '歌唱モード', exact: true });
    await expect(singing).toBeEnabled();
    await expect(page.getByRole('button', { name: '以前の状態を復旧する', exact: true })).toHaveCount(0);
    await singing.click();
    await expect(singing).toBeDisabled();
});

import { test, expect } from './tauriFixture';

for (const [matches, running] of [[true, true], [false, true], [true, false]]) test(`プロセス入力の選択一致=${matches}・開始済み=${running}の差分を900×600で確認する`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(({ matches, running }) => {
        localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_tutorial_completed', 'true');
        const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
        (window as any).__processSaves = [];
        internal.invoke = async (command: string, args: any) => {
            if (command !== 'broadcast_bundle') return original(command, args);
            switch (args.request.action) {
                case 'list': return { type: 'names', value: ['process'] };
                case 'history': return { type: 'result', value: null };
                case 'recovery_status': return { type: 'recovery', value: null };
                case 'save': (window as any).__processSaves.push(args.request); return { type: 'saved' };
                case 'preview': return { type: 'preview', value: { id: 'process-1', name: 'process', revision: '1', categories: ['入出力・音量'], running, auralyn: [], obs: [], process: {
                    before: null, after: { version: 1, source: { appKey: 'a'.repeat(64), appName: 'fixture-player.exe', rawEndpointId: 'fixture-raw-output-endpoint', purpose: 'voice' }, outputId: 'wasapi:fixture-monitor-output' }, selectionMatches: matches, missingDevices: [], missingPlugins: [],
                } } };
                default: return original(command, args);
            }
        };
    }, { matches, running });
    await page.goto('/');
    const rack = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
    await page.getByRole('button', { name: '設定の保存・復帰', exact: true }).click();
    await page.getByRole('button', { name: '今の設定を保存・復帰', exact: true }).click();
    await page.getByRole('radio', { name: /アプリ入力/ }).check();
    await expect(page.getByRole('radio', { name: /歌／雑談モードまで/ })).not.toBeChecked();
    await page.getByLabel('OBS込みプロファイル名', { exact: true }).fill('new-process');
    await page.getByRole('button', { name: '現在のOBS込みプロファイルを保存', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__processSaves.length)).toBe(1);
    const saved = await page.evaluate(() => (window as any).__processSaves[0]);
    expect(saved.includeProcess).toBe(true); expect(saved.includeOutput).toBeUndefined(); expect(saved.includeLive).toBeUndefined();
    await page.getByRole('combobox', { name: '保存済みOBS込みプロファイル', exact: true }).selectOption('process');
    await page.getByRole('button', { name: '変更予定を確認', exact: true }).click();
    const diff = page.getByRole('region', { name: 'プロセス入力の差分', exact: true });
    await expect(diff).toContainText('fixture-player.exe'); await expect(diff).toContainText('fixture-raw-output-endpoint');
    await expect(diff).toContainText('PID');
    const apply = page.getByRole('button', { name: 'この変更予定を適用する', exact: true });
    await apply.scrollIntoViewIfNeeded();
    if (matches && running) { await expect(apply).toBeEnabled(); await apply.focus(); await expect(apply).toBeFocused(); }
    else { await expect(apply).toBeDisabled(); await expect(diff.getByRole('alert')).toContainText('明示選択'); }
    const box = await apply.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: info.outputPath('process-differences.png') });
});

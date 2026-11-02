import { test, expect } from './tauriFixture';

test('分離出力は明示保存し、狭い画面でも両枝の差分と再起動を確認する', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
        (window as any).__outputSaves = [];
        internal.invoke = async (command: string, args: any) => {
            if (command !== 'broadcast_bundle') return original(command, args);
            switch (args.request.action) {
                case 'list': return { type: 'names', value: ['output'] };
                case 'history': return { type: 'result', value: null };
                case 'recovery_status': return { type: 'recovery', value: null };
                case 'save': (window as any).__outputSaves.push(args.request); return { type: 'saved' };
                case 'preview': return { type: 'preview', value: { id: 'out-1', name: 'output', revision: '1', categories: ['入出力・音量'], running: true, auralyn: [], obs: [], output: {
                    before: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false },
                    after: { deviceId: 'wasapi:fixture-broadcast-output', monitorTrim: 0, broadcastTrim: 0.5, monitorMuted: true, splitProcessing: true,
                        monitorSinging: { active: true, preset: 'singing', amount: 0.6, singing: { lowCutHz: 90, dynamics: 0.4, brightnessDb: 1 }, reverb: { enabled: false, mix: 0.1, decaySeconds: 1.2, damping: 0.6 } }, monitorTalk: null },
                    restartRequired: true, missingDevices: [], missingPlugins: [],
                } } };
                default: return original(command, args);
            }
        };
    });
    await page.goto('/');
    const rack = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
    await page.getByRole('button', { name: 'プロファイル管理', exact: true }).click();
    await page.getByRole('button', { name: 'OBS込みプロファイル', exact: true }).click();
    await page.getByRole('checkbox', { name: '分離出力・枝別処理の設定も保存する', exact: true }).check();
    await page.getByLabel('OBS込みプロファイル名', { exact: true }).fill('new-output');
    await page.getByRole('button', { name: '現在のOBS込みプロファイルを保存', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__outputSaves.length)).toBe(1);
    const request = await page.evaluate(() => (window as any).__outputSaves[0]);
    expect(request.includeOutput).toBe(true);
    expect(request.categories).toEqual({ includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true });
    await page.getByRole('combobox', { name: '保存済みOBS込みプロファイル', exact: true }).selectOption('output');
    await page.getByRole('button', { name: '変更予定を確認', exact: true }).click();
    const diff = page.getByRole('region', { name: '分離出力の差分', exact: true });
    await expect(diff).toContainText('音声を再起動し、VSTを読み直します');
    await expect(diff).toContainText('wasapi:fixture-broadcast-output');
    await expect(diff).toContainText('自分用のtrim');
    await expect(diff).toContainText('配信用のtrim');
    await expect(diff).toContainText('90 Hz');
    const apply = page.getByRole('button', { name: 'この変更予定を適用する', exact: true });
    await apply.scrollIntoViewIfNeeded();
    await apply.focus();
    await expect(apply).toBeFocused();
    const box = await apply.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: info.outputPath('output-differences.png') });
});

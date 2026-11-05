import { test, expect } from './tauriFixture';

// VST パネルは設定済みのホームにだけ出る。未設定のホームは音の流れと次の1歩だけにする（#297）。
test.use({ liveHome: true });

for (const liveModes of [false, true]) test(`分離出力と本番モード=${liveModes}を明示保存し、狭い画面で差分を確認する`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(liveModes => {
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
                case 'preview': return { type: 'preview', value: { id: 'out-1', name: 'output', revision: '1', categories: ['入出力・音量'], running: true, auralyn: [], obs: [], ...(liveModes ? { live: { before: null, after: { definitions: { schemaVersion: 1, version: '2', singing: { active: false, preset: 'broadcast', amount: 0.6 }, talk: null, profiles: { singing: { name: '歌向けTDR Nova', revision: 'a'.repeat(64) } } }, target: 'singing', monitor: null, singingPlugins: 1, talkPlugins: null } } } : {}), output: {
                    before: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false },
                    after: { deviceId: 'wasapi:fixture-broadcast-output', monitorTrim: 0, broadcastTrim: 0.5, monitorMuted: true, splitProcessing: true,
                        monitorSinging: { active: true, preset: 'singing', amount: 0.6, singing: { lowCutHz: 90, dynamics: 0.4, brightnessDb: 1 }, reverb: { enabled: false, mix: 0.1, decaySeconds: 1.2, damping: 0.6 } }, monitorTalk: null },
                    beforeDeviceName: null, afterDeviceName: '配信用ケーブル', restartRequired: true, missingDevices: [], missingPlugins: [],
                } } };
                default: return original(command, args);
            }
        };
    }, liveModes);
    await page.goto('/');
    const rack = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
    await page.getByRole('button', { name: '設定の保存・復帰', exact: true }).click();
    await page.getByRole('button', { name: '今の設定を保存・復帰', exact: true }).click();
    await page.getByRole('radio', { name: /分離出力まで/ }).check();
    if (liveModes) await page.getByRole('radio', { name: /歌／雑談モードまで/ }).check();
    await page.getByLabel('OBS込みプロファイル名', { exact: true }).fill('new-output');
    await page.getByRole('button', { name: '現在のOBS込みプロファイルを保存', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__outputSaves.length)).toBe(1);
    const request = await page.evaluate(() => (window as any).__outputSaves[0]);
    expect(request.includeOutput).toBe(true);
    expect(request.includeLive === true).toBe(liveModes);
    expect(request.categories).toEqual({ includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true });
    await page.getByRole('combobox', { name: '保存済みOBS込みプロファイル', exact: true }).selectOption('output');
    await page.getByRole('button', { name: '変更予定を確認', exact: true }).click();
    const diff = page.getByRole('region', { name: '分離出力の差分', exact: true });
    await expect(diff).toContainText('音声を再起動し、VSTを読み直します');
    await expect(diff).toContainText('配信用ケーブル');
    await expect(diff).not.toContainText('wasapi:fixture-broadcast-output');
    await expect(diff).toContainText('自分用の音量');
    await expect(diff).toContainText('配信用の音量');
    await expect(diff).toContainText('90 Hz');
    if (liveModes) { const modeDiff = page.getByRole('region', { name: '歌／雑談モードの差分', exact: true }); await expect(modeDiff).toContainText('歌向けTDR Nova'); await expect(modeDiff).toContainText('VST 1件'); await expect(modeDiff).toContainText('全体ミュートを維持'); }
    const apply = page.getByRole('button', { name: 'この変更予定を適用する', exact: true });
    await apply.scrollIntoViewIfNeeded();
    await apply.focus();
    await expect(apply).toBeFocused();
    const box = await apply.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: info.outputPath('output-differences.png') });
});

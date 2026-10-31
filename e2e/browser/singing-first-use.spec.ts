import { test, expect } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';

test.use({ liveHome: true, registeredModes: true, builtinEnabled: true });
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_theme', 'dark');
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        const actions: string[] = [];
        Object.assign(window, { __singingActions: actions });
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
            if (command === 'builtin_effects') actions.push(args.request.action);
            if (command === 'stop_voice_check') return Promise.resolve();
            if (command === 'voice_check_preview') {
                const request = args.request;
                actions.push(`preview:${request.action}`);
                if (!['open', 'status', 'close'].includes(request.action)) throw new Error('録音・再生はこの画面試験の対象外');
                return Promise.resolve({ epoch: 'preview', sessionId: request.sessionId, operationId: request.operationId,
                    recordingId: null, state: request.action === 'close' ? 'closed' : 'idle', positionMs: 0, durationMs: 0,
                    source: 'processed', loopPlayback: false, levelMatch: false, levelMatchAvailable: false,
                    metadata: null, recordingStale: false, devices: [], error: null, owner: null, conflict: null,
                    levelMatchAttenuationDb: [0, 0], safetyAttenuationDb: 0, candidate: null });
            }
            return original(command, args);
        };
    });
});

test('初回は準備・試聴・適用を見せ、数値を開いた編集も試聴の往復も配信へ適用しない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    await page.getByRole('button', { name: '歌唱モードの音を調整', exact: true }).click();
    const section = page.locator('#singing-settings');
    const fine = section.locator('details').filter({ has: page.locator('summary', { hasText: '数値を細かく調整' }) });
    await expect(fine).not.toHaveAttribute('open');
    await expect(section.getByRole('button', { name: '試しに聴く', exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'この音をマイクへ適用', exact: true })).toBeDisabled();
    await section.getByRole('button', { name: '歌向けの音から始める', exact: true }).click();
    await expect(section).toContainText('適用するまで配信・通話へ反映しません');
    await page.screenshot({ path: testInfo.outputPath('guided-960x640.png') });
    await fine.locator('summary').press('Enter');
    await fine.getByRole('spinbutton', { name: '低音の整理（Hz）', exact: true }).fill('130');
    await fine.locator('summary').press('Enter');
    await section.getByRole('button', { name: '試しに聴く', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'ボイスチェック', exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__singingActions.includes('preview:open'))).toBe(true);
    await preview.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(section.locator(':scope > summary')).toBeFocused();
    await expect(section).toHaveAttribute('open', '');
    await fine.locator('summary').press('Enter');
    await expect(fine.getByRole('spinbutton', { name: '低音の整理（Hz）', exact: true })).toHaveValue('130');
    expect(await page.evaluate(() => (window as any).__singingActions.filter((s: string) => !s.startsWith('preview:')))).toEqual(expect.arrayContaining(['snapshot']));
    expect(await page.evaluate(() => (window as any).__singingActions.includes('apply'))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('details-after-preview-960x640.png') });
});

test('反映エラーは次の操作を示し、技術詳細は必要時に開く', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            const value = await original(command, args);
            return command === 'builtin_effects' ? { ...value, error: 'engine revision mismatch (raw)' } : value;
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    await page.getByRole('button', { name: '歌唱モードの音を調整', exact: true }).click();
    const section = page.locator('#singing-settings');
    await expect(section.getByRole('alert')).toContainText('現在値を再取得');
    await expect(section.getByText('engine revision mismatch (raw)', { exact: true })).not.toBeVisible();
    await expect(section.getByRole('button', { name: '内蔵ボイスチェーンの現在値を再取得', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('actionable-error.png') });
});

test('登録・歌向け欄・プロファイルで同じ保存先の比較を開け、説明の開閉では登録も保存もしない', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await page.getByRole('button', { name: '歌・雑談の登録を編集', exact: true }).click();
    const label = 'モード登録とプロファイル保存の違い';
    const modeHelp = page.locator('#live-mode-settings').getByRole('button', { name: label, exact: true });
    await modeHelp.press('Enter');
    const help = page.getByRole('dialog', { name: label, exact: true });
    await expect(help).toContainText('配信中の切替');
    await expect(help).toContainText('機器や音量も対象');
    const comparison = (await help.textContent())!;
    await page.screenshot({ path: testInfo.outputPath('mode-save-comparison.png') });
    await page.keyboard.press('Escape');
    await expect(modeHelp).toBeFocused();
    await page.getByRole('button', { name: '歌唱モードの音を調整', exact: true }).click();
    const section = page.locator('#singing-settings');
    await section.getByText('再取得・下書きのリセット・保存', { exact: true }).click();
    await section.getByRole('button', { name: label, exact: true }).click();
    await expect(help).toHaveText(comparison);
    await page.keyboard.press('Escape');
    await section.getByRole('button', { name: '適用済み設定をプロファイルへ保存', exact: true }).click();
    await expect(page.locator('input[id^="save-"]')).toHaveCount(4);
    const categories = () => page.locator('input[id^="save-"]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).checked));
    const before = await categories();
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(help).toHaveText(comparison);
    await expect(help).toContainText('未適用の下書き・試聴候補');
    await page.screenshot({ path: testInfo.outputPath('profile-save-comparison.png') });
    await page.keyboard.press('Escape');
    expect(await categories()).toEqual(before);
    expect(await page.evaluate(() => (window as any).__e2eModeWrites)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__singingActions.includes('apply'))).toBe(false);
});

for (const locale of ['ja', 'en'] as const) test(`6つの数値の説明は値を変更せずEscapeで隣へ戻る（${locale}）`, async ({ page }, testInfo) => {
    const t = (key: MessageKey) => message(locale, key);
    await page.addInitScript(locale => localStorage.setItem('vst_host_locale', locale), locale);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await page.getByRole('button', { name: t('liveBar.editRegistration'), exact: true }).click();
    await page.getByRole('button', { name: message(locale, 'settings.mode.adjustNamed', { mode: t('settings.LiveModeControls.212') }), exact: true }).click();
    const section = page.locator('#singing-settings');
    await section.getByRole('button', { name: t('settings.SingingControls.405'), exact: true }).click();
    await section.getByText(t('singing.fineTune'), { exact: true }).press('Enter');
    const values = () => section.getByRole('spinbutton').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
    const before = await values();
    for (const [labelKey, helpKey] of [
        ['settings.SingingControls.407', 'singing.help.lowCutHz'], ['settings.SingingControls.408', 'singing.help.dynamics'],
        ['settings.SingingControls.409', 'singing.help.brightnessDb'], ['settings.SingingControls.416', 'singing.help.mix'],
        ['settings.SingingControls.417', 'singing.help.decaySeconds'], ['settings.SingingControls.418', 'singing.help.damping'],
    ] as const) {
        const label = message(locale, 'singing.valueHelp', { name: t(labelKey) });
        const trigger = section.getByRole('button', { name: label, exact: true });
        await trigger.press('Enter');
        const help = page.getByRole('dialog', { name: label, exact: true });
        await expect(help).toContainText(t(helpKey));
        await expect(help).toContainText(t('singing.help.listen'));
        const bounds = (await help.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
        if (helpKey === 'singing.help.damping') await page.screenshot({ path: testInfo.outputPath('damping-meaning.png') });
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
    }
    expect(await values()).toEqual(before);
    expect(await page.evaluate(() => (window as any).__singingActions.includes('apply'))).toBe(false);
    await expect(section.getByRole('button', { name: t('settings.SingingControls.427'), exact: true })).toBeEnabled();
});

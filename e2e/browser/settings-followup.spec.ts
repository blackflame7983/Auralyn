import { test, expect } from './tauriFixture';
import { message } from '../../src/i18n/messages';

for (const locale of ['ja', 'en'] as const) {
    // 機器選択と設定復帰は両言語・代表テーマで検証する。
    // 色・拡大時の配置は後段で3テーマとも確認する。
    const theme = 'light';
    test(`既定機器と保存がない初回設定は選択を促す ${locale} ${theme}`, async ({ page }, info) => {
        await page.addInitScript(({ locale, theme }) => {
            localStorage.setItem('vst_host_locale', locale); localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_wizard_done', 'true');
            const invoke = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                if (command === 'get_audio_devices') {
                    const mic = { host: 'Wasapi', name: 'Microphone choice', id: 'mic', channels: 2, index: 0, is_input: true, is_default: false };
                    return { inputs: [mic], outputs: [{ ...mic, name: 'Output choice', id: 'out', is_input: false }] };
                }
                return invoke(command, args);
            };
        }, { locale, theme });
        await page.goto('/');
        await expect(page.getByText(message(locale, 'app.initializing'), { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: message(locale, 'header.audioSettingsOpen'), exact: true }).click();
        const dialog = page.getByRole('dialog', { name: message(locale, 'common.settings'), exact: true });
        const input = dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.039'), exact: true });
        const output = dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.042'), exact: true });
        await expect(input).toHaveValue(''); await expect(output).toHaveValue('');
        await expect(dialog.getByText(message(locale, 'settings.connection.firstStartHint'), { exact: true })).toBeVisible();
        const save = dialog.getByRole('button', { name: message(locale, 'settings.AudioSettingsModal.197'), exact: true });
        await expect(save).toBeDisabled();
        await expect(dialog.getByRole('button', { name: message(locale, 'settings.connection.restoreSaved'), exact: true })).toHaveCount(0);
        await expect(dialog.getByText(message(locale, 'settings.connection.restoreHint'), { exact: true })).toHaveCount(0);
        await input.selectOption('id:mic'); await output.selectOption('id:out');
        await expect(save).toBeEnabled();
        await expect(dialog.getByText(message(locale, 'settings.connection.firstStart', { host: 'WASAPI', input: 'Microphone choice', output: 'Output choice' }), { exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath('explicit-device-selection.png'), animations: 'disabled' });
    });

    test(`WebView保存がなくても正常設定を復帰し開始失敗後も保持 ${locale} ${theme}`, async ({ page }, info) => {
        await page.addInitScript(({ locale, theme }) => {
            localStorage.setItem('vst_host_locale', locale); localStorage.setItem('vst_host_theme', theme);
            const invoke = (window as any).__TAURI_INTERNALS__.invoke;
            const asio = { host: 'ASIO', name: 'Saved ASIO', id: 'asio:saved', channels: 22, index: 0, is_input: true, is_default: false };
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                if (command === 'get_saved_audio_config') return { host: 'ASIO', input: asio.name, output: asio.name,
                    input_id: asio.id, output_id: asio.id, sample_rate: 96000, buffer_size: 512,
                    routing: { inputChannels: [6, 7], outputRouting: { mode: 'insert' } } };
                if (command === 'get_audio_devices') return { inputs: [asio], outputs: [{ ...asio, is_input: false }] };
                return invoke(command, args);
            };
            (window as any).__e2eStartFailure = true;
        }, { locale, theme });
        await page.goto('/');
        const dialog = page.getByRole('dialog', { name: message(locale, 'common.settings'), exact: true });
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('dialog', { name: message(locale, 'wizard.title'), exact: true })).toHaveCount(0);
        const input = dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.039'), exact: true });
        await expect(input).toHaveValue('id:asio:saved');
        await expect(dialog.getByText(message(locale, 'settings.AudioSettingsModal.044'), { exact: true })).toBeVisible();
        const save = dialog.getByRole('button', { name: message(locale, 'settings.AudioSettingsModal.197'), exact: true });
        await expect(save).toBeEnabled(); await save.click();
        await expect(dialog.getByText(message(locale, 'settings.AudioSettingsModal.017', { arg0: 'Error: テスト用：機器が見つかりません' }), { exact: true })).toBeVisible();
        expect(await page.evaluate(() => (window as any).__e2eStarts)).toHaveLength(1);
        expect(await page.evaluate(() => localStorage.getItem('vst_host_audio_config'))).toBeNull();
        await page.reload(); await expect(dialog).toBeVisible(); await expect(input).toHaveValue('id:asio:saved');
        await page.screenshot({ path: info.outputPath('native-saved-recovered.png'), animations: 'disabled' });
        expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
    });

}

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark', 'gaming']) {
    test(`未設定の既定方式・変更予定・ASIO案内 ${locale} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(({ locale, theme }) => {
            localStorage.setItem('vst_host_locale', locale); localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('auralyn_vst_panel_open', 'false');
            const invoke = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                if (command === 'get_saved_audio_config') return (window as any).__e2eSavedAudioAvailable
                    ? { host: 'WASAPI', input: 'Test microphone', output: 'Test headphones', input_id: 'mic', output_id: 'headphones', sample_rate: 48000, buffer_size: 256 } : null;
                if (command === 'get_audio_devices') {
                    const asio = { host: 'ASIO', name: 'Test ASIO', id: 'asio:test', channels: 4, is_input: true, is_default: false, index: 0 };
                    const mic = { ...asio, host: 'Wasapi', name: 'Test microphone', id: 'mic', channels: 2, is_default: true };
                    const output = { ...mic, name: 'Test headphones', id: 'headphones', is_input: false };
                    return { inputs: [asio, { ...mic, name: '再生リダイレクト', id: 'playback', is_default: false }, mic],
                        outputs: [{ ...asio, is_input: false }, { ...output, name: 'Voicemeeter In 2', id: 'virtual', is_default: false }, output] };
                }
                return invoke(command, args);
            };
        }, { locale, theme });
        await page.goto('/');
        await expect(page.getByText(message(locale, 'app.initializing'), { exact: true })).toHaveCount(0);
        const unconfigured = page.getByRole('banner').getByRole('status').filter({ hasText: message(locale, 'shell.unconfigured') });
        await expect(unconfigured).toBeVisible();
        await expect(unconfigured.locator('..').locator('[aria-hidden=true]')).toHaveClass(/bg-muted-foreground/);
        await page.getByRole('button', { name: message(locale, 'header.audioSettingsOpen'), exact: true }).click();
        await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
        const dialog = page.getByRole('dialog', { name: message(locale, 'common.settings'), exact: true });
        const changes = dialog.locator('#settings-connection-changes');
        await expect(changes).toContainText(message(locale, 'settings.connection.firstStart', { host: 'WASAPI', input: 'Test microphone', output: 'Test headphones' }));
        await expect(changes).not.toContainText(message(locale, 'settings.connection.changes', { fields: '' }));
        const source = dialog.getByRole('combobox', { name: message(locale, 'processInput.source'), exact: true });
        await expect(source.locator('option[value=process]')).toBeEnabled();
        await dialog.locator('summary').filter({ hasText: message(locale, 'settings.audioTuning.title') }).click();
        await expect(dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.035'), exact: true })).toHaveValue('Wasapi');
        await expect(dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.039'), exact: true })).toHaveValue('id:mic');
        await expect(dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.042'), exact: true })).toHaveValue('id:headphones');
        await expect(dialog.getByRole('button', { name: message(locale, 'settings.connection.restoreSaved'), exact: true })).toHaveCount(0);
        await expect(dialog.getByText(message(locale, 'settings.connection.restoreHint'), { exact: true })).toHaveCount(0);
        await dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.035'), exact: true }).selectOption('ASIO');
        const input = dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.039'), exact: true });
        await expect(input.locator('..').getByText(message(locale, 'settings.AudioSettingsModal.044'), { exact: true })).toBeVisible();
        await expect(input.locator('..').getByText(message(locale, 'settings.MicrophonePermissionGuide.238'), { exact: true })).toBeVisible();
        await input.evaluate(el => el.scrollIntoView({ block: 'start' }));
        expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath('asio-near-device.png'), animations: 'disabled' });
        await page.evaluate(() => { (window as any).__e2eSavedAudioAvailable = true; });
        await dialog.getByRole('button', { name: message(locale, 'settings.close'), exact: true }).click();
        await page.getByRole('button', { name: message(locale, 'header.audioSettingsOpen'), exact: true }).click();
        const restore = dialog.getByRole('button', { name: message(locale, 'settings.connection.restoreSaved'), exact: true });
        await expect(restore).toBeVisible();
        expect(await input.evaluate((el, label) => !!(el.compareDocumentPosition([...document.querySelectorAll('button')].find(button => button.textContent === label)!) & Node.DOCUMENT_POSITION_FOLLOWING), message(locale, 'settings.connection.restoreSaved'))).toBe(true);
        await restore.click();
        await expect(dialog.getByText(message(locale, 'settings.connection.restored'), { exact: true })).toBeVisible();
        const tuning = dialog.locator('summary').filter({ hasText: message(locale, 'settings.audioTuning.title') });
        if (await tuning.locator('..').getAttribute('open') === null) await tuning.click();
        await expect(dialog.getByRole('combobox', { name: message(locale, 'settings.AudioSettingsModal.035'), exact: true })).toHaveValue('Wasapi');
        expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
    });

    test(`送り先4択と入力未選択の次へ ${locale} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(({ locale, theme }) => {
            localStorage.setItem('vst_host_locale', locale); localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            const invoke = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                if (command === 'get_audio_devices') {
                    const input = { host: 'WASAPI', name: 'Input one', channels: 2, is_input: true, is_default: false, index: 0 };
                    return { inputs: [input, { ...input, name: 'Input two', index: 1 }], outputs: [{ ...input, name: 'Test headphones', is_input: false, is_default: true }] };
                }
                return invoke(command, args);
            };
        }, { locale, theme });
        await page.goto('/');
        const wizard = page.getByRole('dialog', { name: message(locale, 'wizard.title'), exact: true });
        await expect(wizard).toBeVisible();
        await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
        const labels = ['prep.obs', 'prep.call', 'prep.local', 'prep.other'] as const;
        for (const label of labels) await expect(wizard.getByRole('button', { name: message(locale, label), exact: true })).toBeVisible();
        // 送り先は OBS・通話・自分で聴く・その他の順に並べる（#304）。
        const order = await wizard.locator('.setup-choice').evaluateAll(cards => cards.map(card => card.getAttribute('aria-label') ?? card.querySelector('.font-semibold, h3, strong')?.textContent ?? card.textContent));
        expect(order.map(text => labels.findIndex(label => text?.startsWith(message(locale, label))))).toEqual([0, 1, 2, 3]);
        await page.screenshot({ path: info.outputPath('destinations.png'), animations: 'disabled' });
        await wizard.getByRole('button', { name: message(locale, 'prep.obs'), exact: true }).click();
        const next = wizard.getByRole('button', { name: message(locale, 'common.next'), exact: true });
        await expect(next).toBeDisabled();
        await expect(wizard.getByText(message(locale, 'wizard.selectMicToContinue'), { exact: true })).toBeVisible();
        const disabledColor = await next.evaluate(el => getComputedStyle(el).backgroundColor);
        await page.screenshot({ path: info.outputPath('next-disabled.png'), animations: 'disabled' });
        const input = wizard.getByRole('combobox', { name: message(locale, 'guide.copy.189'), exact: true });
        await expect(input.locator('..').locator('..').getByText(message(locale, 'settings.MicrophonePermissionGuide.238'), { exact: true })).toBeVisible();
        await input.selectOption('Input one'); await expect(next).toBeEnabled();
        await expect.poll(() => next.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(disabledColor);
        await wizard.getByRole('button', { name: message(locale, 'common.back'), exact: true }).click();
        await wizard.getByRole('button', { name: message(locale, 'wizard.skip'), exact: true }).click();
        // 未設定のホームは送り先の選択を並べず、音の流れと次の1歩だけを出す（#297）。
        await expect(page.getByRole('radiogroup', { name: message(locale, 'prep.usage'), exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: message(locale, 'unsetFlow.chooseDestination'), exact: true })).toBeVisible();
    });
}

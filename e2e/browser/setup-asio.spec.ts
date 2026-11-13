import { message } from '../../src/i18n/messages';
import { test, expect } from './tauriFixture';
import { expectFieldDescriptionBelow } from './fieldDescription';

// セットアップだけで ASIO 機器を選び、音の確認まで終えられる（#291）。
test('セットアップで ASIO を選び、同じ機器のチャンネルで音を確認する', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            if (command === 'get_audio_devices') {
                const listed = await original(command, args);
                const asio = { host: 'ASIO', name: 'Test ASIO', id: 'asio:test', channels: 8, index: 0, is_default: false };
                return { inputs: [...listed.inputs, { ...asio, is_input: true }], outputs: [...listed.outputs, { ...asio, is_input: false }] };
            }
            return original(command, args);
        };
    });
    await page.goto('/');
    const wizard = page.getByRole('dialog');
    await wizard.getByRole('radio', { name: 'OBSで配信' }).click();
    await wizard.getByRole('radio', { name: 'ASIO（オーディオインターフェース）' }).check();
    await expect(wizard.getByRole('combobox', { name: '機器' })).toHaveValue('Test ASIO');
    await page.screenshot({ path: info.outputPath('setup-asio-input.png') });
    await wizard.getByRole('button', { name: /次へ/ }).click();
    await wizard.getByRole('combobox', { name: '入力チャンネル' }).selectOption('2,3');
    await wizard.getByRole('combobox', { name: '出力チャンネル' }).selectOption('4,5');
    await page.screenshot({ path: info.outputPath('setup-asio-output.png') });
    await wizard.getByRole('button', { name: /次へ/ }).click();
    await wizard.getByRole('button', { name: 'マイクの音を流して確認' }).click();
    await expect(wizard.getByRole('button', { name: 'マイクの確認を停止' })).toBeVisible();
    const starts = await page.evaluate(() => (window as any).__e2eStarts);
    expect(starts.at(-1)).toMatchObject({ host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO',
        channelRouting: { inputChannels: [2, 3], outputRouting: { mode: 'independent', channels: [4, 5] } } });
});

for (const locale of ['ja', 'en'] as const) {
    test(`ASIOの入出力の注意が機器直下で読める ${locale} 900×600 150%`, async ({ page }, info) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(locale => {
            localStorage.setItem('vst_host_locale', locale);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO', sampleRate: 48000, bufferSize: 512 }));
            const original = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                if (command === 'get_audio_devices') {
                    const device = { host: 'ASIO', name: 'Test ASIO', channels: 8, index: 0, is_default: true };
                    return { inputs: [{ ...device, is_input: true }], outputs: [{ ...device, is_input: false }] };
                }
                return original(command, args);
            };
        }, locale);
        await page.goto('/');
        await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
        await page.getByRole('button', { name: message(locale, 'rail.connectName'), exact: true }).click();
        const dialog = page.locator('[data-settings-page]');
        const device = dialog.getByRole('combobox', { name: message(locale, 'guide.copy.188'), exact: true });
        const note = dialog.getByText(message(locale, 'settings.AudioSettingsModal.044'), { exact: true });
        await expectFieldDescriptionBelow(device, note);
        await page.screenshot({ path: info.outputPath('asio-note-150.png') });
    });
}

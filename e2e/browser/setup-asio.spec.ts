import { test, expect } from './tauriFixture';

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
    await wizard.getByRole('button', { name: 'OBSで配信' }).click();
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

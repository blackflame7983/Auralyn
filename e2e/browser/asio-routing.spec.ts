import { test, expect } from './tauriFixture';

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(() => {
        const saved = { host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO', inputId: 'asio:test', outputId: 'asio:test',
            sampleRate: 48000, bufferSize: 512, inputChannels: [6, 7] };
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify(saved));
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let latest: any;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            if (command === 'live_output') return { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
            if (command === 'set_channel_scan') return;
            if (command === 'get_audio_devices') {
                const device = { host: 'ASIO', name: 'Test ASIO', id: 'asio:test', channels: 8, index: 0, is_default: false };
                return { inputs: [{ ...device, is_input: true }], outputs: [{ ...device, is_input: false }] };
            }
            if (command === 'get_audio_state') return { is_running: true, config: {
                host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO', input_id: 'asio:test', output_id: 'asio:test',
                sample_rate: 48000, buffer_size: 512, routing: latest?.channelRouting,
            } };
            if (command === 'set_input_channels') throw new Error('開始後に入力ペアを反映してはいけません');
            if (command === 'start_audio') {
                latest = args;
                const result = await original(command, args);
                return { ...result, channels: 8, routing: args.channelRouting };
            }
            return original(command, args);
        };
    });
});

for (const mode of ['independent', 'insert'] as const) {
    test(`入力3/4と${mode}出力を一度の開始で反映し、再表示して復元する`, async ({ page }, info) => {
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        const dialog = page.locator('[data-settings-page]');
        await expect(dialog.getByRole('combobox', { name: '音声の返却方法' })).toHaveValue('legacy');
        await dialog.getByRole('radio', { name: '入力チャンネル 3/4' }).check();
        await dialog.getByRole('combobox', { name: '音声の返却方法' }).selectOption(mode);
        if (mode === 'independent') await expect(dialog.getByRole('combobox', { name: '出力チャンネル' })).toHaveValue('0,1');
        await dialog.getByRole('combobox', { name: '音声の返却方法' }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`asio-${mode}.png`) });
        await dialog.getByRole('button', { name: /保存して(開始|再起動)/ }).click();
        await expect(dialog).toHaveCount(0);
        const expectedOutput = mode === 'independent' ? { mode, channels: [0, 1] } : { mode };
        const starts = await page.evaluate(() => (window as any).__e2eStarts);
        expect(starts).toHaveLength(1);
        expect(starts[0].channelRouting).toEqual({ inputChannels: [2, 3], outputRouting: expectedOutput });
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')!));
        expect(saved.inputChannels).toEqual([2, 3]);
        expect(saved.outputRouting).toEqual(expectedOutput);
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        await expect(dialog.getByRole('radio', { name: '入力チャンネル 3/4' })).toBeChecked();
        await expect(dialog.getByRole('combobox', { name: '音声の返却方法' })).toHaveValue(mode);
    });
}

// ASIO で「アプリの音声」を選べない理由から、畳まれた音質調整の接続方式へ移れる（#290）。
test('アプリの音声を選べない理由から接続方式の選択へ移る', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const dialog = page.locator('[data-settings-page]');
    await expect(dialog.getByRole('option', { name: 'アプリの音声（WASAPI）' })).toHaveJSProperty('disabled', true);
    await expect(dialog.getByRole('combobox', { name: '入力元' })).toHaveAccessibleDescription(/ASIO のため、アプリの音声は選べません/);
    await dialog.getByRole('button', { name: '接続方式を変える', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: '接続方式', exact: true })).toBeFocused();
    await expect(dialog.getByRole('combobox', { name: '接続方式', exact: true })).toBeInViewport();
});

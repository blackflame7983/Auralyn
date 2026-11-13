import { test, expect } from './tauriFixture';

test.use({ liveHome: true });

// 新しい接続で開始できなかったとき、直前の接続へ戻したことと次にやることを示す（#289）。
test('開始に失敗した接続から直前の接続へ戻し、理由と対処を示す', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => {
        const saved = { host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO', inputId: 'asio:test', outputId: 'asio:test', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] };
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify(saved));
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        const calls: any[] = [];
        (window as any).__e2eRollbackStarts = calls;
        // 本物の再起動と同じく、開始に失敗した後は止まった状態を返す。
        let stopped = false;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            if (command === 'set_channel_scan') return;
            if (command === 'get_audio_devices') {
                const device = { host: 'ASIO', name: 'Test ASIO', id: 'asio:test', channels: 8, index: 0, is_default: false };
                return { inputs: [{ ...device, is_input: true }], outputs: [{ ...device, is_input: false }] };
            }
            if (command === 'get_audio_state') return stopped ? { is_running: false, config: null } : { is_running: true, config: {
                host: 'ASIO', input: 'Test ASIO', output: 'Test ASIO', input_id: 'asio:test', output_id: 'asio:test', sample_rate: 48000, buffer_size: 512,
                routing: { inputChannels: [0, 1], outputRouting: { mode: 'legacy' } } } };
            if (command === 'start_audio' || command === 'restart_audio_engine') {
                calls.push({ command, args });
                stopped = true;
                if (args.channelRouting?.inputChannels?.[0] === 2) throw new Error('sample clock or rate cannot be determined');
                stopped = false;
                const result = await original('start_audio', args);
                return { ...result, channels: 8, routing: args.channelRouting };
            }
            return original(command, args);
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    await dialog.getByRole('radio', { name: '入力チャンネル 3/4' }).check();
    await dialog.getByRole('button', { name: /保存して(開始|再起動)/ }).click();
    await expect(dialog.getByText(/直前の接続に戻しました。理由：.*sample clock/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('start-rollback.png') });
    const calls = await page.evaluate(() => (window as any).__e2eRollbackStarts);
    expect(calls.at(-1).args).toMatchObject({ host: 'ASIO', input: 'Test ASIO', channelRouting: { inputChannels: [0, 1] } });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')!));
    expect(saved.inputChannels).toEqual([0, 1]);
});

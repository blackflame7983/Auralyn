import { test, expect } from './tauriFixture';

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', inputId: 'mic',
            output: 'Test headphones', outputId: 'headphones', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] }));
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let current: any = null;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            if (command === 'live_output') return { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
            if (command === 'get_process_input_sources') return [{ id: 'app-1', appKey: 'a'.repeat(64), name: 'chrome.exe',
                routes: [{ id: 'spare', name: '別のスピーカー', muted: true }] }];
            if (command === 'get_audio_state' && current) return { is_running: true, config: { host: current.host,
                input: current.input ?? null, input_id: current.inputId, output: current.output, output_id: current.outputId,
                sample_rate: current.sampleRate, buffer_size: current.bufferSize, input_source: current.inputSource?.source } };
            if (command === 'start_audio') current = args;
            return original(command, args);
        };
    });
});

for (const size of [{ width: 900, height: 600 }, { width: 640, height: 600 }]) {
    test(`アプリを明示選択して保存し、再表示時の再選択と機器入力への復帰を確認する ${size.width}`, async ({ page }, info) => {
        await page.setViewportSize(size);
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '設定', exact: true });
        await dialog.getByRole('combobox', { name: '入力元', exact: true }).selectOption('process');
        await dialog.getByRole('combobox', { name: '再生中のアプリ' }).selectOption('app-1');
        await dialog.getByRole('combobox', { name: '入力の用途' }).focus();
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown');
        await expect(dialog.getByRole('combobox', { name: '入力の用途' })).toHaveValue('music');
        await dialog.getByRole('combobox', { name: '原音の出力先' }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('process-input.png') });
        await dialog.getByRole('button', { name: /保存して(開始|再起動)/ }).click();
        await expect(dialog).toHaveCount(0);
        const starts = await page.evaluate(() => (window as any).__e2eStarts);
        expect(starts[0].input).toBeUndefined();
        expect(starts[0].inputId).toBeUndefined();
        expect(starts[0].inputSource.candidateId).toBe('app-1');
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')!));
        expect(saved.inputSource.kind).toBe('process_loopback');
        expect(saved.inputSource.config.purpose).toBe('music');
        expect(saved.input).toBeUndefined();
        expect(saved.inputId).toBeUndefined();
        expect(saved.candidateId).toBeUndefined();
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        await expect(dialog.getByRole('combobox', { name: '再生中のアプリ' })).toHaveValue('');
        await dialog.getByRole('combobox', { name: '入力元', exact: true }).selectOption('device');
        await expect(dialog.getByRole('option', { name: 'Test microphone', exact: true })).toHaveCount(1);
        await expect(dialog.getByRole('button', { name: /保存して(開始|再起動)/ })).toBeDisabled();
        await dialog.getByRole('combobox', { name: 'マイク', exact: true }).selectOption('id:mic');
        await expect(dialog.getByRole('combobox', { name: '入力の用途' })).toHaveValue('music');
        await expect(dialog.getByRole('button', { name: /保存して(開始|再起動)/ })).toBeEnabled();
    });
}

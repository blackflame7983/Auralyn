import { test, expect } from './tauriFixture';

test('二入力を明示読込し、キーボードで調整する', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', inputId: 'mic', output: 'Test headphones', outputId: 'headphones', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] }));
        const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
        const levels = { voice: { gain: 0, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 };
        const config = { version: 1, source: { kind: 'device', config: { host: 'WASAPI', inputId: 'music', inputChannels: [0, 1] } }, levels };
        (window as any).__mixRequests = [];
        internal.invoke = async (command: string, args: any) => {
            if (command === 'live_output') return { config: { deviceId: 'out', splitProcessing: true, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
            if (command === 'mixing') { (window as any).__mixRequests.push(args.request); return { epoch: 'e', revision: '1', config, savedConfig: config, error: null, running: false, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [1.2, 1], knownVoiceProcessingFrames: null, pending: false, failed: false, primaryClock: null }; }
            return original(command, args);
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定' });
    await dialog.getByText('歌・モニター', { exact: true }).click();
    const summary = dialog.getByText('オケを追加して配信する', { exact: true });
    await summary.focus(); await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).__mixRequests.length)).toBe(0);
    const load = dialog.getByRole('button', { name: '読み込む', exact: true });
    await load.focus(); await page.keyboard.press('Enter');
    await expect(dialog.getByText(/声の既知の処理待ち: 不明/)).toBeVisible();
    await expect(dialog.getByText(/1.20/)).toBeVisible();
    const apply = dialog.getByRole('button', { name: '調整を適用' });
    await apply.scrollIntoViewIfNeeded(); await apply.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.some((r: any) => r.action === 'levels' && r.levels.voice.gain === 0))).toBe(true);
    await page.screenshot({ path: info.outputPath('mixing.png') });
});

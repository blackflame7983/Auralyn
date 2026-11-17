import { test, expect } from './tauriFixture';

test.use({ liveHome: true });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_locale', 'ja');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
            if (command === 'stop_voice_check') return Promise.resolve();
            if (command === 'voice_check_preview') {
                const request = args.request;
                return Promise.resolve({
                    epoch: 'preview', sessionId: request.sessionId, operationId: request.operationId,
                    recordingId: null, state: request.action === 'close' ? 'closed' : 'idle', positionMs: 0, durationMs: 0,
                    source: 'processed', loopPlayback: false, levelMatch: false, levelMatchAvailable: false,
                    metadata: null, recordingStale: false, devices: [], error: null, owner: null, conflict: null,
                    levelMatchAttenuationDb: [0, 0], safetyAttenuationDb: 0, candidate: null,
                });
            }
            return original(command, args);
        };
    });
});

const textWidth = (element: Element) => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return { box: box.width, text: text.width };
};

test('録音範囲の折りたたみは、枠が文字を含む', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'ボイスチェック', exact: true }).click();
    const summary = page.getByRole('dialog', { name: 'ボイスチェック', exact: true })
        .locator('summary', { hasText: '録音範囲と「音のトラブルを診断」について' });
    await expect(summary).toBeVisible();
    await summary.focus();
    const wide = await summary.evaluate(textWidth);
    expect(wide.box).toBeGreaterThanOrEqual(wide.text - 1);

    // 文字より狭い窓では、枠の中で折り返し、文字が枠からはみ出ない。
    await page.setViewportSize({ width: 240, height: 700 });
    const narrow = await summary.evaluate(textWidth);
    expect(narrow.box).toBeGreaterThanOrEqual(narrow.text - 1);
    expect(narrow.box).toBeLessThan(wide.box);
});

test('録音ボタンは「最大10秒」と書き、再生ボタンの下に長い試聴先の名前も1行で収める', async ({ page }) => {
    const longName = 'Speakers (Very Long Audio Interface Name With Many Channels And Vendor Words)';
    await page.addInitScript((name: string) => {
        localStorage.setItem('vst_host_voice_check_preview_device', 'long');
        const internals = window.__TAURI_INTERNALS__;
        if (!internals) throw new Error('__TAURI_INTERNALS__ がありません');
        const previous = internals.invoke;
        internals.invoke = async (command, args) => {
            const result = await previous(command, args);
            if (command !== 'voice_check_preview' || typeof result !== 'object' || result === null) return result;
            return { ...result, recordingId: 9, durationMs: 1000, devices: [{ id: 'long', name }] };
        };    }, longName);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'ボイスチェック', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'ボイスチェック', exact: true });
    await expect(dialog.getByRole('button', { name: '録音開始（最大10秒）' })).toBeVisible();
    const target = dialog.getByText('試聴先：' + longName);
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute('title', '試聴先：' + longName);
    const play = dialog.getByRole('button', { name: '選んだ試聴先で再生' });
    const [playBox, targetBox, dialogBox] = await Promise.all([play.boundingBox(), target.boundingBox(), dialog.boundingBox()]);
    if (!playBox || !targetBox || !dialogBox) throw new Error('位置を測れない');
    expect(targetBox.y).toBeGreaterThanOrEqual(playBox.y + playBox.height - 1);
    expect(targetBox.height).toBeLessThan(28);
    expect(targetBox.x + targetBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
});

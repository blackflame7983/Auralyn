import { expect, type Page, type TestInfo } from '@playwright/test';

/** 親が分離HostでASIOストリームを開始し、設定のオーディオ欄を開いた後に呼ぶ。 */
export async function verifyAsioAcceptance(page: Page, _root: string, testInfo: TestInfo) {
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(dialog.getByRole('combobox', { name: '接続方式' })).toHaveValue('ASIO');
    await expect(dialog.getByRole('combobox', { name: 'マイク入力' })).toHaveValue('Voicemeeter Insert Virtual ASIO');
    await expect(dialog.getByText('信号を継続して監視しています。')).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'すべての入力ペアを表示' }).click();
    const last = dialog.getByRole('radio', { name: '入力チャンネル 21/22' });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    await expect(dialog.getByRole('radio', { name: '入力チャンネル 9/10' })).toBeAttached();
    await expect(dialog.getByRole('radio', { name: /^入力チャンネル \d+\/\d+$/ })).toHaveCount(11);
    await page.screenshot({ path: testInfo.outputPath('asio-22-channel-selector.png') });

    // キューを新しい世代へ切り替え、無音通知を含む生の監視イベントを1件取得する。
    // 音声サンプルを保存せず、しきい値を超えたchの番号だけ返す。
    const result = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        return new Promise<{ count: number; activeChannels: number[] }>(async (resolve, reject) => {
            let unlisten: (() => void) | undefined;
            const timer = window.setTimeout(() => { unlisten?.(); reject(new Error('チャンネル監視イベントを受信できません')); }, 8000);
            try {
                unlisten = await tauri.event.listen('audio-channel-scan', (event: { payload: unknown }) => {
                    if (!Array.isArray(event.payload)) return;
                    clearTimeout(timer);
                    unlisten?.();
                    resolve({ count: event.payload.length, activeChannels: event.payload.flatMap((level, index) =>
                        typeof level === 'number' && Number.isFinite(level) && level > 0.05 ? [index + 1] : []) });
                });
                await tauri.core.invoke('set_channel_scan', { active: true });
            } catch (error) {
                clearTimeout(timer);
                unlisten?.();
                reject(error);
            }
        });
    });
    expect(result.count).toBe(32);
    return result;
}

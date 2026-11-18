import { mkdirSync } from 'node:fs';
import { test, expect } from './tauriFixture';

const shotDir = 'test-results/ux-eval-check/722-705-fix';

test.beforeAll(() => { mkdirSync(shotDir, { recursive: true }); });

function readyHome({ locale, music }: { locale: string; music: boolean }) {
    localStorage.setItem('vst_host_locale', locale === 'en' ? 'en' : 'ja');
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('auralyn_vst_panel_open', 'false');
    localStorage.setItem('auralyn_display_purpose', music ? 'music' : 'voice');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({
        host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512,
    }));
}

test.use({ liveHome: true, registeredModes: true });

test('実行中の札から音を止め、失敗したときは実行中のまま理由を出す', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(readyHome, { locale: 'ja', music: false });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const band = page.getByRole('region', { name: '状態の帯', exact: true });
    const badge = band.getByRole('button', { name: /実行中/ });
    await expect(badge).toHaveAccessibleName('状態：実行中（メニューを開く）');
    await badge.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(badge).toBeFocused();
    await page.keyboard.press('Enter');
    const stop = page.getByRole('menuitem', { name: /Auralyn の音を止める/ });
    await expect(stop).toBeVisible();
    await expect(stop).toContainText('マイクと出力先の接続を止めます');
    await expect(page.getByRole('menuitem', { name: /Auralyn を終了/ })).toContainText('トレイへ隠れます');
    await expect(page.getByRole('separator')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(badge).toBeFocused();
    await expect(stop).toBeHidden();
    await page.keyboard.press('Space');
    await expect(stop).toBeVisible();
    await page.keyboard.press('Escape');

    await page.evaluate(() => { (window as Window & { __e2eStopFailure?: boolean }).__e2eStopFailure = true; });
    await badge.click();
    await page.getByRole('menuitem', { name: /Auralyn の音を止める/ }).click();
    await expect(page.getByText('Auralyn の音を止められませんでした。')).toBeVisible();
    await expect(band.getByRole('status')).toHaveText('実行中');

    await page.evaluate(() => { (window as Window & { __e2eStopFailure?: boolean }).__e2eStopFailure = false; });
    await badge.click();
    await page.getByRole('menuitem', { name: /Auralyn の音を止める/ }).click();
    await expect(band.getByRole('status')).toHaveText('音声停止中');
    await band.getByRole('button', { name: /音声停止中/ }).click();
    await page.getByRole('menuitem', { name: '音声を開始', exact: true }).click();
    await expect(band.getByRole('status')).toHaveText('実行中');
});

test('操作ロック中も札から止められ、終了は専用の終了コマンドを呼ぶ', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(readyHome, { locale: 'ja', music: false });
    await page.addInitScript(() => {
        const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke: (command: string, args?: unknown) => Promise<unknown>; __statusMenuWrapped?: boolean } }).__TAURI_INTERNALS__;
        if (!internals || internals.__statusMenuWrapped) return;
        const original = internals.invoke;
        internals.__statusMenuWrapped = true;
        internals.invoke = async (command: string, args?: unknown) => {
            const result = await original(command, args);
            if (command === 'live_modes' && result && typeof result === 'object') return { ...result, armed: true };
            return result;
        };
    });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const lock = page.getByRole('button', { name: '操作をロック', exact: true });
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('region', { name: '状態の帯' }).getByRole('button', { name: /実行中/ }).click();
    const stop = page.getByRole('menuitem', { name: /Auralyn の音を止める/ });
    await expect(stop).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: /Auralyn を終了/ })).toBeEnabled();
    await stop.click();
    await expect(page.getByRole('region', { name: '状態の帯' }).getByRole('status')).toHaveText('音声停止中');
    await page.getByRole('region', { name: '状態の帯' }).getByRole('button', { name: /音声停止中/ }).click();
    await page.getByRole('menuitem', { name: /Auralyn を終了/ }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { __e2eQuits?: unknown[] }).__e2eQuits)).toEqual([0]);
});

test('状態が分からないときは終了だけを出す', async ({ page }) => {
    await page.addInitScript(readyHome, { locale: 'ja', music: false });
    await page.addInitScript(() => { (window as Window & { __e2eAudioUnknown?: boolean }).__e2eAudioUnknown = true; });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const badge = page.getByRole('region', { name: '状態の帯' }).getByRole('button', { name: /音声状態未確認/ });
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByRole('menuitem')).toHaveCount(1);
    await expect(page.getByRole('menuitem', { name: /Auralyn を終了/ })).toBeVisible();
});

for (const locale of ['ja', 'en'] as const) {
    for (const music of [false, true]) {
        for (const size of [{ width: 900, height: 600, name: 'w900' }, { width: 1024, height: 768, name: 'w1024' }] as const) {
            for (const stopped of [false, true]) {
                test(`札のメニュー ${locale} ${music ? 'music' : 'voice'} ${stopped ? 'stopped' : 'live'} ${size.name}`, async ({ page }) => {
                    await page.setViewportSize(size);
                    await page.addInitScript(readyHome, { locale, music });
                    await page.goto('/');
                    const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
                    await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
                    if (stopped) {
                        await page.evaluate(() => {
                            const emit = (window as Window & { __e2eEmit?: (event: string, payload: unknown) => void }).__e2eEmit;
                            if (!emit) throw new Error('__e2eEmit がありません');
                            (window as Window & { __e2eStopFailure?: boolean }).__e2eStopFailure = false;
                        });
                        await page.evaluate(async () => {
                            const invoke = window.__TAURI_INTERNALS__?.invoke;
                            if (!invoke) throw new Error('invoke がありません');
                            await invoke('stop_audio');
                        });
                    }
                    const stateWord = locale === 'ja' ? (stopped ? (music ? '停止中' : '音声停止中') : '実行中') : (stopped ? (music ? 'Stopped' : 'Audio stopped') : 'Running');
                    const badge = page.getByRole('region', { name: locale === 'ja' ? '状態の帯' : 'Status band' }).getByRole('button', { name: locale === 'ja' ? `状態：${stateWord}（メニューを開く）` : `Status: ${stateWord} (open menu)`, exact: true });
                    await expect(badge).toBeVisible();
                    await badge.click();
                    await expect(page.getByRole('menuitem').first()).toBeVisible();
                    await expect.poll(() => page.getByRole('menu').evaluate(menu => getComputedStyle(menu).opacity)).toBe('1');
                    const file = `${shotDir}/${locale}-${music ? 'music' : 'voice'}-${stopped ? 'stopped' : 'live'}-${size.name}-menu.png`;
                    await page.screenshot({ path: file });
                    await page.keyboard.press('Escape');
                });
            }
        }
    }
}

import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message } from '../../src/i18n/messages';
import { waitForStableLayout } from './helpers/waitForStableLayout';

// アプリの音声（process_loopback）は入力の機器名を持たない。実行中でも、停止中でも、ホームを未設定の画面にしない（#756）。

type Locale = 'ja' | 'en';
type Purpose = 'voice' | 'music';
const appName = 'chrome.exe';
const source = { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName, rawEndpointId: 'raw-endpoint', purpose: 'voice' } };

async function openHome(page: Page, size: { width: number; height: number }, locale: Locale, purpose: Purpose, state: 'app' | 'unset' | 'device-saved' | 'device' = 'app') {
    await page.setViewportSize(size);
    await page.addInitScript(({ l, p, s, mode }) => {
        localStorage.setItem('vst_host_locale', l);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_setup_goal', p === 'music' ? 'listening' : 'obs');
        localStorage.setItem('auralyn_display_purpose', p);
        const saved = mode === 'app'
            ? { host: 'WASAPI', output: 'スピーカー', outputId: 'headphones', sampleRate: 48000, bufferSize: 512, inputSource: { ...s, config: { ...s.config, purpose: p } } }
            : mode === 'device-saved' || mode === 'device'
                ? { host: 'WASAPI', input: 'CABLE Output', inputId: 'mic', output: 'スピーカー', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }
                : { host: 'WASAPI', input: '', output: 'スピーカー', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 };
        localStorage.setItem('vst_host_audio_config', JSON.stringify(saved));
        const internals = window.__TAURI_INTERNALS__;
        if (!internals) return;
        const original = internals.invoke;
        // 実エンジンは、アプリの音声のとき input を None で返し、入力元だけを返す。
        internals.invoke = async (command, args) => {
            if (command === 'get_audio_state') return { is_running: true, config: { host: 'WASAPI', input: mode === 'device' ? 'CABLE Output' : null, output: 'スピーカー', output_id: 'headphones',
                sample_rate: 48000, buffer_size: 512, ...(mode !== 'unset' && mode !== 'device' ? { input_source: { ...s, config: { ...s.config, purpose: p } } } : {}) } };
            return original(command, args);
        };
    }, { l: locale, p: purpose, s: source, mode: state });
    await page.goto('/');
    await expect(page.getByText(locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…', { exact: true })).toHaveCount(0);
    await expect(page.locator('.home-content')).toBeVisible();
    await waitForStableLayout(page);
}

const region = (page: Page, locale: Locale, key: 'home.now' | 'prep.title') => page.getByRole('region', { name: message(locale, key), exact: true });
// 未設定の画面の「音の流れ」は、広い窓の接続の確認の図と同じ名前なので、クラスで見分ける。
const unsetFlow = (page: Page) => page.locator('.unset-flow');

// 入力の見出し・いまの状態のラベル・音量の名前。マイクでないもの（アプリの音声）を「マイク」と呼ばない。音楽鑑賞は「再生元」のまま。
async function expectInputLabels(page: Page, locale: Locale, purpose: Purpose, fromApp: boolean) {
    const heading = message(locale, purpose === 'music' ? 'music.source' : fromApp ? 'home.input' : 'unsetFlow.mic');
    const gain = message(locale, purpose === 'music' || fromApp ? 'home.inputGain' : 'header.inputGain');
    const column = page.getByRole('complementary', { name: message(locale, 'shell.safetyColumn'), exact: true });
    await expect(column.getByRole('heading', { level: 3, name: heading, exact: true })).toBeVisible();
    await expect(column.getByRole('slider', { name: new RegExp(`^${gain} `) }).first()).toBeVisible();
    await expect(region(page, locale, 'home.now').getByText(heading, { exact: true })).toBeVisible();
    if (purpose === 'voice' && fromApp) {
        await expect(column).not.toContainText(message(locale, 'unsetFlow.mic'));
        await expect(region(page, locale, 'home.now')).not.toContainText(message(locale, 'unsetFlow.mic'));
    }
}

for (const locale of ['ja', 'en'] as const) for (const purpose of ['voice', 'music'] as const) {
    test.describe(`アプリの音声で実行中のホーム（${locale}、${purpose}）`, () => {
        test.use({ liveHome: true, builtinEnabled: true });

        for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
            test(`${size.width}×${size.height}：未設定の画面を出さず、いまの状態と診断の入口が出て、経路と図に空の名前が出ない`, async ({ page }, info) => {
                await openHome(page, size, locale, purpose);
                await expect(unsetFlow(page)).toHaveCount(0);
                await expect(region(page, locale, 'home.now')).toBeVisible();
                const connection = region(page, locale, 'prep.title');
                await expect(connection).toBeVisible();
                const diagram = connection.getByRole('region', { name: message(locale, 'flow.diagram'), exact: true });
                const band = page.getByRole('region', { name: message(locale, 'band.label'), exact: true });
                // 狭い窓は上の帯、広い窓は接続の確認の図に経路が出る。どちらも、アプリの名前だけが入力の名前になる。
                if (size.width >= 1400) {
                    await expect(diagram).toContainText(appName);
                    await expect(diagram).toContainText('スピーカー');
                    await expect(diagram).not.toContainText(message(locale, 'flow.checkInput'));
                } else {
                    await expect(band.locator('[data-route-box]')).toHaveAttribute('title', new RegExp(`^${appName}`));
                    await expect(band.locator('[data-route-box]')).not.toContainText(message(locale, 'master.unset'));
                }
                await expect(connection.getByRole('button', { name: message(locale, 'header.noSound') })).toBeVisible();
                const column = page.getByRole('complementary', { name: message(locale, 'shell.safetyColumn'), exact: true });
                await expect(column).toContainText(appName);
                await expectInputLabels(page, locale, purpose, true);
                await page.screenshot({ path: info.outputPath(`app-audio-${purpose}-${locale}-${size.width}x${size.height}.png`), fullPage: false });
            });
        }
    });
}

test.describe('アプリの音声が保存されているとき', () => {
    test.use({ liveHome: true, stoppedHome: true, builtinEnabled: true });

    test('停止中でも未設定の画面にならず、いまの状態に開始が出る', async ({ page }) => {
        await openHome(page, { width: 1024, height: 768 }, 'ja', 'voice');
        await expect(unsetFlow(page)).toHaveCount(0);
        await expect(region(page, 'ja', 'home.now')).toBeVisible();
    });
});

test.describe('本当に未設定のとき', () => {
    test.use({ liveHome: true, builtinEnabled: true });

    for (const purpose of ['voice', 'music'] as const) {
        test(`入力が無く、アプリの音声でもなければ未設定の画面のまま（${purpose}）`, async ({ page }) => {
            await openHome(page, { width: 1024, height: 768 }, 'ja', purpose, 'unset');
            await expect(unsetFlow(page)).toBeVisible();
            await expect(region(page, 'ja', 'home.now')).toHaveCount(0);
        });
    }
});

test.describe('保存した設定と実行中の入力が違うとき', () => {
    test.use({ liveHome: true, builtinEnabled: true });

    for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
        test(`${size.width}×${size.height}：保存は機器入力でも、実行中がアプリの音声なら、経路・図・右の列は実行中のアプリ名を出す`, async ({ page }) => {
            await openHome(page, size, 'ja', 'voice', 'device-saved');
            await expect(unsetFlow(page)).toHaveCount(0);
            const shown = size.width >= 1400
                ? region(page, 'ja', 'prep.title').getByRole('region', { name: message('ja', 'flow.diagram'), exact: true })
                : page.getByRole('region', { name: message('ja', 'band.label'), exact: true }).locator('[data-route-box]');
            await expect(shown).toContainText(appName);
            await expect(page.locator('.home-content')).not.toContainText('CABLE Output');
            await expect(page.getByRole('complementary', { name: message('ja', 'shell.safetyColumn'), exact: true })).toContainText(appName);
        });
    }
});

for (const locale of ['ja', 'en'] as const) {
    test.describe(`機器入力で実行中の配信のホーム（${locale}）`, () => {
        test.use({ liveHome: true, builtinEnabled: true });

        test('これまでどおり「マイク」と呼び、マイク音量を出す', async ({ page }) => {
            await openHome(page, { width: 1024, height: 768 }, locale, 'voice', 'device');
            await expect(unsetFlow(page)).toHaveCount(0);
            await expectInputLabels(page, locale, 'voice', false);
        });
    });
}
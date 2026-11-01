import { test, expect } from './tauriFixture';
import type { Page } from '@playwright/test';

test.use({ liveHome: true });

const config = { host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 };
test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(saved => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify(saved));
        // 他の試験と同じIPCに重ね、試験対象だけ応答と呼出しを制御する。
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let obsConnected = false;
        let bindings: { action: string; shortcut: string }[] = [];
        Object.assign(window, { __settingsGlitches: 0, __settingsStatsReads: 0, __settingsShortcutWrites: [] });
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            if (command === 'get_shortcuts') return { bindings, errors: [] };
            if (command === 'save_shortcuts') {
                bindings = args.bindings;
                (window as any).__settingsShortcutWrites.push(bindings);
                return { bindings, errors: [] };
            }
            if (command === 'obs_connection_status') return obsConnected;
            if (command === 'obs_setup_history') return [];
            if (command === 'connect_obs') { obsConnected = true; return; }
            if (command === 'disconnect_obs') { obsConnected = false; return; }
            const result = await original(command, args);
            if (command === 'get_engine_runtime_stats') {
                (window as any).__settingsStatsReads++;
                result.glitchCount = (window as any).__settingsGlitches;
            }
            if (command === 'get_audio_state' && result.config) {
                const stored = JSON.parse(localStorage.getItem('vst_host_audio_config')!);
                result.config.buffer_size = stored.bufferSize;
                result.config.sample_rate = stored.sampleRate;
            }
            return result;
        };
    }, config);
});

async function openSettings(page: Page) {
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(dialog.getByRole('combobox', { name: '接続方式', exact: true })).toBeVisible();
    return dialog;
}

test('稼働中は設定差分で再起動を有効化し、元に戻すと無効にする', async ({ page }) => {
    const dialog = await openSettings(page);
    const save = dialog.getByRole('button', { name: '保存して再起動', exact: true });
    await expect(save).toBeDisabled();
    await expect(dialog.getByText('変更はありません')).toBeVisible();
    const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '音の途切れ・周波数' }) }).first();
    await expect(details).not.toHaveAttribute('open');
    await details.locator('summary').click();
    await expect(details.getByRole('heading', { name: '音の途切れにくさ' })).toBeVisible();
    await expect(details.getByRole('button', { name: '標準 配信・会話向け', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(details.getByRole('button', { name: /48 kHz/ })).toHaveAttribute('aria-pressed', 'true');
    await details.getByRole('button', { name: /途切れにくく/ }).click();
    await expect(save).toBeEnabled();
    await expect(dialog.getByText(/変更予定：.*音の途切れにくさ/)).toBeVisible();
    await details.getByRole('button', { name: '標準 配信・会話向け', exact: true }).click();
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')!))).toMatchObject(config);
    expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
});

test('保存済み256サンプルは数値選択として復元する', async ({ page }) => {
    await page.addInitScript(saved => localStorage.setItem('vst_host_audio_config', JSON.stringify({ ...saved, bufferSize: 256 })), config);
    const dialog = await openSettings(page);
    const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '音の途切れ・周波数' }) }).first();
    if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator('summary').click();
    await expect(details.getByRole('button', { name: '数値で指定', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(details.getByRole('combobox', { name: 'バッファサイズ' })).toHaveValue('256');
    await expect(dialog.getByRole('button', { name: '保存して再起動' })).toBeDisabled();
});

test.describe('停止中', () => {
    test.use({ stoppedHome: true });
    test('設定済みでも保存して開始できる', async ({ page }) => {
        const dialog = await openSettings(page);
        const start = dialog.getByRole('button', { name: '保存して開始', exact: true });
        await expect(start).toBeEnabled();
        await start.click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as any).__e2eStarts.length)).toBe(1);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')!))).toMatchObject(config);
    });
});

test.describe('未設定', () => {
    test.use({ liveHome: false });
    test('初回の接続設定から開始できる', async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem('vst_host_audio_config'));
        const dialog = await openSettings(page);
        await expect(dialog.getByRole('button', { name: '保存して開始', exact: true })).toBeEnabled();
        expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
    });
});

test('音切れ通知から調整欄へ移動し、変更なしでは再起動しない', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '音声処理の詳細' })).toBeVisible();
    const reads = await page.evaluate(() => (window as any).__settingsStatsReads as number);
    await expect.poll(() => page.evaluate(() => (window as any).__settingsStatsReads)).toBeGreaterThan(reads);
    await page.evaluate(() => { (window as any).__settingsGlitches = 1; });
    const entry = page.getByRole('button', { name: '途切れにくくする', exact: true });
    await expect(entry).toBeVisible();
    await expect(page.getByRole('button', { name: '直近で音切れを検出' })).toBeVisible();
    await entry.click();
    const dialog = page.getByRole('dialog', { name: '設定', exact: true });
    const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '音の途切れ・周波数' }) }).first();
    await expect(details).toHaveAttribute('open');
    await expect(details.getByRole('button', { name: 'おまかせ', exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: '保存して再起動' })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
});

test('ホットキーは未設定を示し、一覧から変更・取消・保存できる', async ({ page }) => {
    const dialog = await openSettings(page);
    await dialog.getByRole('tab', { name: 'ホットキー', exact: true }).click();
    const field = dialog.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'ミュートON' }) });
    await expect(field.getByRole('button', { name: 'ミュートONのキーを入力' })).toHaveText('未設定');
    const save = dialog.getByRole('button', { name: 'キー設定を保存' });
    const discard = dialog.getByRole('button', { name: '変更を取り消す' });
    await expect(save).toBeDisabled();
    await field.locator('summary').focus();
    await page.keyboard.press('Enter');
    await field.getByRole('combobox', { name: 'ミュートONの修飾キー' }).selectOption('Alt');
    await field.getByRole('combobox', { name: 'ミュートONの通常キー' }).selectOption('KeyM');
    await expect(save).toBeEnabled();
    await discard.click();
    await expect(save).toBeDisabled();
    await field.getByRole('combobox', { name: 'ミュートONの修飾キー' }).selectOption('Alt');
    await field.getByRole('combobox', { name: 'ミュートONの通常キー' }).selectOption('KeyM');
    await save.click();
    await expect(dialog.getByRole('status')).toContainText('キー設定を保存しました');
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__settingsShortcutWrites)).toEqual([[{ action: 'muteOn', shortcut: 'Alt+KeyM' }]]);
});

test('OBS接続後は接続先を折りたたみ、明示操作で確認できる', async ({ page }) => {
    const dialog = await openSettings(page);
    await dialog.getByRole('tab', { name: 'OBS連携', exact: true }).click();
    const host = dialog.getByRole('textbox', { name: 'OBSホスト名' });
    await expect(host).toBeVisible();
    await dialog.getByRole('button', { name: '接続', exact: true }).click();
    await expect(host).toBeHidden();
    const summary = dialog.locator('summary').filter({ hasText: '接続' }).first();
    await expect(summary).toContainText('localhost');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(host).toBeVisible();
    await expect(host).toBeDisabled();
});

for (const theme of ['light', 'dark', 'gaming']) {
    for (const zoom of [1.25, 1.5]) {
        test(`設定の主要タブを960×640・${theme}・CSS拡大${zoom}で操作できる`, async ({ page }, info) => {
            await page.addInitScript(value => localStorage.setItem('vst_host_theme', value), theme);
            await page.goto('/');
            // CSS拡大で狭い表示を検査する。Windows実DPIやブラウザ本来のズームではない。
            await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
            await page.getByRole('button', { name: '設定を開く', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: '設定', exact: true });
            for (const tab of ['オーディオ', 'ホットキー', 'システム', '外観']) {
                await dialog.getByRole('tab', { name: tab, exact: true }).click();
                await expect(dialog.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('data-state', 'active');
                await expect(dialog.getByRole('tab', { name: tab, exact: true })).toBeInViewport();
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
                await page.screenshot({ path: info.outputPath(`${theme}-${zoom}-${tab}.png`) });
            }
            await expect(dialog.getByRole('button', { name: '設定画面を閉じる', exact: true })).toBeInViewport();
        });
    }
}

test.describe('ホームと設定の共通操作', () => {
    test.use({ builtinEnabled: true });
    test('ノイズ低減と声のプリセットの寸法を揃える', async ({ page }) => {
        await page.addInitScript(() => {
            const original = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
                const result = await original(command, args);
                if (command === 'get_engine_runtime_stats') {
                    result.noiseReductionEnabled = true;
                    result.noiseReductionMode = 'low';
                }
                return result;
            };
        });
        await page.goto('/');
        const names = ['弱', '強', '配信', '低め', '明瞭'];
        const home = [...names.slice(0, 2).map(name => page.locator('#home-noise').getByRole('button', { name, exact: true })),
            ...names.slice(2).map(name => page.locator('#home-builtin').getByRole('button', { name, exact: true }))];
        const dimensions = async (button: typeof home[number]) => button.evaluate(node => {
            const style = getComputedStyle(node);
            return { height: node.getBoundingClientRect().height, padding: style.padding, minWidth: style.minWidth };
        });
        for (const button of home) await expect(button).toBeVisible();
        const sizes = await Promise.all(home.map(dimensions));
        await page.getByRole('button', { name: '設定を開く', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '設定', exact: true });
        await dialog.getByRole('tab', { name: '音づくり', exact: true }).click();
        for (let i = 0; i < names.length; i++) {
            const button = dialog.getByRole('button', { name: names[i], exact: true });
            await expect(button).toBeVisible();
            expect(await dimensions(button)).toEqual(sizes[i]);
        }
    });
});

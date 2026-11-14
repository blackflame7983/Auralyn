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
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const dialog = page.locator('[data-settings-page]');
    await expect(dialog.getByRole('combobox', { name: '接続方式', exact: true, includeHidden: true })).toBeAttached();
    return dialog;
}

test('稼働中は設定差分で再起動を有効化し、元に戻すと無効にする', async ({ page }) => {
    const dialog = await openSettings(page);
    const save = dialog.getByRole('button', { name: '接続を保存して再起動', exact: true });
    await expect(save).toBeDisabled();
    await expect(dialog.getByText('変更はありません')).toBeVisible();
    const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '接続方式・音切れの設定' }) }).first();
    await expect(details).not.toHaveAttribute('open');
    await details.locator('summary').filter({ hasText: '接続方式・音切れの設定' }).click();
    await expect(details.getByRole('heading', { name: '音の途切れにくさ' })).toBeVisible();
    await expect(details.getByRole('radio', { name: '標準', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(details.getByRole('radio', { name: /48 kHz/ })).toHaveAttribute('aria-checked', 'true');
    await details.getByRole('radio', { name: /途切れにくく/ }).click();
    await expect(save).toBeEnabled();
    await expect(dialog.getByText(/変更予定：.*音の途切れにくさ/)).toBeVisible();
    await details.getByRole('radio', { name: '標準', exact: true }).click();
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')!))).toMatchObject(config);
    expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
});

test('保存済み256サンプルは数値選択として復元する', async ({ page }) => {
    await page.addInitScript(saved => localStorage.setItem('vst_host_audio_config', JSON.stringify({ ...saved, bufferSize: 256 })), config);
    const dialog = await openSettings(page);
    const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '接続方式・音切れの設定' }) }).first();
    if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator('summary').filter({ hasText: '接続方式・音切れの設定' }).click();
    await expect(details.getByRole('radio', { name: '数値で指定', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(details.getByRole('combobox', { name: 'バッファサイズ' })).toHaveValue('256');
    await expect(dialog.getByRole('button', { name: '接続を保存して再起動' })).toBeDisabled();
});

test.describe('停止中', () => {
    test.use({ stoppedHome: true });
    test('設定済みでも保存して開始できる', async ({ page }) => {
        const dialog = await openSettings(page);
        const start = dialog.getByRole('button', { name: '接続を保存して開始', exact: true });
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
        await expect(dialog.getByRole('button', { name: '接続を保存して開始', exact: true })).toBeEnabled();
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
    const dialog = page.locator('[data-settings-page]');
    const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '接続方式・音切れの設定' }) }).first();
    await expect(details).toHaveAttribute('open');
    await expect(details.getByRole('radio', { name: 'おまかせ', exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: '接続を保存して再起動' })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__e2eStarts)).toEqual([]);
});

test('ホットキーは未設定を示し、一覧から変更・取消・保存できる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const dialog = await openSettings(page);
    await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
    await dialog.getByRole('tab', { name: 'ホットキー', exact: true }).click();
    const field = dialog.locator('fieldset').filter({ has: page.locator('legend', { hasText: '緊急ミュート（オン）' }) });
    await expect(field.locator('[data-shortcut-binding]')).toHaveText('未設定');
    await expect(field.getByRole('button', { name: '緊急ミュート（オン）のキーを入力' })).toHaveText('キーを入力');
    const save = dialog.getByRole('button', { name: 'キー設定を保存' });
    const discard = dialog.getByRole('button', { name: 'キー設定の編集を取り消す' });
    await expect(save).toBeDisabled();
    const rows = dialog.locator('fieldset').filter({ has: page.locator('[data-shortcut-binding]') });
    const saveTop = (await save.boundingBox())!.y;
    const visibleRows = await rows.evaluateAll((elements, saveTop) => elements.filter(element => {
        const row = element.getBoundingClientRect();
        const scroller = element.closest('.overflow-y-auto')!.getBoundingClientRect();
        return row.top >= scroller.top && row.bottom <= Math.min(scroller.bottom, saveTop);
    }).length, saveTop);
    expect(visibleRows).toBeGreaterThanOrEqual(8);
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(56);
    await field.getByRole('button', { name: '緊急ミュート（オン）のキーを一覧から選ぶ' }).focus();
    await page.keyboard.press('Enter');
    await field.getByRole('combobox', { name: '緊急ミュート（オン）の修飾キー' }).selectOption('Alt');
    await field.getByRole('combobox', { name: '緊急ミュート（オン）の通常キー' }).selectOption('KeyM');
    await expect(save).toBeEnabled();
    await discard.click();
    await expect(save).toBeDisabled();
    await field.getByRole('combobox', { name: '緊急ミュート（オン）の修飾キー' }).selectOption('Alt');
    await field.getByRole('combobox', { name: '緊急ミュート（オン）の通常キー' }).selectOption('KeyM');
    await save.click();
    await expect(dialog.getByRole('status')).toContainText('キー設定を保存しました');
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__settingsShortcutWrites)).toEqual([[{ action: 'muteOn', shortcut: 'Alt+KeyM' }]]);
});

test('OBS接続後は接続先を折りたたみ、明示操作で確認できる', async ({ page }) => {
    const dialog = await openSettings(page);
    await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
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
            await page.evaluate(value => { document.documentElement.style.zoom = String(value); document.documentElement.style.setProperty('--ui-zoom', String(value)); }, zoom);
            const rail = page.getByRole('navigation', { name: '行き先' });
            await rail.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
            const dialog = page.locator('[data-settings-page]');
            await expect(dialog.getByRole('heading', { level: 1, name: '接続' })).toBeInViewport();
            // CSS拡大は 100vh の下端を画面の外へ出す。保存ボタンはページの下端に固定されていることだけを見る。
            const saveInPage = await dialog.getByRole('button', { name: /保存して(開始|再起動)/ }).evaluate(button => {
                const pageBox = button.closest('[data-settings-page]')!.getBoundingClientRect();
                const box = button.getBoundingClientRect();
                return box.top >= pageBox.top - 1 && box.bottom <= pageBox.bottom + 1;
            });
            expect(saveInPage).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath(`${theme}-${zoom}-接続.png`) });
            await rail.getByRole('button', { name: '設定', exact: true }).click();
            for (const tab of ['ホットキー', 'システム', '外観']) {
                await dialog.getByRole('tab', { name: tab, exact: true }).click();
                await expect(dialog.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('data-state', 'active');
                await expect(dialog.getByRole('tab', { name: tab, exact: true })).toBeInViewport();
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
                await page.screenshot({ path: info.outputPath(`${theme}-${zoom}-${tab}.png`) });
            }
            await expect(rail.getByRole('button', { name: 'ホーム', exact: true })).toBeInViewport();
        });
    }
}

test.describe('ホームと設定の共通操作', () => {
    test.use({ builtinEnabled: true });
    test('ノイズ低減と声のプリセットは各画面内で寸法を揃え、ホームをコンパクトにする', async ({ page }) => {
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
        // 声の種類は2段目。仮の境目は高さ 860 なので、同じ寸法の比較はそこ以上で続ける。
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto('/');
        const names = ['弱', '強', '配信', '低め', '明瞭'];
        const home = [...names.slice(0, 2).map(name => page.locator('#home-noise').getByRole('radio', { name, exact: true })),
            ...names.slice(2).map(name => page.locator('#home-builtin').getByRole('radio', { name, exact: true }))];
        const dimensions = async (button: typeof home[number]) => button.evaluate(node => {
            const style = getComputedStyle(node);
            // 位置によって 0.00003px のような画素未満の誤差が出るため、高さは 0.1px 単位で比べる。
            return { height: Math.round(node.getBoundingClientRect().height * 10) / 10, padding: style.padding, minWidth: style.minWidth, fontSize: style.fontSize };
        });
        const sizes: Awaited<ReturnType<typeof dimensions>>[] = [];
        for (let i = 0; i < home.length; i++) {
            await expect(home[i]).toBeVisible();
            sizes.push(await dimensions(home[i]));
        }
        expect(sizes.slice(0, 2).every(size => JSON.stringify(size) === JSON.stringify(sizes[0]))).toBe(true);
        expect(sizes.slice(2).every(size => JSON.stringify(size) === JSON.stringify(sizes[2]))).toBe(true);
        const settingsSizes: Awaited<ReturnType<typeof dimensions>>[] = [];
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        const dialog = page.locator('[data-settings-page]');
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '音づくり', exact: true }).click();
        for (let i = 0; i < names.length; i++) {
            const button = dialog.getByRole('radio', { name: names[i], exact: true });
            await expect(button).toBeVisible();
            const size = await dimensions(button);
            settingsSizes.push(size);
            expect(sizes[i].fontSize).toBe('13px');
            expect(size.fontSize).toBe('16px');
            expect(size.height).toBeGreaterThan(sizes[i].height);
        }
        expect(settingsSizes.slice(0, 2).every(size => JSON.stringify(size) === JSON.stringify(settingsSizes[0]))).toBe(true);
        expect(settingsSizes.slice(2).every(size => JSON.stringify(size) === JSON.stringify(settingsSizes[2]))).toBe(true);
    });
});

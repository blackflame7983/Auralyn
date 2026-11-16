import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import './tauriWindow';

function parsedJson(text: string): unknown {
    return JSON.parse(text) as unknown;
}

function displayLocale(text: string): string | null {
    const parsed = parsedJson(text);
    if (!parsed || typeof parsed !== 'object' || !('locale' in parsed)) return null;
    const locale = parsed.locale;
    return typeof locale === 'string' ? locale : null;
}

test('実UI→Tauri→保存→Host再起動で言語を復元し、実エンジンの応答を表示する', async ({}, testInfo) => {
    test.setTimeout(150_000);
    const root = process.env.AURALYN_E2E_ROOT;
    const binary = process.env.AURALYN_E2E_BINARY;
    if (!root || !binary) throw new Error('npm run test:e2e:native から実行してください');
    const hostRoot = root;
    const hostBinary = binary;
    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const errors: string[] = [];
    function openedPage(): Page {
        if (!page) throw new Error('実アプリのページがありません');
        return page;
    }
    function hostProcess(): ChildProcess {
        if (!child) throw new Error('Hostプロセスがありません');
        return child;
    }
    async function launch() {
        const server = createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('CDPポートを確保できません');
        const port = address.port;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const host = spawn(hostBinary, ['--auralyn-review'], {
            cwd: join(hostRoot, 'bin'), windowsHide: true,
            env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child = host;
        host.on('error', error => errors.push(error.message));
        const stderr = host.stderr;
        const stdout = host.stdout;
        if (!stderr || !stdout) throw new Error('Hostの標準入出力を受け取れません');
        stderr.on('data', () => {});
        stdout.on('data', () => {});
        await expect.poll(async () => {
            if (errors.length) throw new Error(errors.join('\n'));
            if (host.exitCode !== null) throw new Error(`Hostが接続前に終了: ${host.exitCode}`);
            try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); return response.ok; }
            catch { return false; }
        }, { timeout: 30_000 }).toBe(true);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        // WebView2は接続直後に仮の空ページを列挙する場合がある。実アプリのURLを待つ。
        await expect.poll(() => context.pages().some(value => value.url().startsWith('http://127.0.0.1:1427')), { timeout: 20_000 }).toBe(true);
        const opened = context.pages().find(value => value.url().startsWith('http://127.0.0.1:1427'));
        if (!opened) throw new Error('実アプリのページがありません');
        page = opened;
        opened.on('pageerror', error => errors.push(error.message));
        const globalAvailable = await opened.evaluate(() => typeof window.__TAURI__?.core.invoke === 'function');
        console.log(`native E2E専用設定: __TAURI__=${globalAvailable}`);
        expect(globalAvailable).toBe(true);
        const wizard = opened.getByRole('dialog', { name: 'セットアップ' });
        const settings = opened.locator('[data-settings-page]');
        await expect(wizard.or(settings)).toBeVisible({ timeout: 15_000 });
        if (await wizard.isVisible()) await wizard.getByRole('button', { name: 'セットアップをスキップ' }).click();
        if (await settings.count() === 0) await opened.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '設定', exact: true }).click();
    }
    async function quit() {
        const running = hostProcess();
        const exited = new Promise<number | null>(resolve => {
            running.once('exit', exitCode => resolve(exitCode));
        });
        // E2E専用capabilityで正常終了する。通常アプリに終了用の権限を追加しない。
        await openedPage().evaluate(() => {
            const pending = window.__TAURI__?.core.invoke('plugin:process|exit', { code: 0 });
            if (!pending) throw new Error('__TAURI__ がありません');
            void pending;
        });
        const code = await Promise.race([exited, new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('Hostが正常終了しませんでした')), 10_000); timer.unref();
        })]);
        expect(code).toBe(0);
        const connected = browser;
        if (!connected) throw new Error('ブラウザ接続がありません');
        await connected.close();
        browser = undefined;
        child = undefined;
    }
    try {
        await launch();
        await openedPage().getByRole('tab', { name: '外観', exact: true }).click();
        await openedPage().getByRole('combobox', { name: '表示言語' }).selectOption('en');
        await expect(openedPage().getByRole('combobox', { name: 'Language' })).toHaveValue('en');
        await expect.poll(async () => {
            try { return displayLocale(await readFile(join(root, 'config', 'display-locale.json'), 'utf8')); }
            catch { return null; }
        }).toBe('en');

        // 保存操作を伴わない表示・開閉だけを実UIで確認する。
        await expect(openedPage().getByText('A light background with teal accents.')).toBeVisible();
        await openedPage().screenshot({ path: testInfo.outputPath('native-appearance.png') });
        await openedPage().getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Connection (audio settings)', exact: true }).click();
        await expect(openedPage().getByRole('combobox', { name: 'Connection method' })).toBeVisible({ timeout: 30_000 });
        const redetect = openedPage().getByRole('button', { name: 'Re-detect', exact: true });
        const size = await redetect.boundingBox();
        expect(size).not.toBeNull();
        if (!size) throw new Error('Re-detect の寸法を取得できません');
        expect(size.width).toBeGreaterThanOrEqual(24);
        expect(size.height).toBeGreaterThanOrEqual(24);
        const tuning = openedPage().locator('details').filter({ has: openedPage().locator('summary').filter({ hasText: 'Connection and dropout settings' }) });
        await expect(tuning).not.toHaveAttribute('open', '');
        await tuning.locator('summary').filter({ hasText: 'Connection and dropout settings' }).click();
        await expect(tuning).toHaveAttribute('open', '');
        await tuning.locator('summary').filter({ hasText: 'Connection and dropout settings' }).click();
        await expect(tuning).not.toHaveAttribute('open', '');
        await openedPage().screenshot({ path: testInfo.outputPath('native-audio.png') });

        await openedPage().getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
        const leave = openedPage().getByRole('alertdialog', { name: 'You have unsaved changes' });
        if (await leave.isVisible()) await leave.getByRole('button', { name: 'Discard changes and leave', exact: true }).click();
        await openedPage().getByRole('tab', { name: 'OBS', exact: true }).click();
        const preview = openedPage().getByRole('button', { name: 'Review proposed changes' });
        await expect(preview).toBeDisabled();
        await expect(openedPage().getByText('Connect to OBS to use this.')).toBeVisible();
        await expect(preview).toHaveAccessibleDescription('Connect to OBS to use this.');
        await openedPage().screenshot({ path: testInfo.outputPath('native-obs.png') });

        await openedPage().getByRole('tab', { name: 'System', exact: true }).click();
        await expect(openedPage().getByRole('button', { name: 'Reset blocklist', exact: true })).toBeVisible();
        const reset = openedPage().getByRole('button', { name: 'Reset all', exact: true });
        await expect(reset).toBeVisible();
        await expect(reset).toHaveClass(/\bbg-destructive\b/);
        await openedPage().screenshot({ path: testInfo.outputPath('native-system.png') });

        // この隔離Hostだけで登録し、正常終了時にOS登録を解放する。
        await openedPage().getByRole('tab', { name: 'Hotkeys', exact: true }).click();
        const mute = openedPage().getByRole('group', { name: 'Toggle mute' });
        await mute.getByText('Choose from a list').click();
        await mute.getByRole('combobox', { name: 'Toggle mute modifier' }).selectOption('Alt+Shift');
        await mute.getByRole('combobox', { name: 'Toggle mute regular key' }).selectOption('F11');
        await openedPage().getByRole('button', { name: 'Save key settings' }).click();
        await expect(openedPage().getByText('Key settings saved.', { exact: true })).toBeVisible();
        const expectedBinding = { action: 'muteToggle', shortcut: 'Alt+Shift+F11' };
        const savedStatus = await openedPage().evaluate(() => window.__TAURI__?.core.invoke('get_shortcuts') ?? Promise.reject(new Error('__TAURI__ がありません')));
        expect(savedStatus.errors).toEqual([]);
        expect(savedStatus.bindings).toContainEqual(expectedBinding);
        const persisted = parsedJson(await readFile(join(root, 'config', 'shortcuts.json'), 'utf8'));
        expect(persisted).toContainEqual(expectedBinding);
        await openedPage().screenshot({ path: testInfo.outputPath('native-hotkeys.png') });
        // 外部OBSへ接続せず、旧平文の起動時移行とユーザー保護ファイルの再読込を確認する。
        await openedPage().evaluate(() => localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: 'native-test', port: 4455, password: 'NATIVE_OBS_TEST_CANARY' })));
        await openedPage().reload();
        await openedPage().getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(openedPage().locator('[data-settings-page]')).toBeVisible();
        await expect.poll(() => openedPage().evaluate(() => localStorage.getItem('vst_host_obs_config'))).toBe(JSON.stringify({ host: 'native-test', port: 4455 }));
        const encryptedCredentials = await readFile(join(root, 'config', 'obs-credentials.dpapi'));
        expect(encryptedCredentials.includes(Buffer.from('NATIVE_OBS_TEST_CANARY'))).toBe(false);
        await quit();
        await launch();
        const restoredCredentials = await openedPage().evaluate(() => window.__TAURI__?.core.invoke('get_obs_credentials') ?? Promise.reject(new Error('__TAURI__ がありません')));
        expect(restoredCredentials).toEqual({ host: 'native-test', port: 4455 });
        await openedPage().getByRole('tab', { name: 'OBS', exact: true }).click();
        await expect(openedPage().getByLabel('OBS password', { exact: true })).toHaveValue('');
        await expect(openedPage().getByLabel('Use the saved password for this endpoint')).toBeChecked();
        await openedPage().getByRole('tab', { name: 'Appearance', exact: true }).click();
        await expect(openedPage().getByRole('combobox', { name: 'Language' })).toHaveValue('en');
        const restoredStatus = await openedPage().evaluate(() => window.__TAURI__?.core.invoke('get_shortcuts') ?? Promise.reject(new Error('__TAURI__ がありません')));
        expect(restoredStatus.errors).toEqual([]);
        expect(restoredStatus.bindings).toContainEqual(expectedBinding);
        await openedPage().getByRole('tab', { name: 'Hotkeys', exact: true }).click();
        await expect(openedPage().getByRole('group', { name: 'Toggle mute' }).getByRole('button', { name: 'Enter keys for Toggle mute', exact: true })).toHaveText('Alt + Shift + F11');
        // モックを介さず、実sidecarの要求・応答とJSONデコードを確認する。
        const stats = await openedPage().evaluate(() => window.__TAURI__?.core.invoke('get_engine_runtime_stats') ?? Promise.reject(new Error('__TAURI__ がありません')));
        expect(stats.activePluginCount).toBe(0);
        expect(stats.glitchCount).toBe(0);
        const stream = await openedPage().evaluate(() => window.__TAURI__?.core.invoke('auto_gain', { request: { action: 'status' } }) ?? Promise.reject(new Error('__TAURI__ がありません')));
        expect(stream.running).toBe(false);
        expect(stream.streamFailed).toBe(false);
        await openedPage().getByRole('tab', { name: 'System', exact: true }).click();
        await openedPage().locator('summary').filter({ hasText: /^Diagnostics$/ }).click();
        await openedPage().getByRole('button', { name: 'Refresh statistics', exact: true }).click();
        await expect(openedPage().getByRole('row', { name: /^Loaded / }).getByRole('cell')).toHaveText(String(stats.activePluginCount));
        // 登録されていない実コマンドは拒否される。通信失敗を成功へ変換しない。
        const rejected = await openedPage().evaluate(async () => {
            const tauri = window.__TAURI__;
            if (!tauri) throw new Error('__TAURI__ がありません');
            try { await tauri.core.invoke('e2e_missing_command'); return false; }
            catch { return true; }
        });
        expect(rejected).toBe(true);
        await quit();
        expect(errors).toEqual([]);
    } finally {
        if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
            await page.screenshot({ path: testInfo.outputPath('native-failure.png') }).catch(() => {});
        }
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await Promise.race([exited, new Promise<never>((_, reject) => {
                const timer = setTimeout(() => reject(new Error('失敗時のHost回収が完了しませんでした')), 10_000); timer.unref();
            })]);
        }
        await browser?.close();
    }
});

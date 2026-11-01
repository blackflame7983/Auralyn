import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

test('実UI→Tauri→保存→Host再起動で言語を復元し、実エンジンの応答を表示する', async ({}, testInfo) => {
    test.setTimeout(150_000);
    const root = process.env.AURALYN_E2E_ROOT;
    const binary = process.env.AURALYN_E2E_BINARY;
    if (!root || !binary) throw new Error('npm run test:e2e:native から実行してください');
    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const errors: string[] = [];
    async function launch() {
        const server = createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('CDPポートを確保できません');
        const port = address.port;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        child = spawn(binary!, ['--auralyn-review'], {
            cwd: join(root!, 'bin'), windowsHide: true,
            env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.on('error', error => errors.push(error.message));
        child.stderr!.on('data', () => {});
        child.stdout!.on('data', () => {});
        await expect.poll(async () => {
            if (errors.length) throw new Error(errors.join('\n'));
            if (child!.exitCode !== null) throw new Error(`Hostが接続前に終了: ${child!.exitCode}`);
            try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); return response.ok; }
            catch { return false; }
        }, { timeout: 30_000 }).toBe(true);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        // WebView2は接続直後に仮の空ページを列挙する場合がある。実アプリのURLを待つ。
        await expect.poll(() => context.pages().some(value => value.url().startsWith('http://127.0.0.1:1427')), { timeout: 20_000 }).toBe(true);
        page = context.pages().find(value => value.url().startsWith('http://127.0.0.1:1427'))!;
        page.on('pageerror', error => errors.push(error.message));
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    }
    async function quit() {
        const exited = once(child!, 'exit');
        // E2E専用capabilityで正常終了する。通常アプリに終了用の権限を追加しない。
        await page!.evaluate(() => { void (window as any).__TAURI__.core.invoke('plugin:process|exit', { code: 0 }); });
        const [code] = await Promise.race([exited, new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('Hostが正常終了しませんでした')), 10_000); timer.unref();
        })]);
        expect(code).toBe(0);
        await browser!.close();
        browser = undefined;
        child = undefined;
    }
    try {
        await launch();
        await page!.getByRole('tab', { name: '外観', exact: true }).click();
        await page!.getByRole('combobox', { name: '表示言語' }).selectOption('en');
        await expect(page!.getByRole('combobox', { name: 'Display language' })).toHaveValue('en');
        await expect.poll(async () => {
            try { return JSON.parse(await readFile(join(root, 'config', 'display-locale.json'), 'utf8')).locale; }
            catch { return null; }
        }).toBe('en');

        // 保存操作を伴わない表示・開閉だけを実UIで確認する。
        await expect(page!.getByText('A light background with teal accents.')).toBeVisible();
        await page!.screenshot({ path: testInfo.outputPath('native-appearance.png') });
        await page!.getByRole('tab', { name: 'Audio', exact: true }).click();
        await expect(page!.getByRole('combobox', { name: 'Connection method' })).toBeVisible({ timeout: 30_000 });
        const redetect = page!.getByRole('button', { name: 'Re-detect', exact: true });
        const size = await redetect.boundingBox();
        expect(size).not.toBeNull();
        expect(size!.width).toBeGreaterThanOrEqual(24);
        expect(size!.height).toBeGreaterThanOrEqual(24);
        const tuning = page!.locator('details').filter({ has: page!.locator('summary').filter({ hasText: 'Dropouts and sample rate' }) });
        await expect(tuning).not.toHaveAttribute('open', '');
        await tuning.locator('summary').click();
        await expect(tuning).toHaveAttribute('open', '');
        await tuning.locator('summary').click();
        await expect(tuning).not.toHaveAttribute('open', '');
        await page!.screenshot({ path: testInfo.outputPath('native-audio.png') });

        await page!.getByRole('tab', { name: 'OBS', exact: true }).click();
        const preview = page!.getByRole('button', { name: 'Review proposed changes' });
        await expect(preview).toBeDisabled();
        await expect(page!.getByText('Connect to OBS to use this.')).toBeVisible();
        await expect(preview).toHaveAccessibleDescription('Connect to OBS to use this.');
        await page!.screenshot({ path: testInfo.outputPath('native-obs.png') });

        await page!.getByRole('tab', { name: 'System', exact: true }).click();
        await expect(page!.getByRole('button', { name: 'Reset blocklist', exact: true })).toBeVisible();
        const reset = page!.getByRole('button', { name: 'Reset all', exact: true });
        await expect(reset).toBeVisible();
        await expect(reset).toHaveClass(/\bbg-destructive\b/);
        await page!.screenshot({ path: testInfo.outputPath('native-system.png') });

        // この隔離Hostだけで登録し、正常終了時にOS登録を解放する。
        await page!.getByRole('tab', { name: 'Hotkeys', exact: true }).click();
        const mute = page!.getByRole('group', { name: 'Toggle mute' });
        await mute.getByText('Choose from a list').click();
        await mute.getByRole('combobox', { name: 'Toggle mute modifier' }).selectOption('Alt+Shift');
        await mute.getByRole('combobox', { name: 'Toggle mute regular key' }).selectOption('F11');
        await page!.getByRole('button', { name: 'Save key settings' }).click();
        await expect(page!.getByText('Key settings saved.', { exact: true })).toBeVisible();
        const expectedBinding = { action: 'muteToggle', shortcut: 'Alt+Shift+F11' };
        const savedStatus = await page!.evaluate(() => (window as any).__TAURI__.core.invoke('get_shortcuts'));
        expect(savedStatus.errors).toEqual([]);
        expect(savedStatus.bindings).toContainEqual(expectedBinding);
        const persisted = JSON.parse(await readFile(join(root, 'config', 'shortcuts.json'), 'utf8'));
        expect(persisted).toContainEqual(expectedBinding);
        await page!.screenshot({ path: testInfo.outputPath('native-hotkeys.png') });
        await quit();
        await launch();
        await page!.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await expect(page!.getByRole('combobox', { name: 'Display language' })).toHaveValue('en');
        const restoredStatus = await page!.evaluate(() => (window as any).__TAURI__.core.invoke('get_shortcuts'));
        expect(restoredStatus.errors).toEqual([]);
        expect(restoredStatus.bindings).toContainEqual(expectedBinding);
        await page!.getByRole('tab', { name: 'Hotkeys', exact: true }).click();
        await expect(page!.getByRole('group', { name: 'Toggle mute' }).getByRole('button', { name: 'Enter keys for Toggle mute', exact: true })).toHaveText('Alt + Shift + F11');
        // モックを介さず、実sidecarの要求・応答とJSONデコードを確認する。
        const stats = await page!.evaluate(() => (window as any).__TAURI__.core.invoke('get_engine_runtime_stats'));
        expect(stats.activePluginCount).toBe(0);
        expect(stats.glitchCount).toBe(0);
        const stream = await page!.evaluate(() => (window as any).__TAURI__.core.invoke('auto_gain', { request: { action: 'status' } }));
        expect(stream.running).toBe(false);
        expect(stream.streamFailed).toBe(false);
        await page!.getByRole('tab', { name: 'System', exact: true }).click();
        await page!.locator('summary').filter({ hasText: /^Diagnostics$/ }).click();
        await page!.getByRole('button', { name: 'Refresh statistics', exact: true }).click();
        await expect(page!.getByRole('row', { name: /^Loaded / }).getByRole('cell')).toHaveText(String(stats.activePluginCount));
        // 登録されていない実コマンドは拒否される。通信失敗を成功へ変換しない。
        const rejected = await page!.evaluate(async () => {
            try { await (window as any).__TAURI__.core.invoke('e2e_missing_command'); return false; }
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

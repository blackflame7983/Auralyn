import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

test('実UI→Tauri→保存→Host再起動で言語を復元し、実エンジンの応答を表示する', async ({}, testInfo) => {
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
        await quit();
        await launch();
        await page!.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await expect(page!.getByRole('combobox', { name: 'Display language' })).toHaveValue('en');
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

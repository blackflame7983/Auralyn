import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

// 製品のスキャナーは全VSTを列挙するため、隔離設定で試験対象以外の実ファイルを除外する。
async function excludedVsts(root: string): Promise<string[]> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
    const result: string[] = [];
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) result.push(...await excludedVsts(path));
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.vst3') && path.toLowerCase() !== 'c:\\program files\\common files\\vst3\\tdr nova.vst3') result.push(path);
    }
    return result;
}

test.use({ actionTimeout: 12_000 });
test.skip(process.env.AURALYN_MIXING_UI_ZOOM !== '1', 'ズーム権限を付与した隔離 Host で実行する');

test('隔離した実Tauriでミックス設定と配信VSTをキーボード操作する', async ({}, info) => {
    test.setTimeout(240_000);
    const root = process.env.AURALYN_E2E_ROOT, binary = process.env.AURALYN_E2E_BINARY;
    if (!root || !binary) throw new Error('隔離Hostの実行環境が必要です');
    await mkdir(join(root, 'config'), { recursive: true });
    const blacklist = [...await excludedVsts('C:\\Program Files\\Common Files\\VST3'), ...await excludedVsts('C:\\Program Files\\Steinberg\\VST3')];
    await writeFile(join(root, 'config', 'vst_blacklist.json'), JSON.stringify({ paths: blacklist }));
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('CDP port unavailable');
    const port = address.port; await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    const errors: string[] = [];
    let child: ChildProcess | undefined, browser: Browser | undefined, page: Page | undefined;
    try {
        child = spawn(binary, ['--auralyn-review'], { cwd: dirname(binary), windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.on('error', e => errors.push(e.message)); child.stderr!.on('data', () => {}); child.stdout!.on('data', () => {});
        await writeFile(info.outputPath('connection.json'), JSON.stringify({ pid: child.pid, cdpPort: port }, null, 2));
        await expect.poll(async () => { if (child!.exitCode !== null) throw new Error(`Host exited: ${child!.exitCode}`); try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        await expect.poll(() => context.pages().some(p => p.url().startsWith('http://127.0.0.1:1427')), { timeout: 20_000 }).toBe(true);
        page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:1427'))!;
        page.on('pageerror', e => errors.push(e.message));
        const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible({ timeout: 30_000 });
        await page.setViewportSize({ width: 900, height: 600 });
        const englishAppearance = dialog.getByRole('tab', { name: 'Appearance', exact: true });
        if (await englishAppearance.count()) {
            await englishAppearance.click();
            await dialog.getByRole('combobox', { name: 'Display language' }).selectOption('ja');
        }
        await dialog.getByRole('tab', { name: 'オーディオ', exact: true }).click();
        // 配信ミックスはホームのパネルで操作する（#299）。設定からパネルを出して開く。
        await dialog.getByRole('button', { name: 'ホームで開く', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const panel = page.locator('#stream-mix-panel'); await expect(panel).toBeVisible({ timeout: 30_000 });
        const post = panel.locator('details').filter({ has: page.locator('summary').getByText('配信音を仕上げるVST', { exact: true }) }).last();
        await post.locator('summary').first().focus(); await page.keyboard.press('Enter');
        const add = post.getByRole('button', { name: 'VSTを追加' }); await expect(add).toBeEnabled({ timeout: 30_000 });
        for (let i = 0; i < 2; i++) {
            await add.focus(); await page.keyboard.press('Enter');
            const nova = page.getByRole('button', { name: 'TDR Nova を追加' });
            await expect(nova).toBeVisible({ timeout: 90_000 }); await nova.focus(); await page.keyboard.press('Enter');
            await expect(post.getByRole('button', { name: 'TDR Novaを並べ替え' })).toHaveCount(i + 1, { timeout: 30_000 });
        }
        const readPost = () => page!.evaluate(() => (window as any).__TAURI__.core.invoke('post_mix', { request: { action: 'snapshot' } }));
        const before = await readPost(); expect(before.plugins).toHaveLength(2);
        const handle = post.getByRole('button', { name: 'TDR Novaを並べ替え' }).first();
        await handle.scrollIntoViewIfNeeded(); await handle.focus(); await expect(handle).toBeFocused();
        await page.keyboard.press('Space');
        const announcements = page.locator('[aria-live]').filter({ hasText: 'TDR Nova' });
        await expect(announcements).toContainText('並べ替えを開始', { timeout: 5000 });
        await page.keyboard.press('ArrowDown');
        await expect(announcements).toContainText('移動します', { timeout: 5000 });
        await page.keyboard.press('Space');
        await expect(announcements).toContainText('確定しました', { timeout: 5000 });
        await expect.poll(async () => (await readPost()).plugins.map((p: { id: string }) => p.id), { timeout: 15_000 }).toEqual([before.plugins[1].id, before.plugins[0].id]);
        await page.screenshot({ path: info.outputPath('post-ja.png') });
        await writeFile(info.outputPath('post-ja-aria.txt'), await post.ariaSnapshot());
        const recovery = post.locator('details').filter({ has: page.locator('summary').getByText('保存設定を復旧する', { exact: true }) });
        await recovery.locator('summary').focus(); await page.keyboard.press('Enter');
        await recovery.getByRole('checkbox', { name: '保存状態を保管して配信VSTを無効にします。' }).focus(); await page.keyboard.press('Space');
        await recovery.getByRole('button', { name: '保存状態を保管して無効にする' }).focus(); await page.keyboard.press('Enter');
        await expect(recovery.getByRole('status')).toContainText('保存状態の記録を残し');
        await writeFile(info.outputPath('post-reset-aria.txt'), await recovery.ariaSnapshot());
        expect((await readPost()).plugins).toHaveLength(0);
        const mixing = panel.locator('#mixing-settings');
        await mixing.locator('summary').first().focus(); await page.keyboard.press('Enter');
        const voice = mixing.getByRole('slider', { name: '声の音量' });
        await expect(voice).toBeVisible({ timeout: 30_000 });
        await voice.focus(); await page.keyboard.press('ArrowLeft'); await expect(voice).toHaveAttribute('aria-valuetext', '99%');
        const source = mixing.getByRole('combobox', { name: 'オケの入力元' });
        await source.focus(); await page.keyboard.press('End'); await expect(source).toHaveValue('process');
        const apply = mixing.getByRole('button', { name: '入力元を適用' });
        await expect(apply).toBeDisabled(); await expect(apply).toHaveAccessibleDescription(/配信用の出力先/);
        await page.screenshot({ path: info.outputPath('mixing-ja.png') });
        await writeFile(info.outputPath('mixing-ja-aria.txt'), await mixing.ariaSnapshot());
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        await dialog.getByRole('tab', { name: '外観', exact: true }).click();
        await dialog.getByRole('combobox', { name: '表示言語' }).selectOption('en');
        await page.setViewportSize({ width: 1024, height: 768 });
        const originalDpr = await page.evaluate(() => devicePixelRatio);
        // 隔離ビルド専用 capability を通し、WebView2 自体のズームを変更する。
        await page.evaluate(() => (window as any).__TAURI__.core.invoke('plugin:webview|set_webview_zoom', { label: 'main', value: 1.5 }));
        await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
        if (!await mixing.evaluate(el => (el as HTMLDetailsElement).open)) { await mixing.locator('summary').first().focus(); await page.keyboard.press('Enter'); }
        await expect(mixing.getByRole('slider', { name: 'Voice volume' })).toBeVisible();
        await mixing.getByRole('slider', { name: 'Voice volume' }).focus(); await page.keyboard.press('ArrowRight');
        await page.screenshot({ path: info.outputPath('mixing-en-zoom.png') });
        await writeFile(info.outputPath('mixing-en-aria.txt'), await mixing.ariaSnapshot());
        const zoom = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio, visualScale: visualViewport?.scale }));
        await writeFile(info.outputPath('zoom.json'), JSON.stringify({ originalDpr, ...zoom }, null, 2));
        expect(zoom.devicePixelRatio / originalDpr).toBeCloseTo(1.5, 1);
        const stream = await page.evaluate(() => (window as any).__TAURI__.core.invoke('auto_gain', { request: { action: 'status' } }));
        expect(stream.running).toBe(false);
        expect(errors).toEqual([]);
    } finally {
        if (page && !page.isClosed()) {
            if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
            await page.evaluate(() => { void (window as any).__TAURI__.core.invoke('plugin:process|exit', { code: 0 }); }).catch(() => {});
        }
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
            if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
        }
        await browser?.close();
    }
});

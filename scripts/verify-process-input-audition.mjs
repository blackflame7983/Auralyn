// 埋込みフロントの試聴用アプリを、開発サーバーなしで起動・確認する。
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
const [directory, cliPath, exerciseSources] = process.argv.slice(2);
if (!directory || !cliPath) throw new Error('audition-directory mcp-cli-path が必要です');
const root = resolve(directory);
const results = join(root, 'verification-' + Date.now()); mkdirSync(results);
const allocation = createServer(); allocation.listen(0, '127.0.0.1'); await once(allocation, 'listening');
const port = allocation.address().port; await new Promise(resolve => allocation.close(resolve));
const child = spawn(join(root, 'bin', 'AuralynHost.exe'), ['--auralyn-review'], { cwd: root, windowsHide: true,
    env: { ...process.env, AURALYN_DISABLE_PERF_TWEAKS: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const cli = args => {
    const result = spawnSync(process.execPath, [resolve(cliPath), ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
};
let browser, page, connected = false;
const summary = { passed: false, mode: exerciseSources ?? 'prepare' };
try {
    await expect.poll(async () => { if (child.exitCode !== null) throw new Error('Host exited'); try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await expect.poll(() => { summary.pages = browser.contexts()[0].pages().map(page => page.url()); return summary.pages.some(url => /^https?:\/\/tauri\.localhost/.test(url)); }, { timeout: 20_000 }).toBe(true);
    page = browser.contexts()[0].pages().find(page => /^https?:\/\/tauri\.localhost/.test(page.url()));
    summary.url = page.url();
    const ports = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -OwningProcess ${child.pid} -State Listen | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
    const bridge = (Array.isArray(ports) ? ports : [ports]).filter(port => port >= 9223 && port <= 9323);
    if (bridge.length !== 1) throw new Error('own bridge not identified');
    cli(['driver-session', 'start', '--host', '127.0.0.1', '--port', String(bridge[0])]); connected = true;
    const status = cli(['driver-session', 'status', '--json']);
    writeFileSync(join(results, 'driver-status.json'), status);
    const envelope = JSON.parse(status);
    const state = envelope.text ? JSON.parse(envelope.text) : envelope;
    if (!state.connected) throw new Error('bridge not connected');
    const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
    summary.profiles = await invoke('list_profiles');
    if (!summary.profiles.some(profile => profile.name === '入力試聴 TDR Nova')) throw new Error('prepared profile missing');
    const applied = await invoke('apply_profile', { name: '入力試聴 TDR Nova', currentPluginIds: [], backupPlugins: [], skipBackup: true, soundOnly: true });
    if (applied.loadedPluginInstances?.length !== 1 || applied.appliedAudioConfig) throw new Error('VST-only profile did not apply');
    summary.profileApplied = applied;
    summary.stream = await invoke('auto_gain', { request: { action: 'status' } });
    if (summary.stream.running) throw new Error('unrequested audio stream running');
    const source = (await invoke('get_process_input_sources')).find(source => source.name === 'chrome.exe' && source.routes.some(route => route.name.startsWith('1 - FS2333')));
    const devices = await invoke('get_audio_devices', { forceRefresh: false });
    const output = devices.outputs.find(device => device.is_default && device.host.toLowerCase() === 'wasapi');
    if ((!source || !output) && exerciseSources !== '--startup-only') throw new Error('test routing choices missing');
    const preferred = source && output ? { host: output.host, output: output.name, outputId: output.id, sampleRate: 48000, bufferSize: 512,
        inputSource: { kind: 'process_loopback', config: { appKey: source.appKey, appName: source.name,
            rawEndpointId: source.routes.find(route => route.name.startsWith('1 - FS2333')).id, purpose: 'music' } } }
        : await page.evaluate(() => JSON.parse(localStorage.getItem('vst_host_audio_config')));
    if (preferred?.inputSource?.kind !== 'process_loopback') throw new Error('saved process input preferences missing');
    await page.evaluate(value => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify(value));
        localStorage.removeItem('vst_host_session_plugins');
    }, preferred);
    for (const plugin of applied.loadedPluginInstances) await invoke('remove_plugin', { id: plugin.id });
    await page.reload();
    // プロセスの再選択を促す設定画面が遅延描画されるまで待つ。
    await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('combobox', { name: '入力元', exact: true })).toHaveValue('process', { timeout: 20_000 });
    await expect(page.getByRole('combobox', { name: '入力の用途' })).toHaveValue('music');
    summary.preferred = preferred;
    cli(['webview-screenshot', '--file', join(results, 'audition-ready.png')]);
    await page.getByRole('button', { name: '設定画面を閉じる', exact: true }).click();
    const rackToggle = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rackToggle.getAttribute('aria-expanded') !== 'true') await rackToggle.click();
    await page.getByRole('button', { name: 'プロファイル管理', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '音づくりだけを呼び出す（入出力と入出力音量を保持）' })).toBeChecked();
    await page.getByRole('button', { name: '入力試聴 TDR Novaを適用', exact: true }).click();
    await page.getByRole('button', { name: '適用する', exact: true }).click();
    await expect.poll(async () => (await invoke('get_engine_runtime_stats')).activePluginCount, { timeout: 20_000 }).toBe(1);
    summary.profileUiApplied = true;
    summary.streamAfterUi = await invoke('auto_gain', { request: { action: 'status' } });
    if (summary.streamAfterUi.running) throw new Error('profile UI started audio');
    cli(['webview-screenshot', '--file', join(results, 'profile-ready.png')]);
    if (exerciseSources === '--exercise-sources') {
        summary.realAppStarts = [];
        await page.keyboard.press('Escape');
        for (const appName of ['chrome.exe', 'vlc.exe']) {
            await page.getByRole('button', { name: '設定を開く', exact: true }).click();
            await page.getByRole('button', { name: 'アプリ一覧を更新', exact: true }).click();
            const app = (await invoke('get_process_input_sources')).find(source => source.name === appName
                && source.routes.some(route => route.name.startsWith(appName === 'chrome.exe' ? '1 - FS2333' : 'Realtek Digital Output')));
            if (!app) throw new Error('owned active app missing: ' + appName);
            await page.getByRole('combobox', { name: '再生中のアプリ' }).selectOption(app.id);
            await page.getByRole('combobox', { name: '入力の用途' }).selectOption('music');
            await invoke('set_global_mute', { active: true });
            await page.getByRole('button', { name: /保存して(開始|再起動)/ }).click();
            await expect(page.getByRole('dialog', { name: '設定', exact: true })).toHaveCount(0, { timeout: 20_000 });
            await expect.poll(async () => (await invoke('get_engine_runtime_stats')).processInput?.nonzeroFrames ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000);
            const stats = await invoke('get_engine_runtime_stats');
            if (stats.enabledPluginCount !== 1 || stats.processInput.failed) throw new Error('real app pipeline failed');
            summary.realAppStarts.push({ appName, stats, state: await invoke('get_audio_state') });
            cli(['webview-screenshot', '--file', join(results, appName + '-running.png')]);
            await invoke('stop_audio');
        }
        await invoke('set_global_mute', { active: false });
    }
    summary.passed = true;
    await invoke('plugin:process|exit', { code: 0 });
} catch (error) {
    summary.error = String(error);
    if (page) await page.screenshot({ path: join(results, 'failure.png') }).catch(() => {});
} finally {
    if (exerciseSources === '--exercise-sources' && page && !page.isClosed()) {
        await page.evaluate(async () => {
            await window.__TAURI__.core.invoke('stop_audio');
            await window.__TAURI__.core.invoke('set_global_mute', { active: false });
        }).catch(() => {});
    }
    if (connected) { try { cli(['driver-session', 'stop']); } catch {} }
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    writeFileSync(join(results, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ root, passed: summary.passed, error: summary.error }));
}
process.exitCode = summary.passed ? 0 : 1;

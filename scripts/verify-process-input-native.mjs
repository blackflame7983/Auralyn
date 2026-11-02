// 明示実行専用。通常の設定・再生アプリを変更せず、実Tauriと実sidecarを接続する。
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';

const { values: args } = parseArgs({ options: {
    probe: { type: 'string' }, 'source-endpoint': { type: 'string' }, 'output-endpoint': { type: 'string' }, 'mcp-cli': { type: 'string' },
} });
for (const key of ['probe', 'source-endpoint', 'output-endpoint', 'mcp-cli']) if (!args[key]) throw new Error(`--${key} が必要です`);
const probe = resolve(args.probe);
const root = mkdtempSync(join(tmpdir(), 'Auralyn-process-input-'));
const target = resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target/native-e2e');
const config = { identifier: 'com.auralyn.test.processinput', build: { devUrl: 'http://127.0.0.1:1427' }, bundle: { externalBin: [] },
    app: { appDirectoriesOverride: { config: join(root, 'config'), data: join(root, 'data'), localData: join(root, 'webview'), cache: join(root, 'cache'), log: join(root, 'logs') },
        security: { capabilities: ['default', { identifier: 'e2e-exit', windows: ['main'], permissions: ['process:allow-exit'] }] } } };
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: '0', CARGO_INCREMENTAL: '0', TAURI_CONFIG: JSON.stringify(config), AURALYN_DISABLE_PERF_TWEAKS: '1' };
console.log(JSON.stringify({ root, phase: 'build' }));
const build = spawnSync('cargo', ['build', '--offline', '--locked', '--bin', 'AuralynHost', '--bin', 'audio_engine', '--bin', 'plugin_scanner'], { cwd: resolve('src-tauri'), env, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(join(root, 'bin'));
for (const name of ['AuralynHost', 'audio_engine', 'plugin_scanner']) copyFileSync(join(target, 'debug', `${name}.exe`), join(root, 'bin', `${name}.exe`));
const owned = [];
function start(command, parameters, options = {}) {
    const child = spawn(command, parameters, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    owned.push(child);
    child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
    return child;
}
function probeJson(parameters) { return JSON.parse(execFileSync(probe, parameters, { encoding: 'utf8', windowsHide: true })); }
const before = probeJson(['endpoints']);
const raw = before.find(device => device.id === args['source-endpoint']);
const output = before.find(device => device.id === args['output-endpoint']);
if (!raw || !output || raw.default_roles.length || raw.active_processes.length || raw.id === output.id) throw new Error('未使用の別再生先と本人用出力を指定してください');
const summary = { passed: false, audibleMonitorTested: false };
let browser, page, guardReady, cliConnected = false;
function cli(parameters) {
    const result = spawnSync(process.execPath, [resolve(args['mcp-cli']), ...parameters], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`MCP CLI: ${result.stderr}`);
    return result.stdout;
}
async function port() {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
try {
    const availability = createServer();
    await new Promise((resolve, reject) => { availability.once('error', reject); availability.listen(1427, '127.0.0.1', resolve); });
    await new Promise(resolve => availability.close(resolve));
    const vite = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1427', '--strictPort']);
    await expect.poll(async () => { if (vite.exitCode !== null) throw new Error('専用Viteを起動できません'); try { return (await fetch('http://127.0.0.1:1427')).ok; } catch { return false; } }, { timeout: 20_000 }).toBe(true);
    const cdp = await port();
    const host = start(join(root, 'bin', 'AuralynHost.exe'), ['--auralyn-review'], { cwd: join(root, 'bin'), env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdp} --remote-debugging-address=127.0.0.1` } });
    await expect.poll(async () => { if (host.exitCode !== null) throw new Error('隔離Hostが接続前に終了しました'); try { return (await fetch(`http://127.0.0.1:${cdp}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
    await expect.poll(() => browser.contexts()[0].pages().some(p => p.url().startsWith('http://127.0.0.1:1427'))).toBe(true);
    page = browser.contexts()[0].pages().find(p => p.url().startsWith('http://127.0.0.1:1427'));
    const ports = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -OwningProcess ${host.pid} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
    const bridge = (Array.isArray(ports) ? ports : [ports]).filter(p => p >= 9223 && p <= 9323);
    if (bridge.length !== 1) throw new Error('この隔離HostのMCP接続先を一意に確認できません');
    cli(['driver-session', 'start', '--host', '127.0.0.1', '--port', String(bridge[0])]); cliConnected = true;
    const status = cli(['driver-session', 'status', '--json']);
    writeFileSync(join(root, 'driver-status.json'), status);
    const envelope = JSON.parse(status);
    const driverStatus = envelope.text ? JSON.parse(envelope.text) : envelope;
    if (!driverStatus.connected || !driverStatus.identifier) throw new Error('MCP driverが接続されていません');
    cli(['webview-screenshot', '--file', join(root, 'before.png')]);
    guardReady = join(root, 'muted.ready.json');
    start(probe, ['hold-endpoint-muted', raw.id, '120', guardReady]);
    await expect.poll(() => existsSync(guardReady)).toBe(true);
    const sourceBinary = join(root, 'test_player.exe'); copyFileSync(probe, sourceBinary);
    const sourceReady = join(root, 'source.ready.json');
    start(sourceBinary, ['source-low-volume', '100', sourceReady, raw.id, '587']);
    await expect.poll(() => existsSync(sourceReady)).toBe(true);
    const invoke = (command, parameters = {}) => page.evaluate(({ command, parameters }) => window.__TAURI__.core.invoke(command, parameters), { command, parameters });
    const sources = await invoke('get_process_input_sources');
    const candidate = sources.find(source => source.name === 'test_player.exe');
    if (!candidate || candidate.routes.length !== 1 || !candidate.routes[0].muted) throw new Error('実sourceの候補と別再生先を取得できません');
    summary.candidate = candidate;
    const refreshed = await invoke('get_process_input_sources');
    if (refreshed.find(source => source.name === 'test_player.exe')?.id !== candidate.id) throw new Error('同じプロセスの候補IDが更新で変わりました');
    const hostSelector = page.getByRole('combobox', { name: '接続方式', exact: true });
    await expect(hostSelector).toBeVisible({ timeout: 20_000 });
    const hosts = await hostSelector.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    await hostSelector.selectOption(hosts.find(name => name.toLowerCase() === 'wasapi'));
    await page.getByRole('combobox', { name: '入力元', exact: true }).selectOption('process');
    await page.getByRole('combobox', { name: '再生中のアプリ' }).selectOption({ label: 'test_player.exe' });
    await page.getByRole('combobox', { name: '入力の用途' }).selectOption('music');
    const outputSelector = page.getByRole('combobox', { name: '出力先', exact: true });
    await outputSelector.selectOption('id:wasapi:' + output.id);
    await page.getByRole('button', { name: /保存して(開始|再起動)/ }).click();
    await expect(page.getByRole('dialog', { name: '設定', exact: true })).toHaveCount(0, { timeout: 20_000 });
    await invoke('set_global_mute', { active: false });
    await expect.poll(async () => (await invoke('get_engine_runtime_stats')).processInput?.nonzeroFrames ?? 0).toBeGreaterThan(1000);
    summary.state = await invoke('get_audio_state'); summary.stats = await invoke('get_engine_runtime_stats');
    summary.saved = JSON.parse(readFileSync(join(root, 'config', 'last_audio_config.json'), 'utf8'));
    if (summary.state.config.input_id || summary.saved.input_source.kind !== 'process_loopback' || JSON.stringify(summary.saved).includes('candidateId') || JSON.stringify(summary.saved).includes('"pid"')) throw new Error('起動・保存した入力形式が不正です');
    await invoke('stop_audio');
    await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '再生中のアプリ' })).toHaveValue('');
    await page.screenshot({ path: join(root, 'process-input.png') });
    await invoke('plugin:process|exit', { code: 0 });
    summary.passed = true;
} catch (error) {
    summary.error = String(error);
    if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
} finally {
    if (cliConnected) { try { cli(['driver-session', 'stop']); } catch {} }
    if (browser) await browser.close().catch(() => {});
    for (const child of owned.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]); }
    if (guardReady) {
        const snapshot = guardReady.replace(/\.json$/, '.restore.json');
        if (existsSync(snapshot)) execFileSync(probe, ['restore-endpoint', snapshot], { windowsHide: true });
    }
    const after = probeJson(['endpoints']);
    summary.endpointStatePreserved = before.every(device => ['muted', 'volume', 'default_roles'].every(key => JSON.stringify(device[key]) === JSON.stringify(after.find(current => current.id === device.id)?.[key])));
    if (!summary.endpointStatePreserved) summary.passed = false;
    writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ root, passed: summary.passed, error: summary.error }));
}
process.exitCode = summary.passed ? 0 : 1;

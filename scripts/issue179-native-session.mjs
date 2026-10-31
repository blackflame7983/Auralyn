// #179の実機確認専用。通常設定とビルドを分離し、終了時はこの起動の子だけを回収する。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

if (process.platform !== 'win32') throw new Error('Windows専用');
// 応答のある別サーバーを、この起動のViteと誤認しない。
const portCheck = createServer();
await new Promise((resolve, reject) => { portCheck.once('error', reject); portCheck.listen(1427, '127.0.0.1', resolve); });
await new Promise((resolve, reject) => portCheck.close(error => error ? reject(error) : resolve()));
const root = mkdtempSync(join(tmpdir(), 'Auralyn-issue179-'));
const target = resolve('src-tauri/target/native-e2e');
const config = {
    identifier: 'com.auralyn.test.e2e',
    build: { devUrl: 'http://127.0.0.1:1427' },
    bundle: { externalBin: [] },
    app: {
        appDirectoriesOverride: { config: join(root, 'config'), data: join(root, 'data'), localData: join(root, 'webview'), cache: join(root, 'cache'), log: join(root, 'logs') },
        security: { capabilities: ['default', { identifier: 'e2e-exit', windows: ['main'], permissions: ['process:allow-exit'] }] },
    },
};
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: '0', TAURI_CONFIG: JSON.stringify(config) };
const build = spawnSync('cargo', ['build', '--locked', '--bin', 'AuralynHost', '--bin', 'audio_engine', '--bin', 'plugin_scanner'], {
    cwd: resolve('src-tauri'), env, windowsHide: true, stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(join(root, 'bin'));
mkdirSync(join(root, 'results'));
for (const name of ['AuralynHost', 'audio_engine', 'plugin_scanner']) copyFileSync(join(target, 'debug', `${name}.exe`), join(root, 'bin', `${name}.exe`));
const allocation = createServer();
allocation.listen(0, '127.0.0.1');
await once(allocation, 'listening');
const port = allocation.address().port;
await new Promise(resolve => allocation.close(resolve));
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1427', '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let viteListening = false;
let viteFailure = null;
vite.stderr.on('data', () => {});
vite.stdout.on('data', data => { if (data.toString().includes('127.0.0.1:1427')) viteListening = true; });
vite.once('error', error => { viteFailure = error; });
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
    if (viteFailure || vite.exitCode !== null) { vite.kill(); throw new Error('専用Viteを起動できません', { cause: viteFailure }); }
    try { ready = viteListening && (await fetch('http://127.0.0.1:1427')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) { vite.kill(); throw new Error('専用Viteの起動待ちがタイムアウトしました'); }
const host = spawn(join(root, 'bin', 'AuralynHost.exe'), ['--auralyn-review'], {
    cwd: join(root, 'bin'), windowsHide: true,
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
    stdio: ['ignore', 'pipe', 'pipe'],
});
// 検証中に専用フロントが失われた結果を成功扱いしない。
vite.once('exit', () => {
    if (host.exitCode === null) { process.exitCode = 1; host.kill(); }
});
host.stdout.on('data', () => {});
host.stderr.on('data', () => {});
const session = { root, binary: join(root, 'bin', 'AuralynHost.exe'), port, hostPid: host.pid, vitePid: vite.pid };
writeFileSync(join(root, 'session.json'), JSON.stringify(session, null, 2));
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/issue179-session.json', JSON.stringify(session, null, 2));
console.log(JSON.stringify(session));
const timeout = setTimeout(() => { host.kill(); }, 30 * 60 * 1000);
process.once('SIGINT', () => { host.kill(); vite.kill(); });
try { await once(host, 'exit'); } finally { clearTimeout(timeout); vite.kill(); }

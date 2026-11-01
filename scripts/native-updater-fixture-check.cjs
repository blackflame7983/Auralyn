// 署名付き更新の隔離フィクスチャ。実行には事前レビューが必要。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');

const port = 18762;
const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'node_modules/@tauri-apps/cli/tauri.js');
const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function plainPath(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.relative(current, path.resolve(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error(`reparse path rejected: ${current}`);
    // Windows junctions and symlinks are both exposed as symbolic links by lstat.
  }
}
function child(command, args, root) {
  // 親プロセスの署名用環境変数を子へ渡さず、出力もすべて破棄する。
  const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp') };
  const result = spawnSync(command, args, { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
  if (result.error || result.status !== 0) throw Error(`child failed: ${path.basename(command)} (status ${result.status})`);
}
function prepare(rootArg) {
  const root = path.resolve(rootArg);
  assert(/^updater-fixture-[a-z0-9]+$/i.test(path.basename(root)), 'fixture directory must start with updater-fixture-');
  plainPath(path.dirname(root));
  fs.mkdirSync(root);
  for (const name of ['temp', 'bin', 'config', 'data', 'localData', 'cache', 'log']) fs.mkdirSync(path.join(root, name));
  const marker = path.join(root, 'launcher-marker.txt');
  const source = path.join(root, 'launcher.cs');
  const manifest = path.join(root, 'launcher.manifest');
  const exe = path.join(root, 'launcher.exe');
  fs.writeFileSync(source, `using System.IO;\nclass Fixture { static void Main() { using (var f = new FileStream(${JSON.stringify(marker)}, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var w = new StreamWriter(f)) w.Write("auralyn-updater-fixture"); } }\n`, { flag: 'wx' });
  fs.writeFileSync(manifest, '<?xml version="1.0" encoding="utf-8"?><assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>', { flag: 'wx' });
  child(csc, ['/nologo', '/target:winexe', `/win32manifest:${manifest}`, `/out:${exe}`, source], root);
  const privateKey = path.join(root, 'test-only.key');
  child(process.execPath, [cli, 'signer', 'generate', '-w', privateKey, '--ci'], root);
  child(process.execPath, [cli, 'signer', 'sign', '--private-key-path', privateKey, exe], root);
  const pubkey = fs.readFileSync(`${privateKey}.pub`, 'utf8').trim();
  const signature = fs.readFileSync(`${exe}.sig`, 'utf8').trim();
  const url = `http://127.0.0.1:${port}`;
  const config = { identifier: `com.auralyn.fixture.${crypto.randomBytes(8).toString('hex')}`, app: { appDirectoriesOverride: Object.fromEntries(['config', 'data', 'localData', 'cache', 'log'].map(name => [name, path.join(root, name)])) }, plugins: { updater: { dangerousInsecureTransportProtocol: true, endpoints: [`${url}/latest.json`], pubkey } } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify({ version: '99.0.0', notes: 'Test launcher only', pub_date: '2026-01-01T00:00:00Z', platforms: { 'windows-x86_64': { signature, url: `${url}/launcher.exe` } } }, null, 2), { flag: 'wx' });
  const report = { root, config: path.join(root, 'config.json'), host: path.join(root, 'bin', 'AuralynHost.exe'), source, sourceSha256: sha256(source), executable: exe, executableSha256: sha256(exe), marker, endpoint: `${url}/latest.json`, scope: 'test launcher proof only; not an NSIS installation' };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
function assert(condition, message) { if (!condition) throw Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function inside(root, file) { return path.resolve(file).toLowerCase() === path.resolve(root).toLowerCase(); }
function fixed(root, file, expected) { assert(inside(file, path.join(root, expected)), `unexpected ${expected} path`); plainPath(file); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timeout`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function run(rootArg, dryRun = false) {
  const root = path.resolve(rootArg);
  assert(/^updater-fixture-[a-z0-9]+$/i.test(path.basename(root)), 'invalid fixture root');
  const python = process.env.AURALYN_TEST_PYTHON;
  assert(python && path.isAbsolute(python) && fs.statSync(python).isFile(), 'AURALYN_TEST_PYTHON must name the installed Python executable');
  const observerEnv = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp') };
  const pathCheck = spawnSync(python, [path.join(repo, 'scripts/native_updater_registry_fixture.py'), '--check-paths', root], { env: observerEnv, windowsHide: true, encoding: 'utf8' });
  assert(!pathCheck.error && pathCheck.status === 0, 'fixture has a reparse point or invalid path');
  plainPath(root);
  for (const name of ['report.json', 'config.json', 'latest.json']) plainPath(path.join(root, name));
  const report = readJson(path.join(root, 'report.json'));
  const configPath = path.join(root, 'config.json');
  const config = readJson(configPath);
  const feed = readJson(path.join(root, 'latest.json'));
  assert(inside(report.root, root), 'root mismatch');
  for (const [value, name] of [[report.config, 'config.json'], [report.host, 'bin/AuralynHost.exe'], [report.source, 'launcher.cs'], [report.executable, 'launcher.exe']]) fixed(root, value, name);
  let markerExists = true;
  try { fs.lstatSync(report.marker); } catch (error) { if (error.code === 'ENOENT') markerExists = false; else throw error; }
  assert(inside(report.marker, path.join(root, 'launcher-marker.txt')) && !markerExists, 'marker path or state invalid');
  const endpoint = `http://127.0.0.1:${port}/latest.json`;
  assert(report.endpoint === endpoint && /^com\.auralyn\.fixture\.[a-f0-9]{16}$/.test(config.identifier), 'endpoint or identifier mismatch');
  const dirs = config.app?.appDirectoriesOverride;
  assert(dirs && Object.keys(dirs).sort().join(',') === ['cache', 'config', 'data', 'localData', 'log'].sort().join(','), 'directory overrides invalid');
  for (const name of Object.keys(dirs)) fixed(root, dirs[name], name);
  assert(Object.keys(config.app).join(',') === 'appDirectoriesOverride', 'unexpected app override');
  const updater = config.plugins?.updater;
  assert(updater?.dangerousInsecureTransportProtocol === true && JSON.stringify(updater.endpoints) === JSON.stringify([endpoint]), 'updater config invalid');
  const publicKeyPath = path.join(root, 'test-only.key.pub');
  for (const file of [publicKeyPath, path.join(root, 'latest.json'), path.join(root, 'launcher.exe.sig'), path.join(root, 'launcher.manifest')]) plainPath(file);
  assert(updater.pubkey === fs.readFileSync(publicKeyPath, 'utf8').trim(), 'public key mismatch');
  const platform = feed.platforms?.['windows-x86_64'];
  assert(feed.version === '99.0.0' && platform?.url === `http://127.0.0.1:${port}/launcher.exe` && platform.signature === fs.readFileSync(path.join(root, 'launcher.exe.sig'), 'utf8').trim(), 'feed mismatch');
  assert(report.sourceSha256 === sha256(report.source) && report.executableSha256 === sha256(report.executable), 'fixture hash mismatch');
  const expectedSource = `using System.IO;\nclass Fixture { static void Main() { using (var f = new FileStream(${JSON.stringify(report.marker)}, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var w = new StreamWriter(f)) w.Write("auralyn-updater-fixture"); } }\n`;
  assert(fs.readFileSync(report.source, 'utf8') === expectedSource, 'launcher source mismatch');
  const manifest = fs.readFileSync(path.join(root, 'launcher.manifest'), 'utf8');
  assert(manifest === '<?xml version="1.0" encoding="utf-8"?><assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>', 'manifest invalid');
  const bytes = fs.readFileSync(report.executable);
  assert(bytes.subarray(0, 2).toString() === 'MZ' && (bytes.includes(Buffer.from(manifest)) || bytes.includes(Buffer.from(manifest, 'utf16le'))), 'embedded manifest invalid');
  for (const name of ['AuralynHost.exe', 'audio_engine.exe', 'plugin_scanner.exe']) { const f = path.join(root, 'bin', name); plainPath(f); assert(fs.statSync(f).isFile(), `missing ${name}`); }
  const hostHashes = Object.fromEntries(['AuralynHost.exe', 'audio_engine.exe', 'plugin_scanner.exe'].map(name => [name, sha256(path.join(root, 'bin', name))]));
  const production = readJson(path.join(repo, 'src-tauri/tauri.conf.json'));
  assert(production.app.withGlobalTauri === false, 'product global Tauri configuration changed');
  if (dryRun) {
    console.log(JSON.stringify({ stage: 'dry-run', root, configSha256: sha256(configPath), hostHashes, fixtureSha256: sha256(report.executable), marker: report.marker, endpoint, embeddedAsInvoker: true, registryWrites: false, appLaunched: false }));
    return;
  }
  // 保存先はTauri overrideで隔離する。WebView2検出に必要なWindowsの場所だけ指定し、資格情報は継承しない。
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  for (const name of ['temp', 'profile', 'roaming', 'local']) fs.mkdirSync(path.join(runtime, name));
  const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: path.join(runtime, 'temp'), TMP: path.join(runtime, 'temp'), USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !['/latest.json', '/launcher.exe'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    const body = req.url === '/latest.json' ? Buffer.from(JSON.stringify(feed)) : bytes;
    res.writeHead(200, { 'Content-Type': req.url === '/latest.json' ? 'application/json' : 'application/octet-stream', 'Content-Length': body.length }); res.end(body);
  });
  let helper, host, browser, page, helperOutput = '', helperExited = null;
  let success = false, validation = null, runFailure = null;
  const invoke = (command, args = {}) => bounded(page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }), 10000, `IPC ${command}`);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const name = `{${crypto.randomUUID()}}`;
    fs.writeFileSync(path.join(root, 'registry-ownership.json'), JSON.stringify({ name, installLocation: path.join(root, 'bin'), view: 64 }), { flag: 'wx' });
    helper = spawn(python, [path.join(repo, 'scripts/native_updater_registry_fixture.py'), name, path.join(root, 'bin')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    helper.stdin.on('error', () => {});
    helper.stdout.on('data', data => { helperOutput += data.toString(); });
    helper.once('error', () => { helperExited = -1; }); helper.once('exit', code => { helperExited = code; });
    for (let i = 0; i < 100 && !helperOutput.includes('"ready"'); i++) { assert(helperExited === null, 'registry helper failed'); await pause(100); }
    assert(helperOutput.includes('"ready"'), 'registry helper timeout');
    const allocation = net.createServer(); await new Promise((resolve, reject) => { allocation.once('error', reject); allocation.listen(0, '127.0.0.1', resolve); });
    const cdpPort = allocation.address().port; await new Promise(resolve => allocation.close(resolve));
    const outputLog = fs.openSync(path.join(root, 'host-output.log'), 'wx');
    host = spawn(report.host, ['--auralyn-review'], { cwd: path.join(root, 'bin'), env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1` }, windowsHide: true, stdio: ['ignore', outputLog, outputLog] });
    fs.closeSync(outputLog);
    fs.writeFileSync(path.join(root, 'launch.json'), JSON.stringify({ pid: host.pid, cdpPort, host: report.host }), { flag: 'wx' });
    host.on('error', () => {});
    for (let i = 0; i < 150; i++) { assert(host.exitCode === null && host.pid, 'host exited'); try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} await pause(200); }
    const { chromium } = require('@playwright/test');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 10000 });
    for (let i = 0; i < 100 && !page; i++) { page = browser.contexts()[0]?.pages().find(p => p.url().includes('tauri.localhost')); if (!page) await pause(200); }
    assert(page, 'product page unavailable');
    const response = await page.reload({ timeout: 10000 });
    const headers = await response.allHeaders();
    const csp = headers['content-security-policy'] || '';
    for (const [directive, value] of Object.entries(production.app.security.csp)) {
      const actual = csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${directive} `));
      assert(actual && value.split(' ').every(token => actual.split(/\s+/).includes(token)), `product CSP missing ${directive}`);
    }
    assert(!csp.includes('ws://localhost:1420') && !csp.includes('ws://127.0.0.1:1427'), 'development CSP detected');
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function', null, { timeout: 10000 });
    assert(await bounded(page.evaluate(() => typeof window.__TAURI__ === 'undefined'), 5000, 'global check'), 'global Tauri enabled');
    const mode = await invoke('temporary_session_status');
    assert(mode.temporary === false && mode.reviewOnly === true, 'session mode invalid');
    const audio = await invoke('auto_gain', { request: { action: 'status' } }); assert(audio.running === false, 'audio running');
    const update = await bounded(invoke('check_update'), 10000, 'update check'); assert(update?.version === '99.0.0' && update.canInstall === true, 'update eligibility invalid');
    await bounded(invoke('download_update', { version: '99.0.0' }), 10000, 'update download');
    validation = { root, config: configPath, configSha256: sha256(configPath), host: report.host, hostHashes, source: report.source, sourceSha256: sha256(report.source), executable: report.executable, executableSha256: sha256(report.executable), marker: report.marker, endpoint, version: update.version, csp, mode, audioStopped: true, scope: 'signed launcher proof; not NSIS installation' };
    console.log(JSON.stringify({ stage: 'before-install', validation }, null, 2));
    // インストール成功時は Host 自身が終了するため、IPC切断と別に終了・印を確認する。
    let installError = null;
    try { await bounded(invoke('install_update', { version: '99.0.0' }), 10000, 'update install'); } catch (error) { installError = String(error); }
    for (let i = 0; i < 150 && (host.exitCode === null || !fs.existsSync(report.marker)); i++) await pause(200);
    assert(host.exitCode === 0 && fs.existsSync(report.marker), `launcher or host exit missing: ${installError || 'no error'}`);
    plainPath(report.marker); assert(fs.readFileSync(report.marker, 'utf8') === 'auralyn-updater-fixture', 'marker content mismatch');
    success = true;
    console.log(JSON.stringify({ stage: 'launcher-confirmed', hostExitCode: host.exitCode, marker: report.marker, scope: validation.scope }));
  } catch (error) {
    runFailure = error.message;
    throw error;
  } finally {
    // ほかの後片付けが遅延しても、自分のレジストリfixtureへ必ず終了を通知する。
    if (helper) helper.stdin.end('\n');
    if (host?.exitCode === null && host.pid) { if (page) { try { await bounded(invoke('stop_audio'), 2000, 'stop audio'); } catch {} } host.kill(); await Promise.race([once(host, 'exit'), pause(5000)]); }
    if (browser) { try { await bounded(browser.close(), 2000, 'CDP close'); } catch {} }
    if (server.listening) {
      try { server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 2000, 'server close'); }
      catch { success = false; runFailure ??= 'server cleanup timeout'; }
    }
    if (helper) {
      for (let i = 0; i < 100 && helperExited === null; i++) await pause(100);
      if (helperExited !== 0 || !helperOutput.includes('"deleted"')) { console.error(`registry cleanup failed or retained: ${helperOutput.trim()}`); success = false; }
    }
    fs.writeFileSync(path.join(root, 'run-result.json'), JSON.stringify({ status: success ? 'success' : 'failed', failure: runFailure, validation, registry: helperOutput, hostExitCode: host?.exitCode, markerPresent: fs.existsSync(report.marker) }, null, 2), { flag: 'wx' });
    if (!success) process.exitCode = 1;
  }
}
async function main() {
  if (process.platform !== 'win32') throw Error('Windows only');
  if (process.argv.length === 4 && process.argv[2] === 'prepare') prepare(process.argv[3]);
  else if (process.argv.length === 4 && process.argv[2] === 'run') await run(process.argv[3]);
  else if (process.argv.length === 4 && process.argv[2] === 'dry-run') await run(process.argv[3], true);
  else throw Error('usage: native-updater-fixture-check.cjs prepare|dry-run|run <newFixtureRoot>');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

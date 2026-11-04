// 一時 checkpoint のみを、専用アプリ・専用 WebView・所有音源で実機検証する。
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { exerciseMixingNative } from './verify-mixing-native.mjs';
import { postMixFixture, exercisePostMixCheckpoint } from './verify-post-mix-native.mjs';

const [appDirectory, evidenceDirectory, suppliedProbe] = process.argv.slice(2);
const options = process.argv.slice(5);
if (options.length && (options.length !== 2 || options[0] !== '--post-vst' || !options[1])) throw new Error('追加指定は --post-vst <絶対パス> だけ使用できます');
const postVst = options[1];
if (postVst && (!/^[a-z]:[\\/]/i.test(postVst) || !/\.vst3$/i.test(postVst) || !existsSync(postVst))) throw new Error('配信用 VST の絶対パスを確認できません');
if (!appDirectory || !evidenceDirectory || !suppliedProbe) throw new Error('専用 app・新規 evidence・probe が必要です');
const appRoot = resolve(appDirectory), root = resolve(evidenceDirectory), probe = resolve(suppliedProbe);
const binary = join(appRoot, 'bin', 'AuralynHost.exe'), configRoot = join(appRoot, 'state', 'config');
if (existsSync(root)) throw new Error('既存の証拠は置き換えません');
mkdirSync(root, { recursive: true });
const temporaryRoot = join(root, 'os-temp'); mkdirSync(temporaryRoot);
const parse = value => JSON.parse(value);
const endpoints = () => parse(execFileSync(probe, ['endpoints'], { encoding: 'utf8', windowsHide: true }));
let beforeEndpoints, beforeCaptureEndpoints, port, environment;
const captureEndpoints = () => parse(execFileSync(probe, ['capture-endpoints'], { encoding: 'utf8', windowsHide: true }));
const results = { passed: false, physicalMicrophoneOpened: false, audibleMonitorTested: false, sharedMcpDriverUntouched: true };
const phase = value => { results.phase = value; writeFileSync(join(root, 'progress.json'), JSON.stringify({ phase: value })); };
let browser, page, debuggerEndpoint, currentPid, stdoutFd, stderrFd, didSpawn = false;
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const ownedProcesses = () => {
    const value = execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-CimInstance Win32_Process -Filter "Name=\'AuralynHost.exe\' OR Name=\'audio_engine.exe\'" | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true });
    const parsed = value.trim() ? parse(value) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(item => [binary, join(appRoot, 'bin', 'audio_engine.exe')].some(path => path.toLowerCase() === item.ExecutablePath?.toLowerCase()));
};
async function attach() {
    const previous = debuggerEndpoint;
    await expect.poll(async () => {
        try { const value = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
            if (!value.webSocketDebuggerUrl || value.webSocketDebuggerUrl === previous) return false;
            debuggerEndpoint = value.webSocketDebuggerUrl; return true;
        } catch { return false; }
    }, { timeout: 35000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await expect.poll(() => browser.contexts()[0].pages().some(value => /^https?:\/\/tauri\.localhost/.test(value.url())), { timeout: 20000 }).toBe(true);
    page = browser.contexts()[0].pages().find(value => /^https?:\/\/tauri\.localhost/.test(value.url()));
    await expect.poll(() => invoke('temporary_session_status')).toBeTruthy();
}
async function assertStopped() {
    const rack = await invoke('session_rack', { request: { action: 'snapshot' } });
    assert(rack.status === 'snapshot' && !rack.running);
}
async function switchSession(temporary, preserveRuntime = false) {
    const parent = currentPid;
    await page.evaluate(args => { void window.__TAURI__.core.invoke('restart_temporary_session', args); }, { temporary, preserveRuntime });
    await expect.poll(() => ownedProcesses().filter(item => item.ExecutablePath.toLowerCase() === binary.toLowerCase() && item.ParentProcessId === parent).length, { timeout: 35000 }).toBe(1);
    currentPid = ownedProcesses().find(item => item.ExecutablePath.toLowerCase() === binary.toLowerCase() && item.ParentProcessId === parent).ProcessId;
    await expect.poll(() => ownedProcesses().some(item => item.ProcessId === parent), { timeout: 35000 }).toBe(false);
    await browser.close(); await attach();
}
const completed = new Error('owned-checkpoint-test-complete');
try {
    const metadata = parse(readFileSync(join(appRoot, 'build.json'), 'utf8'));
    results.checkpointFixture = { postVst: postVst ?? 'C:/Program Files/Common Files/VST3/TDR Nova.vst3' };
    results.build = { root: metadata.root, sourceCommit: metadata.sourceCommit ?? null, sourceMayIncludeLocalChanges: metadata.sourceMayIncludeLocalChanges ?? null, binaries: {} };
    assert.equal(metadata.root, appRoot, '専用ビルドのルートが一致しません');
    assert.match(metadata.sourceCommit ?? '', /^[a-f0-9]{40}$/i, 'ソースコミットを確認できません');
    results.build.workingTreeHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(results.build.workingTreeHead, metadata.sourceCommit, 'ビルド後にソースコミットが変わりました');
    for (const name of ['AuralynHost', 'audio_engine', 'plugin_scanner']) {
        const expected = metadata.binaries?.[name];
        assert.match(expected ?? '', /^[a-f0-9]{64}$/i, 'ビルド情報にハッシュがありません');
        const actual = createHash('sha256').update(readFileSync(join(appRoot, 'bin', `${name}.exe`))).digest('hex');
        results.build.binaries[name] = { expected, actual, matches: actual.toLowerCase() === expected.toLowerCase() };
        assert(results.build.binaries[name].matches, `${name} のハッシュがビルド情報と一致しません`);
    }
    beforeEndpoints = endpoints(); beforeCaptureEndpoints = captureEndpoints();
    const allocation = createServer(); allocation.listen(0, '127.0.0.1'); await once(allocation, 'listening');
    port = allocation.address().port; await new Promise(resolve => allocation.close(resolve));
    environment = { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, RUST_LOG: 'warn', AURALYN_DISABLE_PERF_TWEAKS: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
    assert.equal(ownedProcesses().length, 0);
    assert(!existsSync(join(configRoot, 'broadcast-bundle-recovery.json')) && !existsSync(join(configRoot, 'mixing.json')) && !existsSync(join(configRoot, 'mixing-backups')) && !existsSync(join(configRoot, 'post-mix.json')), '新規の専用設定領域が必要です');
    stdoutFd = openSync(join(root, 'owned-host.stdout.log'), 'wx', 0o600);
    stderrFd = openSync(join(root, 'owned-host.stderr.log'), 'wx', 0o600);
    phase('launch');
    const host = spawn(binary, ['--auralyn-review'], { cwd: appRoot, env: environment, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd] });
    currentPid = host.pid; didSpawn = true; await attach();
    try {
        await exerciseMixingNative({ getPage: () => page, invoke, root, configRoot, probe, beforeEndpoints, results, phase, assertStopped,
            fixtureOptions: { ...postMixFixture({ probe, invoke }), holdSeconds: 600 },
            restartHost: async () => { throw new Error('checkpoint では通常再起動を呼びません'); },
            onMixingReady: async context => { await exercisePostMixCheckpoint({ ...context, switchSession, ...(postVst ? { postVst } : {}) }); throw completed; },
        });
        throw new Error('checkpoint の終了条件に到達しませんでした');
    } catch (error) { if (error !== completed) throw error; }
    results.passed = true;
} catch (error) {
    results.error = String(error);
    if (page && !page.isClosed()) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
} finally {
    if (browser) await browser.close().catch(() => {});
    if (didSpawn) {
        for (const process of ownedProcesses()) {
            try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${process.ProcessId} -ErrorAction SilentlyContinue`], { windowsHide: true }); }
            catch { if (ownedProcesses().some(current => current.ProcessId === process.ProcessId)) results.cleanupFailed = true; }
        }
        try { await expect.poll(() => ownedProcesses().length, { timeout: 10000 }).toBe(0); }
        catch { results.cleanupFailed = true; }
    }
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    try {
        if (!beforeEndpoints || !beforeCaptureEndpoints) throw new Error('端点の開始前状態がありません');
        const after = new Map(endpoints().map(device => [device.id, device]));
        results.endpointStatePreserved = beforeEndpoints.every(device => ['muted', 'volume', 'default_roles'].every(key => JSON.stringify(device[key]) === JSON.stringify(after.get(device.id)?.[key])));
        const afterCapture = new Map(captureEndpoints().map(device => [device.id, device]));
        results.captureEndpointStatePreserved = beforeCaptureEndpoints.every(device => ['muted', 'volume', 'default_roles'].every(key => JSON.stringify(device[key]) === JSON.stringify(afterCapture.get(device.id)?.[key])));
    } catch {
        results.endpointStatePreserved = false;
        results.captureEndpointStatePreserved = false;
        results.cleanupFailed = true;
    }
    results.passed &&= results.endpointStatePreserved && results.captureEndpointStatePreserved && !results.cleanupFailed;
    writeFileSync(join(root, 'summary.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ root, passed: results.passed, error: results.error }));
    if (!results.passed) process.exitCode = 1;
}

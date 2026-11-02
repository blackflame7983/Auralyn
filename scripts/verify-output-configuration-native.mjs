// 分離出力の明示実機試験。設定・TEMP・WebViewを隔離し、両出力を全体ミュートで確認する。
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';

const [appDirectory, evidenceDirectory, suppliedProbe] = process.argv.slice(2);
const reuseOwnedApp = process.argv.includes('--reuse-owned-app');
if (!appDirectory || !evidenceDirectory || !suppliedProbe) throw new Error('app-directory new-evidence-directory probe が必要です');
const appRoot = resolve(appDirectory), root = resolve(evidenceDirectory), probe = resolve(suppliedProbe);
const binary = join(appRoot, 'bin', 'AuralynHost.exe'), configRoot = join(appRoot, 'state', 'config');
if (existsSync(root)) throw new Error('既存の証拠は置き換えません');
mkdirSync(root, { recursive: true });
let temporaryRoot = join(root, 'os-temp'); mkdirSync(temporaryRoot);
const parse = text => { try { return JSON.parse(text); } catch { throw new Error('JSONを確認できません'); } };
const read = file => parse(readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const endpoints = () => parse(execFileSync(probe, ['endpoints'], { encoding: 'utf8', windowsHide: true }));
const beforeEndpoints = endpoints();
const cable = beforeEndpoints.find(device => device.name === 'CABLE Input (VB-Audio Virtual Cable)');
assert(cable && !cable.active_processes.length && !cable.default_roles.length && !cable.muted, '未使用のCABLE Inputが必要です');
const outputEndpoint = beforeEndpoints.find(device => device.name === 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)');
assert(outputEndpoint, '指定された返しがありません');
const allocation = createServer(); allocation.listen(0, '127.0.0.1'); await once(allocation, 'listening');
const port = allocation.address().port; await new Promise(resolve => allocation.close(resolve));
const environment = { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, AURALYN_DISABLE_PERF_TWEAKS: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
let browser, page, currentPid, debuggerEndpoint;
const commandJournal = [];
const results = { passed: false, physicalMicrophoneOpened: false, audibleMonitorTested: false, sharedMcpDriverUntouched: true };
const phase = name => { results.phase = name; writeFileSync(join(root, 'progress.json'), JSON.stringify({ phase: name })); };
const ownedProcesses = () => {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        '@(Get-CimInstance Win32_Process -Filter "Name=\'AuralynHost.exe\' OR Name=\'audio_engine.exe\'" | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true });
    const values = raw.trim() ? parse(raw) : [];
    return (Array.isArray(values) ? values : [values]).filter(process => [binary, join(appRoot, 'bin', 'audio_engine.exe')]
        .some(path => path.toLowerCase() === process.ExecutablePath?.toLowerCase()));
};
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const bundle = request => invoke('broadcast_bundle', { request });
async function attach() {
    const previous = debuggerEndpoint;
    await expect.poll(async () => {
        try {
            const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
            if (!version.webSocketDebuggerUrl || version.webSocketDebuggerUrl === previous) return false;
            debuggerEndpoint = version.webSocketDebuggerUrl;
            return true;
        } catch { return false; }
    }, { timeout: 35000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await expect.poll(() => browser.contexts()[0].pages().some(value => /^https?:\/\/tauri\.localhost/.test(value.url())), { timeout: 20000 }).toBe(true);
    page = browser.contexts()[0].pages().find(value => /^https?:\/\/tauri\.localhost/.test(value.url()));
    page.on('request', request => { try { const url = new URL(request.url()); if (url.hostname !== 'ipc.localhost') return; const args = JSON.parse(request.postData() || '{}'); commandJournal.push({ command: url.pathname, action: args.request?.action, value: typeof args.value === 'number' ? args.value : undefined }); if (commandJournal.length > 500) commandJournal.shift(); } catch {} });
    await expect.poll(() => invoke('temporary_session_status')).toBeTruthy();
}
async function openProfiles() {
    const closeSettings = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
    if (await closeSettings.isVisible()) await closeSettings.click();
    const rack = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
    await page.getByRole('button', { name: 'プロファイル管理', exact: true }).click();
}
async function settle() {
    let previous, stableSince = Date.now();
    await expect.poll(async () => {
        const stats = await invoke('get_engine_runtime_stats');
        const current = JSON.stringify(stats.preparation);
        if (stats.preparation?.controlsPending !== false || stats.pendingUnloadCount !== 0 || current !== previous) stableSince = Date.now();
        previous = current;
        return Date.now() - stableSince >= 500;
    }, { timeout: 10000, intervals: [100] }).toBe(true);
}
async function recoveryPreview() {
    // UIからの初期制御が反映中なら、読み取りだけを有限に取り直す。適用は再試行しない。
    for (let attempt = 0; attempt < 20; attempt++) {
        await settle();
        try { return await bundle({ action: 'recovery_preview' }); }
        catch (error) {
            if (!/反映を待ってください/.test(String(error)) || attempt === 19) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}
async function assertStopped() {
    // get_audio_state.is_runningはsidecarの存在を表す。実ストリームと区別する。
    const rack = await invoke('session_rack', { request: { action: 'snapshot' } });
    assert(rack.status === 'snapshot' && !rack.running);
    return rack;
}

try {
    assert(read(join(appRoot, 'build.json')).root === appRoot);
    assert.equal(ownedProcesses().length, 0, '試験用アプリが実行中です');
    assert(reuseOwnedApp || !existsSync(join(configRoot, 'broadcast-bundle-recovery.json')), '前の原本を確認してください');
    phase('launch');
    const host = spawn(binary, ['--auralyn-review'], { cwd: appRoot, env: environment, windowsHide: true, stdio: 'ignore' });
    currentPid = host.pid;
    await attach();
    if (existsSync(join(configRoot, 'broadcast-bundle-recovery.json'))) { const receipt = read(join(configRoot, 'broadcast-bundle-recovery.json')); await bundle({ action: 'recovery_resolve', id: receipt.backupName }); assert(existsSync(join(configRoot, 'broadcast-bundle-backups', 'broadcast-bundles', receipt.backupName + '.json'))); }
    await assertStopped();
    const list = await invoke('get_audio_devices', { forceRefresh: true });
    const input = list.inputs.find(d => d.host.toLowerCase() === 'wasapi' && d.name.startsWith('CABLE Output'));
    const output = list.outputs.find(d => d.id === 'wasapi:' + outputEndpoint.id);
    const secondaryEndpoint = process.argv.includes('--secondary-speaker') ? beforeEndpoints.find(d => d.name.includes('Soundblaster')) : cable;
    assert(secondaryEndpoint);
    const secondary = list.outputs.find(d => d.id === 'wasapi:' + secondaryEndpoint.id);
    assert(input && output && secondary);
    const start = { host: output.host, input: input.name, output: output.name, inputId: input.id, outputId: output.id, sampleRate: 48000, bufferSize: 512 };
    await page.evaluate(value => { localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_audio_config', JSON.stringify(value)); }, start);
    await page.reload();
    await expect.poll(() => invoke('get_audio_state')).toBeTruthy();
    await invoke('set_global_mute', { active: true });
    phase('start-muted');
    await invoke('live_output', { config: { splitProcessing: false, monitorSinging: null, monitorTalk: null, deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false } });
    await invoke('start_audio', start);
    await invoke('load_plugin', { path: 'C:/Program Files/Common Files/VST3/TDR Nova.vst3' });
    const branch = preset => ({ active: false, preset, amount: 0.6, singing: null, reverb: { enabled: false, mix: 0.08, decaySeconds: 1.2, damping: 0.5 } });
    const a = { splitProcessing: true, monitorSinging: branch('singing'), monitorTalk: branch('broadcast'), deviceId: secondary.id, monitorTrim: 0.2, broadcastTrim: 0.4, monitorMuted: true };
    const b = { splitProcessing: false, monitorSinging: null, monitorTalk: null, deviceId: null, monitorTrim: 0.7, broadcastTrim: 0.8, monitorMuted: false };
    const savedName = 'output-' + process.pid;
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    const route = async config => { await invoke('stop_audio'); await invoke('live_output', { config }); await invoke('start_audio', start); await settle(); };
    phase('configure-split-output');
    await route(a);
    await invoke('set_input_gain', { value: 0.7 });
    await invoke('set_output_gain', { value: 0.25 });
    await invoke('set_noise_control_config', { active: true, mode: 'low', strength: 0.6, voiceGuard: true });
    await settle();
    phase('save-output-ui');
    await assert.rejects(() => bundle({ action: 'save', name: 'must-not-drop-output', categories, obs: null }), /分離出力/);
    results.legacySaveDoesNotDropOutput = true;
    await openProfiles();
    await page.getByRole('button', { name: 'OBS込みプロファイル', exact: true }).click();
    await page.getByRole('checkbox', { name: '分離出力・枝別処理の設定も保存する', exact: true }).check();
    await page.getByLabel('OBS込みプロファイル名', { exact: true }).fill(savedName);
    await page.getByRole('button', { name: '現在のOBS込みプロファイルを保存', exact: true }).click();
    const originalPath = join(configRoot, 'broadcast-bundles', savedName + '.json');
    await expect.poll(() => existsSync(originalPath)).toBe(true);
    const originalBytes = readFileSync(originalPath), original = parse(originalBytes);
    assert.equal(original.schemaVersion, 2);
    assert.deepEqual(original.output.config, a);
    assert(original.output.devices.inputId === input.id && original.output.devices.outputId === output.id);
    assert.equal(original.embeddedAuralynPreset.plugins.length, 1);
    results.savedThroughRealUi = true;
    await route(b);
    await invoke('set_input_gain', { value: 1 });
    await invoke('set_output_gain', { value: 0.5 });
    await settle();
    phase('preview-apply-output-ui');
    await page.getByRole('combobox', { name: '保存済みOBS込みプロファイル', exact: true }).selectOption(savedName);
    await page.getByRole('button', { name: '変更予定を確認', exact: true }).click();
    await expect(page.getByRole('region', { name: '分離出力の差分', exact: true })).toBeVisible();
    await page.screenshot({ path: join(root, 'output-differences.png') });
    let applied;
    if (process.argv.includes('--direct-apply')) { const direct = await bundle({ action: 'preview', name: savedName }); applied = (await bundle({ action: 'apply', id: direct.value.id })).value; results.applyResult = applied; assert(applied?.complete); }
    else {
        await page.getByRole('button', { name: 'この変更予定を適用する', exact: true }).click();
        try { await expect.poll(async () => { applied = (await bundle({ action: 'history' })).value; return applied?.complete === true; }, { timeout: 20000 }).toBe(true); }
        catch (error) { results.applyResult = applied; throw error; }
    }
    results.applyResult = applied;
    results.appliedThroughRealUi = !process.argv.includes('--direct-apply');
    const live = await invoke('live_output', { config: null });
    assert.deepEqual(live.config, a);
    assert(live.sink?.active && !live.sink.failed && live.monitor && !live.monitor.broadcastFailed);
    const stats = await invoke('get_engine_runtime_stats');
    assert(stats.preparation.muted && Math.abs(stats.preparation.inputGain - 0.7) < 1e-6 && stats.preparation.outputGain === 0.25);
    assert.equal(stats.activePluginCount, 1);
    const restoredId = applied.current.loadedPluginInstances[0].id;
    assert.equal(hash(await invoke('get_plugin_state', { id: restoredId })), hash(original.embeddedAuralynPreset.plugins[0].state));
    assert.equal((await bundle({ action: 'recovery_status' })).value, null);
    results.bothBranchesAndVstRestoredMuted = true;
    phase('conditional-undo');
    const undone = await bundle({ action: 'undo', id: applied.id });
    results.undoResult = undone.value;
    assert(undone.value?.complete && !undone.value.undoPending);
    assert.deepEqual((await invoke('live_output', { config: null })).config, b);
    assert((await invoke('get_engine_runtime_stats')).preparation.muted);
    results.outputUndoRestoredPreviousRoute = true;
    const liveFile = join(configRoot, 'live_output.json');
    const priorLive = readFileSync(liveFile);
    phase('external-edit');
    let preview = await bundle({ action: 'preview', name: savedName });
    try {
        writeFileSync(liveFile, priorLive.toString() + '\n');
        await assert.rejects(() => bundle({ action: 'apply', id: preview.value.id }), /変更されました/);
        assert.equal((await bundle({ action: 'recovery_status' })).value, null);
        results.externalOutputEditRejected = true;
    } finally { writeFileSync(liveFile, priorLive); }
    phase('missing-device');
    try {
        const missing = parse(originalBytes); missing.output.config.deviceId = 'wasapi:unavailable-fixture';
        writeFileSync(originalPath, JSON.stringify(missing));
        preview = await bundle({ action: 'preview', name: savedName });
        assert(preview.value.output.missingDevices.length === 1);
        await assert.rejects(() => bundle({ action: 'apply', id: preview.value.id }), /IDで特定できません/);
        assert.deepEqual((await invoke('live_output', { config: null })).config, b);
        results.missingOutputRejectedBeforeMutation = true;
    } finally { writeFileSync(originalPath, originalBytes); }
    phase('partial-vst-failure');
    try {
        const invalid = parse(originalBytes), fixture = join(root, 'invalid-fixture.vst3');
        writeFileSync(fixture, 'owned non-executable VST load failure fixture');
        invalid.embeddedAuralynPreset.plugins[0].path = fixture;
        writeFileSync(originalPath, JSON.stringify(invalid));
        preview = await bundle({ action: 'preview', name: savedName });
        assert.equal(preview.value.output.missingPlugins.length, 0);
        const failed = await bundle({ action: 'apply', id: preview.value.id });
        assert(failed.value && !failed.value.complete && failed.value.undoPending);
        await assertStopped();
        assert((await invoke('get_engine_runtime_stats')).preparation.muted);
        const recovery = await bundle({ action: 'recovery_status' });
        assert(recovery.value?.readable);
        results.partialFailureStopsBothBranchesAndKeepsOriginal = true;
    } finally { writeFileSync(originalPath, originalBytes); }
    phase('explicit-recovery');
    await invoke('start_audio', start);
    await settle();
    preview = await recoveryPreview();
    const recovered = await bundle({ action: 'recovery_apply', id: preview.value.id });
    results.recoveryResult = recovered.value;
    assert(recovered.value?.complete);
    assert.deepEqual((await invoke('live_output', { config: null })).config, b);
    assert((await invoke('get_engine_runtime_stats')).preparation.muted);
    assert.equal((await bundle({ action: 'recovery_status' })).value, null);
    assert.equal(hash(readFileSync(originalPath)), hash(originalBytes));
    results.explicitRecoveryRestoresBothBranches = true;
    await invoke('stop_audio');
    await page.evaluate(() => { void window.__TAURI__.core.invoke('plugin:process|exit', { code: 0 }); });
    results.passed = true;

} catch (error) {
    results.error = String(error);
    results.commandJournal = commandJournal;
    if (page && !page.isClosed()) { results.lastRuntimeStats = await invoke('get_engine_runtime_stats').catch(() => null); results.lastLiveOutput = await invoke('live_output', { config: null }).catch(error => { results.liveOutputReadError = String(error); return null; }); results.peakStatus = await invoke('peak_protection', { config: null }).catch(() => null); }
    writeFileSync(join(root, 'summary.json'), JSON.stringify(results, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
} finally {
    if (browser) await browser.close().catch(() => {});
    for (const process of ownedProcesses()) {
        try {
            execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${process.ProcessId} -ErrorAction SilentlyContinue`], { windowsHide: true });
        } catch {
            if (ownedProcesses().some(current => current.ProcessId === process.ProcessId)) {
                results.cleanupFailed = true; results.passed = false;
            }
        }
    }
    const after = new Map(endpoints().map(device => [device.id, device]));
    results.endpointStatePreserved = beforeEndpoints.every(device => ['muted', 'volume', 'default_roles'].every(key => JSON.stringify(device[key]) === JSON.stringify(after.get(device.id)?.[key])));
    results.passed &&= results.endpointStatePreserved;
    writeFileSync(join(root, 'summary.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ root, passed: results.passed, error: results.error }));
    if (!results.passed) process.exitCode = 1;
}

// 明示実行専用。設定・OS一時領域・WebViewを隔離し、機器入力を無音で開始する。
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
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
const temporaryRoot = join(root, 'os-temp'); mkdirSync(temporaryRoot);
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
    await expect.poll(() => invoke('temporary_session_status')).toBeTruthy();
}
async function openProfiles() {
    const closeSettings = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
    if (await closeSettings.isVisible()) await closeSettings.click();
    const rack = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
    await page.getByRole('button', { name: 'プロファイル管理', exact: true }).click();
}
async function switchedFrom(parent) {
    await expect.poll(() => ownedProcesses().filter(process => process.ExecutablePath.toLowerCase() === binary.toLowerCase()
        && process.ParentProcessId === parent).length, { timeout: 35000 }).toBe(1);
    currentPid = ownedProcesses().find(process => process.ExecutablePath.toLowerCase() === binary.toLowerCase()
        && process.ParentProcessId === parent).ProcessId;
    await expect.poll(() => ownedProcesses().some(process => process.ProcessId === parent), { timeout: 35000 }).toBe(false);
    if (browser) await browser.close().catch(() => {});
    await attach();
}
async function settle() {
    await expect.poll(async () => { const stats = await invoke('get_engine_runtime_stats'); return stats.preparation?.controlsPending === false; }, { timeout: 10000 }).toBe(true);
}
async function assertStopped() {
    // get_audio_state.is_runningはsidecarの存在を表す。実ストリームと区別する。
    const rack = await invoke('session_rack', { request: { action: 'snapshot' } });
    assert(rack.status === 'snapshot' && !rack.running);
    return rack;
}

try {
    assert(read(join(appRoot, 'build.json')).root === appRoot, '試験用アプリの所有情報が一致しません');
    assert(reuseOwnedApp || !existsSync(join(configRoot, 'broadcast-bundle-recovery.json')), '新規の試験用アプリを使ってください');
    const recoveryFile = join(configRoot, 'broadcast-bundle-recovery.json');
    if (!existsSync(recoveryFile)) {
        writeFileSync(recoveryFile, JSON.stringify({ version: 1, backupName: 'interrupted-runtime-fixture',
            devices: { inputId: 'unresolved-input', outputId: 'unresolved-output' },
            runtime: { version: 1, sourceEpoch: 1, sourceControlRevision: '0', sha256: '0'.repeat(64) } }), { flag: 'wx' });
        results.interruptedCaptureFixtureInjected = true;
    }
    phase('regular-launch');
    const host = spawn(binary, [], { cwd: appRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout.on('data', () => {}); host.stderr.on('data', () => {}); currentPid = host.pid;
    await attach();
    const bootMode = await invoke('temporary_session_status');
    assert(bootMode.reviewOnly && !bootMode.temporary);
    assert.equal((await assertStopped()).plugins.length, 0);
    results.unfinishedOriginalBlocksAutomaticStart = true;
    if (existsSync(recoveryFile)) {
        const previous = read(recoveryFile);
        await bundle({ action: 'recovery_resolve', id: previous.backupName });
        results.previousFixtureOriginalRetained = existsSync(join(configRoot, 'broadcast-bundle-backups', 'broadcast-bundles', previous.backupName + '.json'));
    }
    const list = await invoke('get_audio_devices', { forceRefresh: true });
    const input = list.inputs.find(device => device.host.toLowerCase() === 'wasapi' && device.name.startsWith('CABLE Output'));
    const output = list.outputs.find(device => device.id === 'wasapi:' + outputEndpoint.id);
    assert(input && output, '制御用のWASAPI機器を選べません');
    const start = { host: output.host, input: input.name, output: output.name, inputId: input.id, outputId: output.id,
        sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] };
    await page.evaluate(value => { localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_audio_config', JSON.stringify(value)); }, start);
    await page.reload();
    await expect.poll(() => invoke('get_audio_state')).toBeTruthy();
    await invoke('set_global_mute', { active: true });
    await invoke('start_audio', start);
    await invoke('set_input_gain', { value: 0.7 });
    await invoke('set_output_gain', { value: 0.25 });
    await invoke('set_noise_control_config', { active: true, mode: 'low', strength: 0.6, voiceGuard: true });
    const id = await invoke('load_plugin', { path: 'C:/Program Files/Common Files/VST3/TDR Nova.vst3' });
    await invoke('set_gain', { id, value: 0.4 });
    await settle();
    phase('capture-and-enter-temporary');
    await openProfiles();
    const temporaryPanel = page.locator('details').filter({ has: page.locator('summary', { hasText: '共有PCで今回だけ使う' }) });
    await temporaryPanel.locator('summary').click();
    await temporaryPanel.getByRole('checkbox', { name: '対応する未保存設定を退避してから開始する' }).check();
    await temporaryPanel.getByRole('checkbox', { name: '音声の停止と、保存対象・対象外を確認しました' }).check();
    await page.screenshot({ path: join(root, 'before-temporary.png') });
    const regularConfig = readFileSync(join(configRoot, 'last_audio_config.json'));
    const firstPid = currentPid;
    await temporaryPanel.getByRole('button', { name: '一時利用で再起動', exact: true }).click();
    await switchedFrom(firstPid);
    phase('temporary-isolated');
    const temporaryMode = await invoke('temporary_session_status');
    assert(temporaryMode.temporary && temporaryMode.reviewOnly);
    const scratch = resolve(temporaryMode.directory);
    assert(scratch.startsWith(temporaryRoot + sep) && /^Auralyn-temporary-[a-f0-9]{32}$/i.test(scratch.split(sep).at(-1)));
    assert(!lstatSync(scratch).isSymbolicLink());
    assert.equal((await assertStopped()).plugins.length, 0);
    results.temporaryStartsStopped = true;
    const receipt = read(join(configRoot, 'broadcast-bundle-recovery.json'));
    assert(receipt.runtime?.version === 1 && receipt.devices.inputId === input.id && receipt.devices.outputId === output.id);
    const originalPath = join(configRoot, 'broadcast-bundle-backups', 'broadcast-bundles', receipt.backupName + '.json');
    const originalBytes = readFileSync(originalPath), original = parse(originalBytes);
    assert.equal(original.embeddedAuralynPreset.plugins.length, 1);
    assert(Math.abs(original.levelIntent.inputGain - 0.7) < 1e-6 && original.levelIntent.outputGain === 0.25);
    assert(Math.abs(original.embeddedAuralynPreset.noiseControl.strength - 0.6) < 1e-6);
    results.originalSha256 = hash(originalBytes);
    await page.evaluate(() => localStorage.setItem('vst_host_wizard_done', 'true'));
    await page.reload();
    await expect(page.getByRole('button', { name: '設定画面を閉じる', exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: '設定画面を閉じる', exact: true }).click();
    await openProfiles();
    const finishPanel = page.locator('details').filter({ has: page.locator('summary', { hasText: '一時利用中' }) });
    await finishPanel.locator('summary').click();
    await finishPanel.getByRole('checkbox', { name: '音声の停止と、保存対象・対象外を確認しました' }).check();
    await page.screenshot({ path: join(root, 'temporary-isolated.png') });
    const temporaryPid = currentPid;
    // scratchの絶対パスと所有範囲を確認した後だけ、製品の専用領域破棄を明示実行する。
    await finishPanel.getByRole('button', { name: '通常設定を確認待ちで開く', exact: true }).click();
    await switchedFrom(temporaryPid);
    phase('regular-review-and-restore');
    const returned = await invoke('temporary_session_status');
    assert(!returned.temporary && returned.reviewOnly);
    assert.equal((await assertStopped()).plugins.length, 0);
    assert.equal(hash(readFileSync(join(configRoot, 'last_audio_config.json'))), hash(regularConfig));
    results.regularSettingsPreserved = true;
    results.returnStartsStopped = true;
    results.scratchRemoved = !existsSync(scratch);
    if (!results.scratchRemoved) {
        assert(returned.cleanupPending && resolve(returned.cleanupPending) === scratch);
        results.cleanupFailureReported = true;
    }
    const recovery = await bundle({ action: 'recovery_status' });
    assert(recovery.value?.readable && recovery.value.runtimeCheckpoint);
    await invoke('set_global_mute', { active: true });
    await invoke('start_audio', start);
    await settle();
    const modified = parse(originalBytes); modified.embeddedAuralynPreset.noiseControl.strength = 0.9;
    try {
        writeFileSync(originalPath, JSON.stringify(modified));
        await assert.rejects(() => bundle({ action: 'recovery_preview' }));
    } finally {
        writeFileSync(originalPath, originalBytes);
    }
    results.modifiedOriginalRejected = true;
    let preview = await bundle({ action: 'recovery_preview' });
    await invoke('stop_audio');
    await assert.rejects(() => bundle({ action: 'recovery_apply', id: preview.value.id }));
    await assertStopped();
    results.stopInvalidatesPreview = true;
    await invoke('start_audio', start);
    await settle();
    await invoke('set_global_mute', { active: false });
    await settle();
    preview = await bundle({ action: 'recovery_preview' });
    await assert.rejects(() => bundle({ action: 'recovery_apply', id: preview.value.id }));
    results.unmutedRestoreRejected = true;
    await invoke('set_global_mute', { active: true });
    await settle();
    preview = await bundle({ action: 'recovery_preview' });
    const receiptBytes = readFileSync(recoveryFile);
    try {
        // 原本と検証値の両方が外部編集されても、古い差分は使用しない。
        writeFileSync(originalPath, JSON.stringify(modified));
        const editedReceipt = parse(receiptBytes);
        editedReceipt.runtime.sha256 = hash(JSON.stringify(modified));
        writeFileSync(recoveryFile, JSON.stringify(editedReceipt));
        assert((await bundle({ action: 'recovery_status' })).value?.readable, '編集した試験原本の検証値が一致しません');
        await assert.rejects(() => bundle({ action: 'recovery_apply', id: preview.value.id }));
        results.sameRevisionPreviewEditRejected = true;
    } finally {
        writeFileSync(originalPath, originalBytes);
        writeFileSync(recoveryFile, receiptBytes);
    }
    preview = await bundle({ action: 'recovery_preview' });
    const applied = await bundle({ action: 'recovery_apply', id: preview.value.id });
    results.restoreResult = applied.value;
    const afterApply = await invoke('get_engine_runtime_stats');
    results.restoredBuiltinReverb = afterApply.builtInReverb;
    const restoredId = applied.value?.current?.loadedPluginInstances?.[0]?.id;
    if (restoredId) {
        results.componentStateMatchesOriginal = hash(await invoke('get_plugin_state', { id: restoredId }))
            === hash(original.embeddedAuralynPreset.plugins[0].state);
    }
    assert(applied.value?.complete, '復帰を完了できませんでした');
    const stats = await invoke('get_engine_runtime_stats');
    assert.equal(stats.activePluginCount, 1);
    assert(stats.preparation.muted && Math.abs(stats.preparation.inputGain - 0.7) < 1e-6 && stats.preparation.outputGain === 0.25);
    assert(Math.abs(stats.noiseControlStrength - 0.6) < 1e-6);
    assert.equal((await bundle({ action: 'recovery_status' })).value, null);
    assert.equal(hash(readFileSync(originalPath)), results.originalSha256);
    results.restoreCompletedMuted = true;
    results.restoredPluginCount = stats.activePluginCount;
    await page.screenshot({ path: join(root, 'regular-restored.png') });
    await invoke('stop_audio');
    await page.evaluate(() => { void window.__TAURI__.core.invoke('plugin:process|exit', { code: 0 }); });
    results.passed = true;
} catch (error) {
    results.error = String(error);
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

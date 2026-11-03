// 所有するテスト再生プロセスだけを使う。原音用の未使用CABLEは終了時に元へ戻す。
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, copyFileSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';

export async function exerciseProcessBundle({ getPage, invoke, bundle, root, configRoot, probe, raw, monitor, results, phase, settle, assertStopped, openProfiles, restartHost, switchSession }) {
    const parse = text => { try { return JSON.parse(text); } catch { throw new Error('試験用JSONを確認できません'); } };
    const read = path => parse(readFileSync(path, 'utf8'));
    const hash = value => createHash('sha256').update(value).digest('hex');
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    const owned = [];
    const startChild = (binary, args) => { const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore' }); owned.push(child); return child; };
    const stopChild = async child => {
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill();
            await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('所有する試験プロセスを終了できません')), 5000); timer.unref(); })]);
        }
    };
    const readyGuard = join(root, 'raw-muted.ready.json');
    const playerPath = join(root, 'bundle_test_player.exe'); copyFileSync(probe, playerPath);
    let source, sourceSerial = 0, choice, output;
    const startSource = async () => {
        const ready = join(root, `source-${++sourceSerial}.ready.json`);
        source = startChild(playerPath, ['source-low-volume', '600', ready, raw.id, '587']);
        await expect.poll(() => existsSync(ready)).toBe(true);
        return read(ready);
    };
    const select = async purpose => {
        await invoke('stop_audio');
        choice = (await invoke('get_process_input_sources')).find(value => value.name === 'bundle_test_player.exe' && value.appKey === hash(playerPath.toLowerCase()));
        assert(choice && choice.routes.length === 1 && choice.routes[0].id === raw.id && choice.routes[0].muted);
        const sourceConfig = { kind: 'process_loopback', config: { appKey: choice.appKey, appName: choice.name, rawEndpointId: raw.id, purpose } };
        const start = { host: output.host, output: output.name, outputId: output.id, sampleRate: 48000, bufferSize: 512, inputSource: { source: sourceConfig, candidateId: choice.id } };
        await getPage().evaluate(value => { localStorage.setItem('vst_host_audio_config', JSON.stringify(value)); }, { ...start, inputSource: sourceConfig });
        await invoke('set_global_mute', { active: true });
        await invoke('start_audio', start); await settle();
        await expect.poll(async () => (await invoke('get_engine_runtime_stats')).processInput?.nonzeroFrames ?? 0).toBeGreaterThan(1000);
        const active = (await invoke('get_audio_state')).config;
        assert(!active.input_id && active.input_source.kind === 'process_loopback' && active.input_source.config.purpose === purpose);
        return sourceConfig;
    };
    const preview = async name => { await settle(); return bundle({ action: 'preview', name }); };
    const recoveryPreview = async () => { await settle(); return bundle({ action: 'recovery_preview' }); };
    const receiptPath = join(configRoot, 'broadcast-bundle-recovery.json');
    try {
        phase('process-source');
        startChild(probe, ['hold-endpoint-muted', raw.id, '600', readyGuard]);
        await expect.poll(() => existsSync(readyGuard)).toBe(true);
        const firstSource = await startSource();
        output = (await invoke('get_audio_devices', { forceRefresh: true })).outputs.find(value => value.id === 'wasapi:' + monitor.id);
        assert(output);
        await getPage().evaluate(() => { localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_tutorial_completed', 'true'); });
        await getPage().reload();
        await invoke('live_output', { config: { deviceId: null, splitProcessing: false, monitorSinging: null, monitorTalk: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false } });
        await select('voice');
        await invoke('load_plugin', { path: 'C:/Program Files/Common Files/VST3/TDR Nova.vst3' });
        await invoke('set_input_gain', { value: 0.7 }); await invoke('set_output_gain', { value: 0.25 });
        await invoke('set_noise_control_config', { active: true, mode: 'low', strength: 0.6, voiceGuard: true }); await settle();
        const name = 'process-voice-' + process.pid;
        phase('process-save-ui');
        await assert.rejects(() => bundle({ action: 'save', name: 'must-not-drop-process', categories, obs: null }), /プロセス入力/);
        await openProfiles();
        await getPage().getByRole('button', { name: 'OBS込みプロファイル', exact: true }).click();
        await getPage().getByRole('checkbox', { name: 'プロセス入力の設定も保存する', exact: true }).check();
        await getPage().getByLabel('OBS込みプロファイル名', { exact: true }).fill(name);
        await getPage().getByRole('button', { name: '現在のOBS込みプロファイルを保存', exact: true }).click();
        const savedPath = join(configRoot, 'broadcast-bundles', name + '.json');
        await expect.poll(() => existsSync(savedPath)).toBe(true);
        const savedBytes = readFileSync(savedPath), saved = parse(savedBytes);
        assert.equal(saved.schemaVersion, 4); assert.equal(saved.process.source.purpose, 'voice');
        assert(!/"(?:pid|created|candidateId|target)"/.test(JSON.stringify(saved)));
        results.processSavedThroughRealUiWithoutRuntimeTarget = true;
        const rack = await invoke('session_rack', { request: { action: 'snapshot' } });
        for (const plugin of rack.plugins) await invoke('remove_plugin', { id: plugin.id });
        await invoke('set_input_gain', { value: 1 }); await invoke('set_output_gain', { value: 0.5 });
        await invoke('set_noise_control_config', { active: false, mode: 'low', strength: 0.2, voiceGuard: true }); await settle();
        phase('process-apply-ui');
        await getPage().getByRole('combobox', { name: '保存済みOBS込みプロファイル', exact: true }).selectOption(name);
        await getPage().getByRole('button', { name: '変更予定を確認', exact: true }).click();
        await expect(getPage().getByRole('region', { name: 'プロセス入力の差分', exact: true })).toContainText('bundle_test_player.exe');
        await getPage().screenshot({ path: join(root, 'process-differences.png') });
        await getPage().getByRole('button', { name: 'この変更予定を適用する', exact: true }).click();
        let applied;
        await expect.poll(async () => { applied = (await bundle({ action: 'history' })).value; return applied?.complete === true; }, { timeout: 20000 }).toBe(true);
        const stats = await invoke('get_engine_runtime_stats');
        assert(stats.preparation.muted && stats.preparation.outputGain === 0.25 && Math.abs(stats.preparation.inputGain - 0.7) < 1e-6);
        assert.equal(hash(await invoke('get_plugin_state', { id: applied.current.loadedPluginInstances[0].id })), hash(saved.embeddedAuralynPreset.plugins[0].state));
        assert.equal((await bundle({ action: 'recovery_status' })).value, null);
        results.processAppliedThroughRealUi = true;
        const undo = await bundle({ action: 'undo', id: applied.id }); assert(undo.value.complete && !undo.value.undoPending);
        assert.equal((await invoke('get_engine_runtime_stats')).activePluginCount, 0);
        results.processUndoRestoredEmptyRack = true;
        phase('process-external-output-edit');
        const outputFile = join(configRoot, 'live_output.json'), outputBytes = readFileSync(outputFile);
        let externalPlan = await preview(name);
        try { writeFileSync(outputFile, outputBytes.toString() + '\n'); await assert.rejects(() => bundle({ action: 'apply', id: externalPlan.value.id }), /変更されました/); assert(!existsSync(receiptPath)); }
        finally { writeFileSync(outputFile, outputBytes); }
        results.processExternalOutputEditRejected = true;
        phase('process-restart-choice');
        let planned = await preview(name);
        await stopChild(source);
        await expect.poll(async () => (await invoke('get_engine_runtime_stats')).processInput?.failed ?? true).toBe(true);
        await assert.rejects(() => bundle({ action: 'apply', id: planned.value.id }), /音声|アプリ|変更/);
        assert(!existsSync(receiptPath));
        const nextSource = await startSource(); assert(firstSource.pid !== nextSource.pid || firstSource.created !== nextSource.created);
        await select('music'); planned = await preview(name); assert(!planned.value.process.selectionMatches);
        await assert.rejects(() => bundle({ action: 'apply', id: planned.value.id }), /明示選択/);
        await select('voice'); planned = await preview(name); assert(planned.value.process.selectionMatches);
        const reselection = await bundle({ action: 'apply', id: planned.value.id }); assert(reselection.value.complete);
        assert((await bundle({ action: 'undo', id: reselection.value.id })).value.complete);
        results.oldTargetRejectedAndNewExplicitTargetAccepted = true;
        phase('process-interrupt');
        planned = await preview(name);
        const applying = bundle({ action: 'apply', id: planned.value.id });
        await expect.poll(() => existsSync(receiptPath), { intervals: [10], timeout: 5000 }).toBe(true);
        await invoke('stop_audio'); const stopped = await applying;
        assert(stopped.value && !stopped.value.complete && stopped.value.undoPending); await assertStopped();
        await select('voice'); planned = await recoveryPreview(); assert((await bundle({ action: 'recovery_apply', id: planned.value.id })).value.complete);
        results.processStopKeepsOriginalAndAllowsRecovery = true;
        phase('process-partial-failure');
        try {
            const invalid = parse(savedBytes), fixture = join(root, 'invalid-process-fixture.vst3'); writeFileSync(fixture, 'owned non-executable fixture');
            invalid.embeddedAuralynPreset.plugins[0].path = fixture; writeFileSync(savedPath, JSON.stringify(invalid));
            planned = await preview(name); const failed = await bundle({ action: 'apply', id: planned.value.id });
            assert(failed.value && !failed.value.complete && failed.value.undoPending); await assertStopped();
            assert((await bundle({ action: 'recovery_status' })).value?.readable);
        } finally { writeFileSync(savedPath, savedBytes); }
        phase('process-host-restart-recovery');
        await restartHost(); await assertStopped();
        // 停止中はRTの反映完了を待たず、読取だけで未選択の差分を開く。
        planned = await bundle({ action: 'recovery_preview' }); assert(!planned.value.process.selectionMatches);
        await assert.rejects(() => bundle({ action: 'recovery_apply', id: planned.value.id }), /停止中|明示|プロセス入力/);
        await select('voice'); planned = await recoveryPreview(); assert((await bundle({ action: 'recovery_apply', id: planned.value.id })).value.complete);
        assert.equal((await bundle({ action: 'recovery_status' })).value, null);
        results.processFailureAndHostRestartRequireExplicitChoice = true;
        phase('process-music');
        await select('music');
        const musicName = 'process-music-' + process.pid;
        await bundle({ action: 'save', name: musicName, categories, obs: null, includeProcess: true });
        await invoke('set_output_gain', { value: 0.1 }); await settle();
        planned = await preview(musicName); assert((await bundle({ action: 'apply', id: planned.value.id })).value.complete);
        assert.equal((await invoke('get_audio_state')).config.input_source.config.purpose, 'music');
        assert((await invoke('get_engine_runtime_stats')).preparation.muted);
        results.processMusicPurposeRestored = true;
        phase('process-temporary-enter');
        await switchSession(true, true); await assertStopped();
        const temporary = await invoke('temporary_session_status'); assert(temporary.temporary && temporary.reviewOnly);
        const scratch = resolve(temporary.directory);
        assert(scratch.startsWith(join(root, 'os-temp') + sep) && /^Auralyn-temporary-[a-f0-9]{32}$/i.test(basename(scratch)) && !lstatSync(scratch).isSymbolicLink());
        const tempReceipt = read(receiptPath); assert.equal(tempReceipt.runtime.version, 2); assert(!tempReceipt.devices);
        const tempOriginalPath = join(configRoot, 'broadcast-bundle-backups', 'broadcast-bundles', tempReceipt.backupName + '.json');
        const tempOriginalBytes = readFileSync(tempOriginalPath), tempOriginal = parse(tempOriginalBytes);
        assert.equal(tempOriginal.schemaVersion, 4); assert.equal(tempOriginal.process.source.purpose, 'music');
        assert(!/"(?:pid|created|candidateId|target)"/.test(JSON.stringify(tempOriginal)));
        await stopChild(source); await startSource(); // 退避時のプロセスは通常設定へ戻る前に終了済み。
        await switchSession(false); await assertStopped();
        const returned = await invoke('temporary_session_status'); assert(!returned.temporary && returned.reviewOnly);
        results.processTemporaryScratchRemoved = !existsSync(scratch);
        if (process.argv.includes("--expect-cleanup")) assert(results.processTemporaryScratchRemoved, "終了後の一時領域を削除できませんでした");
        if (!results.processTemporaryScratchRemoved) { assert(returned.cleanupPending && resolve(returned.cleanupPending) === scratch); results.processTemporaryCleanupFailureReported = true; }
        planned = await bundle({ action: 'recovery_preview' }); assert(!planned.value.process.selectionMatches);
        await select('music'); planned = await recoveryPreview();
        const recoveredTemporary = await bundle({ action: 'recovery_apply', id: planned.value.id }); assert(recoveredTemporary.value.complete);
        assert.equal((await invoke('get_audio_state')).config.input_source.config.purpose, 'music');
        assert((await invoke('get_engine_runtime_stats')).preparation.muted);
        assert.equal(hash(readFileSync(tempOriginalPath)), hash(tempOriginalBytes));
        assert.equal((await bundle({ action: 'recovery_status' })).value, null);
        results.processTemporaryBackupRequiresNewExplicitSelection = true;

    } finally {
        await invoke('stop_audio').catch(() => {});
        for (const child of owned.reverse()) await stopChild(child);
        const snapshot = readyGuard.replace(/\.json$/, '.restore.json');
        if (existsSync(snapshot)) execFileSync(probe, ['restore-endpoint', snapshot], { windowsHide: true, stdio: 'ignore' });
    }
}

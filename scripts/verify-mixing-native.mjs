// 実Tauriの二入力確認。所有する試験音と非既定出力だけを使い、全体ミュートを維持する。
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RAW_ID = '{0.0.0.00000000}.{f89dac00-06ae-4d18-8d22-3e25e68f24b5}';
const SINK_ID = '{0.0.0.00000000}.{f5d568ec-f794-4024-9faa-1c2350b53dc6}';
const MONITOR_ID = '{0.0.0.00000000}.{dbfcc2a4-96a1-4d52-b31f-fbea7cac6fd1}';
const VOICE_ID = '{0.0.0.00000000}.{7336ebbb-3009-481c-846d-a2c8f44b2951}';

function fixture(path) {
    const rate = 44100, frames = rate * 2, channels = 2;
    const bytes = Buffer.alloc(44 + frames * channels * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
    bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let i = 0; i < frames; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 1000);
        bytes.writeInt16LE(sample, 44 + i * 4); bytes.writeInt16LE(sample, 46 + i * 4);
    }
    writeFileSync(path, bytes, { flag: 'wx' });
}

export async function exerciseMixingNative({ getPage, invoke, root, configRoot, probe, beforeEndpoints, results, phase, assertStopped, restartHost }) {
    const parse = value => JSON.parse(value);
    const read = path => parse(readFileSync(path, 'utf8'));
    const probeJson = args => parse(execFileSync(probe, args, { encoding: 'utf8', windowsHide: true }));
    const endpoints = () => probeJson(['endpoints']);
    const find = id => beforeEndpoints.find(item => item.id.toLowerCase() === id.toLowerCase());
    const raw = find(RAW_ID), sink = find(SINK_ID), monitor = find(MONITOR_ID), voice = find(VOICE_ID);
    assert(raw && sink && monitor && voice, '指定した試験用の出力先を確認できません');
    for (const device of [raw, sink, voice]) assert(!device.active_processes.length && !device.default_roles.length, '試験音源・出力は未使用かつ非既定が必要です');
    assert(monitor.default_roles.length > 0, '本人用の既定出力が指定と異なります');
    assert(!existsSync(join(configRoot, 'mixing.json')), '新規の所有設定領域が必要です');
    const owned = [], guards = [];
    const launch = (command, args) => {
        const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
        owned.push(child); return child;
    };
    const waitFile = async (child, path) => {
        await expect.poll(() => {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('所有プロセスが準備前に終了しました');
            return existsSync(path);
        }, { timeout: 35000, intervals: [100] }).toBe(true);
        return read(path);
    };
    const bounded = (promise, ms, message) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const stopChild = async child => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit'); child.kill();
        await bounded(exited, 5000, '所有プロセスを終了できません');
    };
    const mix = request => invoke('mixing', { request });
    const snapshot = () => mix({ action: 'snapshot' });
    const token = state => ({ expectedEpoch: state.epoch, expectedRevision: state.revision });
    const checkMuted = async () => {
        const state = await invoke('get_engine_runtime_stats');
        assert.equal(state.preparation.muted, true, '全体ミュートが解除されました');
        return state;
    };
    let chrome;
    try {
        phase('mixing-guard');
        for (const [index, device] of [raw, sink].entries()) {
            const ready = join(root, `mix-guard-${index}.ready.json`);
            const child = launch(probe, ['hold-endpoint-muted', device.id, '900', ready]);
            guards.push({ child, ready });
            const saved = await waitFile(child, ready);
            assert.equal(saved.muted, device.muted, 'ガード前の状態が変わりました');
        }
        const guarded = new Map(endpoints().map(device => [device.id, device]));
        for (const original of beforeEndpoints) {
            const current = guarded.get(original.id);
            assert(current);
            assert.equal(current.muted, [raw.id, sink.id].includes(original.id) ? true : original.muted, '別の出力先にもミュートが連動しています');
            assert.equal(current.volume, original.volume); assert.deepEqual(current.default_roles, original.default_roles);
        }
        phase('mixing-owned-sources');
        const wave = join(root, 'mix-accompaniment.wav'); fixture(wave);
        chrome = launch(process.execPath, [resolve('scripts/process-loopback-chrome-source.mjs'), root, raw.name, wave, 'webaudio']);
        const chromeInfo = await waitFile(chrome, join(root, 'chrome.ready.json'));
        assert(chromeInfo.pid > 0 && chromeInfo.state === 'running' && chromeInfo.microphoneOpened === false);
        const voiceProcess = launch(probe, ['source-low-volume', '900', join(root, 'mix-voice.ready.json'), voice.id, '587']);
        await waitFile(voiceProcess, join(root, 'mix-voice.ready.json'));
        let identified;
        await expect.poll(() => {
            const found = probeJson(['list']).filter(item => item.pid === chromeInfo.pid && item.name.toLowerCase() === 'chrome.exe');
            if (found.length === 1) { identified = found[0]; return true; }
            return false;
        }, { timeout: 15000, intervals: [250] }).toBe(true);
        const imagePath = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${chromeInfo.pid}").ExecutablePath`], { encoding: 'utf8', windowsHide: true }).trim();
        assert(imagePath && /chrome\.exe$/i.test(imagePath));
        identified.app_key = createHash('sha256').update(imagePath.toLowerCase()).digest('hex');
        const candidates = await invoke('get_process_input_sources');
        const matches = candidates.filter(item => item.appKey === identified.app_key && item.name === identified.name && item.routes.length === 1 && item.routes[0].id === raw.id && item.routes[0].muted);
        assert.equal(matches.length, 1, '所有Chromeの候補を一意に特定できません');
        const candidate = matches[0];
        results.ownedSourcePid = chromeInfo.pid;
        const list = await invoke('get_audio_devices', { forceRefresh: true });
        const input = list.inputs.find(d => d.host.toLowerCase() === 'wasapi' && d.name.startsWith('CABLE Output'));
        const output = list.outputs.find(d => d.id === 'wasapi:' + monitor.id);
        const broadcast = list.outputs.find(d => d.id === 'wasapi:' + sink.id);
        assert(input?.id && output && broadcast && input.channels >= 2);
        const start = { host: output.host, input: input.name, inputId: input.id, output: output.name, outputId: output.id, sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] };
        await getPage().evaluate(value => { localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_tutorial_completed', 'true'); localStorage.setItem('vst_host_audio_config', JSON.stringify(value)); }, start);
        await getPage().reload();
        await invoke('set_global_mute', { active: true });
        const monitorBranch = { active: false, preset: 'broadcast', amount: 0, singing: null, reverb: { enabled: false, mix: 0.08, decaySeconds: 1.2, damping: 0.5 } };
        await invoke('live_output', { config: { deviceId: broadcast.id, splitProcessing: true, monitorSinging: monitorBranch, monitorTalk: monitorBranch, monitorTrim: 1, broadcastTrim: 1, monitorMuted: true } });
        await assertStopped();
        async function selectSource() {
            const page = getPage();
            const close = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
            if (await close.isVisible()) await close.click();
            await page.getByRole('button', { name: '設定を開く', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: '設定', exact: true });
            await dialog.getByText('歌・モニター', { exact: true }).click();
            await dialog.getByText('オケを追加して配信する', { exact: true }).click();
            await dialog.getByRole('button', { name: '読み込む', exact: true }).click();
            await expect(dialog.getByText('配信用の分離出力を確認しました。')).toBeVisible();
            await dialog.getByRole('combobox', { name: 'オケの入力元' }).selectOption('process');
            await dialog.getByRole('button', { name: 'アプリ一覧を更新' }).click();
            const selected = dialog.getByRole('combobox', { name: '再生中のアプリを選択' });
            await expect(selected.locator(`option[value="${candidate.id}"]`)).toHaveCount(1);
            await selected.selectOption(candidate.id);
            await dialog.getByRole('combobox', { name: '原音の出力先を選択' }).selectOption(raw.id);
            await dialog.getByRole('checkbox', { name: /配信先と原音の経路/ }).check();
            const before = await snapshot();
            await dialog.getByRole('button', { name: '入力元を適用', exact: true }).click();
            await expect.poll(async () => (await snapshot()).revision !== before.revision, { timeout: 15000 }).toBe(true);
            const applied = await snapshot();
            assert.equal(applied.config?.source.config.appKey, candidate.appKey);
            assert.equal(applied.config?.source.config.rawEndpointId, raw.id);
            await page.screenshot({ path: join(root, 'mixing-selected.png') });
            await close.click();
            return applied;
        }
        phase('mixing-source-ui');
        let applied = await selectSource();
        assert(!applied.running && applied.savedConfig);
        const savedFile = join(configRoot, 'mixing.json');
        assert(!/"(?:pid|created|candidateId|target)"/i.test(readFileSync(savedFile, 'utf8')));
        results.sourceSavedThroughRealUi = true;
        phase('mixing-start-muted');
        await invoke('start_audio', start);
        await checkMuted();
        await expect.poll(async () => {
            const value = await snapshot();
            await checkMuted();
            return value.running && !value.failed && value.accompaniment && !value.accompaniment.failed && value.accompaniment.nonzeroFrames > 1000 && Math.max(...value.voicePeak) > 0 && Math.max(...value.mixPeak) > 0;
        }, { timeout: 20000, intervals: [250] }).toBe(true);
        results.initialMixing = await snapshot();
        results.initialMutedRuntime = await checkMuted();
        const adjust = async levels => {
            const previous = await snapshot();
            const result = await mix({ action: 'levels', ...token(previous), levels });
            await checkMuted();
            await expect.poll(async () => { const value = await snapshot(); await checkMuted(); return !value.pending && !value.failed; }, { timeout: 15000 }).toBe(true);
            return { previous, result };
        };
        let value = (await snapshot()).config.levels;
        const zero = await adjust({ ...value, voice: { gain: 0, muted: false }, offsetMs: 50 });
        assert.equal(zero.result.config.levels.voice.gain, 0);
        await assert.rejects(() => mix({ action: 'levels', ...token(zero.previous), levels: value }), /変わりました|読み直/);
        await expect.poll(async () => { const state = await snapshot(); await checkMuted(); return Math.max(...state.voicePeak) === 0 && Math.max(...state.accompanimentPeak) > 0; }, { timeout: 10000 }).toBe(true);
        value = { ...value, voice: { gain: 1, muted: false }, accompaniment: { gain: 1, muted: true }, offsetMs: -50 };
        const muted = await adjust(value);
        assert.equal(muted.result.config.levels.offsetMs, -50);
        await expect.poll(async () => { const state = await snapshot(); await checkMuted(); return Math.max(...state.accompanimentPeak) === 0 && Math.max(...state.voicePeak) > 0; }, { timeout: 10000 }).toBe(true);
        results.zeroGainSnapshot = zero.result; results.mutedAccompanimentSnapshot = muted.result;
        results.liveLevelsAndStaleRejection = true;
        await invoke('stop_audio'); await assertStopped();
        phase('mixing-restart-reselection');
        await restartHost(); await assertStopped();
        await invoke('set_global_mute', { active: true });
        let current = await snapshot(); assert(current.savedConfig && !current.config && !current.running);
        await assert.rejects(() => invoke('start_audio', start), /選び直|明示選択/);
        await assertStopped();
        // Host再起動でcandidateIdが変わるため、同じ所有PIDを再照合する。
        const afterRestart = (await invoke('get_process_input_sources')).filter(item => item.appKey === identified.app_key && item.name === identified.name && item.routes.length === 1 && item.routes[0].id === raw.id && item.routes[0].muted);
        assert.equal(afterRestart.length, 1); candidate.id = afterRestart[0].id;
        applied = await selectSource(); assert(applied.config);
        await invoke('start_audio', start); await checkMuted(); await invoke('stop_audio'); await assertStopped();
        results.hostRestartRequiresExplicitReselection = true;
        phase('mixing-corrupt-recovery');
        const corrupt = Buffer.from('{"corrupt":');
        writeFileSync(savedFile, corrupt);
        await restartHost(); await assertStopped();
        current = await snapshot(); assert(current.error && !current.config && !current.running);
        await assert.rejects(() => invoke('start_audio', start));
        const page = getPage();
        const dialog = page.getByRole('dialog', { name: '設定', exact: true });
        if (!await dialog.isVisible()) await page.getByRole('button', { name: '設定を開く', exact: true }).click();
        await dialog.getByText('歌・モニター', { exact: true }).click();
        await dialog.getByText('オケを追加して配信する', { exact: true }).click();
        await dialog.getByRole('button', { name: '読み込む', exact: true }).click();
        await dialog.getByText('保存設定を復旧する', { exact: true }).click();
        await dialog.getByRole('checkbox', { name: /現在の保存状態を保管して/ }).check();
        await page.screenshot({ path: join(root, 'mixing-recovery.png') });
        await dialog.getByRole('button', { name: '保存状態を保管してオケを無効にする' }).click();
        await expect(dialog.getByText('保存状態の記録を残し、オケを無効にしました。')).toBeVisible();
        current = await snapshot(); assert(!current.config && !current.savedConfig && !current.error && !current.running);
        assert.equal(parse(readFileSync(savedFile, 'utf8')), null);
        const backup = join(configRoot, 'mixing-backups');
        assert(readdirSync(backup).some(name => name.endsWith('.original.json') && readFileSync(join(backup, name)).equals(corrupt)));
        await dialog.getByRole('button', { name: '設定画面を閉じる', exact: true }).click();
        await invoke('set_global_mute', { active: true }); await invoke('start_audio', start); await checkMuted();
        assert((await snapshot()).running); await invoke('stop_audio'); await assertStopped();
        results.corruptSavedBytesBackedUpAndNormalInputRecovered = true;
    } finally {
        await invoke('stop_audio').catch(() => {});
        if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
            writeFileSync(join(root, 'chrome.stop'), 'stop');
            try { await bounded(once(chrome, 'exit'), 15000, '所有Chromeの終了を確認できません'); }
            catch (error) {
                results.cleanupFailed = true; results.cleanupError = String(error);
                // helperの子孫に限定し、終了できなければ失敗として残す。
                try { execFileSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
            }
        }
        for (const child of owned.reverse()) {
            try { await stopChild(child); } catch (error) { results.cleanupFailed = true; results.cleanupError = String(error); }
        }
        for (const guard of guards) {
            const backup = guard.ready.replace(/\.json$/, '.restore.json');
            if (existsSync(backup)) {
                try { execFileSync(probe, ['restore-endpoint', backup], { windowsHide: true, stdio: 'ignore' }); }
                catch (error) { results.cleanupFailed = true; results.cleanupError = String(error); }
            } else { results.cleanupFailed = true; results.cleanupError = '端点の復元情報がありません'; }
        }
        const after = new Map(endpoints().map(device => [device.id, device]));
        results.mixingEndpointStatePreserved = beforeEndpoints.every(device => ['muted', 'volume', 'default_roles'].every(key => JSON.stringify(device[key]) === JSON.stringify(after.get(device.id)?.[key])));
        assert(!results.cleanupFailed && results.mixingEndpointStatePreserved, '端点または所有プロセスを復元できません');
    }
}

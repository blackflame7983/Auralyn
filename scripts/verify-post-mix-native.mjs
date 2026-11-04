// 段階3専用の所有アプリ検証。録音端点も含む事前ガードに失敗したら操作しない。
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';

const RAW = '{0.0.0.00000000}.{bc439acc-6788-4e71-9a65-8b63b8f82edc}';
const BROADCAST = '{0.0.0.00000000}.{0cb27868-ba34-4251-8fba-35e4ea3706b9}';
const MONITOR = '{0.0.0.00000000}.{dbfcc2a4-96a1-4d52-b31f-fbea7cac6fd1}';
const VST = 'C:/Program Files/Common Files/VST3/TDR Nova.vst3';
const digest = value => createHash('sha256').update(value).digest('hex');
const stable = devices => devices.map(({ id, muted, volume, default_roles }) => ({ id, muted, volume, default_roles })).sort((a, b) => a.id.localeCompare(b.id));

export function postMixFixture({ probe, invoke }) {
    let before;
    return {
        rawId: RAW, sinkId: BROADCAST, monitorId: MONITOR, silentVoice: true, holdSeconds: 3600,
        async verifyCaptureGuard(phase) {
            // probe が録音端点に未対応ならここで停止する。推測して試験を進めない。
            const devices = JSON.parse(execFileSync(probe, ['capture-endpoints'], { encoding: 'utf8', windowsHide: true }));
            const all = await invoke('get_audio_devices', { forceRefresh: true });
            const inputs = all.inputs.filter(d => d.host.toLowerCase() === 'wasapi' && /^Voicemeeter Out A4\b/i.test(d.name));
            assert.equal(inputs.length, 1, 'Voicemeeter Out A4 を一意に確認できません');
            const input = inputs[0];
            const device = devices.find(d => `wasapi:${d.id}`.toLowerCase() === input.id?.toLowerCase());
            assert(device && !input.isDefault && device.default_roles.length === 0 && device.active_processes.length === 0, '録音端点が使用中か既定です');
            if (phase === 'before') before = stable(devices);
            else assert.deepEqual(stable(devices), before, '出力ガードと録音端点の音量・ミュートが連動しています');
        },
    };
}

export async function exercisePostMixNative({ getPage, invoke, snapshot, token, start, selectSource, root, configRoot, results, checkMuted, assertStopped, restartHost, phase }) {
    const request = value => invoke('post_mix', { request: value });
    const state = () => request({ action: 'snapshot' });
    const edit = async (action, fields = {}) => {
        const current = await state();
        return request({ action, expectedEpoch: current.epoch, expectedRevision: current.revision, ...fields });
    };
    const bundle = action => invoke('broadcast_bundle', { request: action });
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    const openPanel = async () => {
        const page = getPage();
        const close = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
        if (!await close.isVisible()) await page.getByRole('button', { name: '設定を開く', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '設定', exact: true });
        await dialog.getByText('歌・モニター', { exact: true }).click();
        await dialog.getByText('オケを追加して配信する', { exact: true }).click();
        if (!await dialog.getByText('ミックス後の配信 VST', { exact: true }).isVisible()) {
            await dialog.getByRole('button', { name: '読み込む', exact: true }).click();
            await expect(dialog.getByText('ミックス後の配信 VST', { exact: true })).toBeVisible();
        }
        const panel = dialog.getByText('ミックス後の配信 VST', { exact: true }).locator('..');
        if (!await panel.evaluate(el => el.open)) await panel.locator('summary').click();
        return { page, dialog, panel, close };
    };
    phase('post-mix-setup-ui');
    await checkMuted(); await invoke('stop_audio'); await assertStopped();
    let { panel, close } = await openPanel();
    await panel.getByRole('button', { name: '状態を読み込む', exact: true }).click();
    await panel.getByRole('button', { name: '保存した VST を復元', exact: true }).click();
    await expect.poll(async () => (await state()).restored).toBe(true);
    await panel.getByRole('button', { name: 'VST 一覧を取得', exact: true }).click();
    const select = panel.getByRole('combobox', { name: '追加する VST' });
    let vstOption;
    await expect.poll(async () => {
        const options = await select.locator('option').evaluateAll(items => items.map(item => item.value));
        vstOption = options.find(path => path.replaceAll('\\', '/').toLowerCase() === VST.toLowerCase());
        return !!vstOption;
    }, { timeout: 60000 }).toBe(true);
    await select.selectOption(vstOption);
    await panel.getByRole('button', { name: '追加', exact: true }).click();
    await expect.poll(async () => (await state()).plugins.length, { timeout: 30000 }).toBe(1);
    const enabled = panel.getByRole('checkbox', { name: '配信 VST を有効にする' });
    await enabled.click();
    await expect.poll(async () => (await state()).enabled, { timeout: 15000 }).toBe(true);
    await expect(enabled).toBeChecked();
    await panel.getByRole('button', { name: '配信 VST を保存', exact: true }).click();
    await expect.poll(async () => (await state()).savedPlugins.length).toBe(1);
    let post = await state();
    assert(post.enabled && post.restored && !JSON.stringify(post).match(/"(?:state|pid|target)"/i));
    const savedPost = readFileSync(join(configRoot, 'post-mix.json'), 'utf8');
    assert(!/"(?:pid|target)"/i.test(savedPost));
    await close.click();
    await invoke('load_plugin', { path: VST });
    let voice = await invoke('session_rack', { request: { action: 'snapshot' } });
    assert.equal(voice.plugins.length, 1);
    await invoke('start_audio', start); await checkMuted();
    await expect.poll(async () => (await state()).running, { timeout: 20000 }).toBe(true);
    post = await state();
    assert.equal(post.transportLatencyFrames, 2048);
    assert(post.declaredPluginLatencyFrames === null || Number.isInteger(post.declaredPluginLatencyFrames));
    const voiceId = voice.plugins[0].id, voiceGain = voice.plugins[0].gain;
    await edit('gain', { id: post.plugins[0].id, value: 0.5 });
    voice = await invoke('session_rack', { request: { action: 'snapshot' } });
    assert.equal(voice.plugins[0].id, voiceId); assert.equal(voice.plugins[0].gain, voiceGain);
    await assert.rejects(() => edit('add', { path: VST }));
    await assert.rejects(() => edit('reorder', { ids: post.plugins.map(p => p.id) }));
    const currentMix = await snapshot();
    await assert.rejects(() => invoke('mixing', { request: { action: 'configure', ...token(currentMix), config: null } }));
    ({ panel, close } = await openPanel());
    await panel.getByRole('button', { name: '状態を読み込む', exact: true }).click();
    await expect(panel.getByRole('button', { name: '音量を適用', exact: true })).toBeEnabled();
    const stale = await state();
    await edit('gain', { id: stale.plugins[0].id, value: 0.6 });
    await assert.rejects(() => request({ action: 'gain', expectedEpoch: stale.epoch, expectedRevision: stale.revision, id: stale.plugins[0].id, value: 0.4 }));
    const fresh = await state();
    await assert.rejects(() => request({ action: 'gain', expectedEpoch: `${fresh.epoch}-stale`, expectedRevision: fresh.revision, id: fresh.plugins[0].id, value: 0.4 }));
    await expect(panel.getByText('設定が変わりました。状態を読み込んでから操作してください。')).toBeVisible({ timeout: 10000 });
    await expect(panel.getByRole('button', { name: '音量を適用', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '状態を読み込む', exact: true }).click();
    await panel.getByRole('button', { name: '編集画面', exact: true }).click();
    await close.click();
    results.postSeparateRackMutedAndStaleRejected = true;

    phase('post-mix-bundle');
    const name = `post-mix-${process.pid}`;
    await assert.rejects(() => bundle({ action: 'save', name: `${name}-legacy`, categories, obs: null }), /分離出力|本番|ミックス/);
    const page = getPage();
    const rackToggle = page.getByRole('button', { name: 'VST を編集', exact: true });
    if (await rackToggle.getAttribute('aria-expanded') !== 'true') await rackToggle.click();
    await page.getByRole('button', { name: 'プロファイル管理', exact: true }).click();
    await page.getByRole('button', { name: 'OBS込みプロファイル', exact: true }).click();
    await page.getByRole('checkbox', { name: 'オケ・ミックス後VSTも保存', exact: true }).check();
    await page.getByLabel('OBS込みプロファイル名', { exact: true }).fill(name);
    await page.getByRole('button', { name: '現在のOBS込みプロファイルを保存', exact: true }).click();
    await expect.poll(() => existsSync(join(configRoot, 'broadcast-bundles', `${name}.json`)), { timeout: 30000 }).toBe(true);
    results.schema5SavedThroughRealUi = true;
    const path = join(configRoot, 'broadcast-bundles', `${name}.json`);
    const originalBytes = readFileSync(path), original = JSON.parse(originalBytes);
    assert.equal(original.schemaVersion, 5);
    assert.equal(original.embeddedAuralynPreset.plugins.length, 1);
    assert.equal(original.mixing.postMix.plugins.length, 1);
    assert(!/"(?:pid|target)"/i.test(JSON.stringify(original.mixing)));
    const captured = await snapshot();
    await invoke('mixing', { request: { action: 'levels', ...token(captured), levels: { ...captured.config.levels, offsetMs: 80 } } });
    post = await state(); await edit('gain', { id: post.plugins[0].id, value: 0.3 });
    const safeSnapshot = async () => {
        const [mix, postState] = await Promise.all([snapshot(), state()]);
        return {
            mixing: { running: mix.running, failed: mix.failed, levels: mix.config?.levels ?? null },
            post: { running: postState.running, enabled: postState.enabled, restored: postState.restored,
                transportLatencyFrames: postState.transportLatencyFrames, declaredPluginLatencyFrames: postState.declaredPluginLatencyFrames,
                plugins: postState.plugins.map(({ name, gain, enabled, muted }) => ({ name, gain, enabled, muted })) },
        };
    };
    results.bundleBefore = await safeSnapshot();
    let preview = await bundle({ action: 'preview', name });
    assert(!JSON.stringify(preview).includes(original.mixing.postMix.plugins[0].state));
    const applied = await bundle({ action: 'apply', id: preview.value.id });
    // state は原本にもログにも出さず、原因文字列からも既知値と長い Base64 を除く。
    const sanitize = value => {
        let text = String(value ?? '');
        for (const secret of [original.embeddedAuralynPreset.plugins[0].state, original.mixing.postMix.plugins[0].state]) {
            if (secret) text = text.replaceAll(secret, '[state]');
        }
        return text.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, '[state]');
    };
    results.bundleApply = { complete: !!applied.value?.complete, undoPending: !!applied.value?.undoPending, reason: sanitize(applied.value?.auralyn) };
    try { results.bundleAfter = await safeSnapshot(); }
    catch { results.bundleAfterUnavailable = true; }
    assert(applied.value?.complete); await checkMuted();
    assert.equal((await snapshot()).config.levels.offsetMs, captured.config.levels.offsetMs);
    assert.equal((await state()).plugins[0].gain, 0.6);
    const verifyName = `${name}-verify`;
    await bundle({ action: 'save', name: verifyName, categories, obs: null, includeOutput: true, includeLive: true, includeMixing: true });
    const verified = JSON.parse(readFileSync(join(configRoot, 'broadcast-bundles', `${verifyName}.json`), 'utf8'));
    assert.equal(digest(verified.embeddedAuralynPreset.plugins[0].state), digest(original.embeddedAuralynPreset.plugins[0].state));
    assert.equal(digest(verified.mixing.postMix.plugins[0].state), digest(original.mixing.postMix.plugins[0].state));
    const undone = await bundle({ action: 'undo', id: applied.value.id });
    assert(undone.value?.complete); await checkMuted();
    assert.equal((await snapshot()).config.levels.offsetMs, 80);
    assert.equal((await state()).plugins[0].gain, 0.3);
    results.schema5ApplyUndoMuted = true;
    try {
        const missing = JSON.parse(originalBytes); missing.mixing.postMix.plugins[0].path = join(root, 'missing-post.vst3');
        writeFileSync(path, JSON.stringify(missing));
        preview = await bundle({ action: 'preview', name });
        assert(preview.value.output.missingPlugins.length > 0);
        await assert.rejects(() => bundle({ action: 'apply', id: preview.value.id }));
        await checkMuted();
        results.missingPostVstRejected = true;
    } finally { writeFileSync(path, originalBytes); }
    assert.equal(digest(readFileSync(path)), digest(originalBytes));
    await invoke('stop_audio'); await assertStopped();
    post = await state();
    await edit('reorder', { ids: post.plugins.map(p => p.id) }); await edit('save');
    await restartHost(); await assertStopped();
    await invoke('set_global_mute', { active: true });
    await assert.rejects(() => invoke('start_audio', start));
    ({ panel, close } = await openPanel());
    await panel.getByRole('button', { name: '状態を読み込む', exact: true }).click();
    await panel.getByRole('button', { name: '保存した VST を復元', exact: true }).click();
    await expect.poll(async () => (await state()).restored).toBe(true);
    await close.click(); await selectSource();
    await invoke('start_audio', start); await checkMuted();
    await expect.poll(async () => (await state()).running, { timeout: 20000 }).toBe(true);
    results.restartRequiresExplicitRestoreAndSelection = true;
    await invoke('stop_audio'); await assertStopped();
    ({ panel, close } = await openPanel());
    await panel.getByRole('button', { name: '状態を読み込む', exact: true }).click();
    await panel.getByText('保存設定を復旧する', { exact: true }).click();
    await panel.getByRole('checkbox', { name: '保存状態を保管して配信 VST を無効にします。' }).check();
    await panel.getByRole('button', { name: '保存状態を保管して無効にする', exact: true }).click();
    await expect.poll(async () => !(await state()).enabled).toBe(true);
    await close.click(); await invoke('start_audio', start); await checkMuted();
    await expect.poll(async () => (await snapshot()).running, { timeout: 20000 }).toBe(true);
}

// 一時利用への切替は既存の全体 apply/Undo 試験と分離し、復旧原本だけを対象にする。
export async function exercisePostMixCheckpoint({ invoke, snapshot, token, start, selectSource, root, configRoot, results, checkMuted, assertStopped, phase, switchSession, postVst = VST }) {
    const postRequest = request => invoke('post_mix', { request });
    const postState = () => postRequest({ action: 'snapshot' });
    const postEdit = async (action, fields = {}) => {
        const current = await postState();
        return postRequest({ action, expectedEpoch: current.epoch, expectedRevision: current.revision, ...fields });
    };
    const bundle = request => invoke('broadcast_bundle', { request });
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    const secretHashes = saved => ({ voice: digest(saved.embeddedAuralynPreset.plugins[0].state), post: digest(saved.mixing.postMix.plugins[0].state) });
    const savedPath = name => join(configRoot, 'broadcast-bundles', `${name}.json`);
    const read = path => JSON.parse(readFileSync(path, 'utf8'));
    phase('checkpoint-racks-prepare');
    await checkMuted(); await invoke('stop_audio'); await assertStopped();
    await postEdit('restore_saved');
    await postEdit('add', { path: postVst });
    await postEdit('enable', { enabled: true });
    await postEdit('save');
    await invoke('load_plugin', { path: VST });
    await invoke('start_audio', start); await checkMuted();
    await expect.poll(async () => (await postState()).running, { timeout: 20000 }).toBe(true);
    const voice = await invoke('session_rack', { request: { action: 'snapshot' } });
    assert.equal(voice.plugins.length, 1);
    await invoke('set_gain', { id: voice.plugins[0].id, value: 0.42 });
    let post = await postState(); await postEdit('gain', { id: post.plugins[0].id, value: 0.37 });
    const mix = await snapshot();
    const levels = { ...mix.config.levels, offsetMs: 73 };
    await invoke('mixing', { request: { action: 'levels', ...token(mix), levels } });
    await expect.poll(async () => {
        const current = await snapshot(), stats = await checkMuted();
        return !current.pending && !current.failed && current.config?.levels.offsetMs === 73 && !stats.preparation.controlsPending;
    }, { timeout: 15000 }).toBe(true);
    const baselineName = `checkpoint-baseline-${process.pid}`;
    await bundle({ action: 'save', name: baselineName, categories, obs: null, includeOutput: true, includeLive: true, includeMixing: true });
    const baseline = read(savedPath(baselineName));
    assert.equal(baseline.schemaVersion, 5);
    assert.equal(baseline.embeddedAuralynPreset.plugins.length, 1);
    assert.equal(baseline.mixing.postMix.plugins.length, 1);
    const normalizePath = path => path.replaceAll('\\', '/').toLowerCase();
    assert.equal(normalizePath(baseline.embeddedAuralynPreset.plugins[0].path), normalizePath(VST));
    assert.equal(normalizePath(baseline.mixing.postMix.plugins[0].path), normalizePath(postVst));
    const hashes = secretHashes(baseline);
    if (normalizePath(postVst) !== normalizePath(VST)) {
        assert.notEqual(hashes.voice, hashes.post, '声用と配信用の state が同一のため取り違えを検出できません');
        results.checkpointDistinctRackStates = true;
    }
    results.checkpointExpectedHashes = hashes;
    phase('checkpoint-enter-temporary');
    await switchSession(true, true); await assertStopped();
    const temporary = await invoke('temporary_session_status');
    assert(temporary.temporary && temporary.reviewOnly);
    const scratch = resolve(temporary.directory);
    assert(scratch.startsWith(join(root, 'os-temp') + sep) && /^Auralyn-temporary-[a-f0-9]{32}$/i.test(basename(scratch)) && !lstatSync(scratch).isSymbolicLink());
    const receiptPath = join(configRoot, 'broadcast-bundle-recovery.json');
    const receipt = read(receiptPath);
    assert.equal(receipt.version, 1); assert.equal(receipt.runtime?.version, 3);
    assert.match(receipt.runtime.sha256, /^[a-f0-9]{64}$/i);
    assert.equal(receipt.devices?.inputId, start.inputId);
    assert.equal(receipt.devices?.outputId, start.outputId);
    const backupPath = join(configRoot, 'broadcast-bundle-backups', 'broadcast-bundles', `${receipt.backupName}.json`);
    const backupBytes = readFileSync(backupPath), backup = JSON.parse(backupBytes);
    const backupDigest = digest(backupBytes);
    assert.equal(backup.schemaVersion, 5);
    assert.deepEqual(secretHashes(backup), hashes);
    assert.equal(normalizePath(backup.embeddedAuralynPreset.plugins[0].path), normalizePath(VST));
    assert.equal(normalizePath(backup.mixing.postMix.plugins[0].path), normalizePath(postVst));
    assert.deepEqual(backup.mixing.input.levels, levels);
    assert.equal(backup.mixing.postMix.plugins[0].gain, 0.37);
    assert(!/"(?:pid|created|candidateId|target)"/i.test(JSON.stringify(backup.mixing)));
    assert(!JSON.stringify(receipt).includes(baseline.mixing.postMix.plugins[0].state));
    results.checkpointOrigin3AndBothRackHashes = true;
    phase('checkpoint-return-normal');
    await switchSession(false); await assertStopped();
    const returned = await invoke('temporary_session_status');
    assert(!returned.temporary && returned.reviewOnly);
    results.checkpointTemporaryScratchRemoved = !existsSync(scratch);
    if (!results.checkpointTemporaryScratchRemoved) {
        assert(returned.cleanupPending && resolve(returned.cleanupPending) === scratch);
        results.checkpointTemporaryCleanupFailureReported = true;
    }
    await invoke('set_global_mute', { active: true });
    await assert.rejects(() => invoke('start_audio', start));
    const recovery = await bundle({ action: 'recovery_status' });
    assert(recovery.value?.readable && recovery.value?.runtimeCheckpoint);
    await postEdit('restore_saved');
    await selectSource();
    await invoke('start_audio', start); await checkMuted();
    await expect.poll(async () => {
        const current = await snapshot(), stats = await checkMuted();
        return current.running && !current.failed && !stats.preparation.controlsPending;
    }, { timeout: 20000 }).toBe(true);
    phase('checkpoint-explicit-recovery');
    const preview = await bundle({ action: 'recovery_preview' });
    assert(!JSON.stringify(preview).includes(baseline.mixing.postMix.plugins[0].state));
    const restored = await bundle({ action: 'recovery_apply', id: preview.value.id });
    let reason = String(restored.value?.auralyn ?? '');
    for (const secret of [baseline.embeddedAuralynPreset.plugins[0].state, baseline.mixing.postMix.plugins[0].state]) {
        if (secret) reason = reason.replaceAll(secret, '[state]');
    }
    reason = reason.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, '[state]');
    results.checkpointRecovery = { complete: !!restored.value?.complete, undoPending: !!restored.value?.undoPending, reason };
    assert(restored.value?.complete); await checkMuted();
    assert.equal((await snapshot()).config.levels.offsetMs, 73);
    post = await postState(); assert.equal(post.plugins[0].gain, 0.37);
    const afterName = `checkpoint-restored-${process.pid}`;
    await bundle({ action: 'save', name: afterName, categories, obs: null, includeOutput: true, includeLive: true, includeMixing: true });
    const after = read(savedPath(afterName));
    assert.deepEqual(secretHashes(after), hashes);
    assert.equal(normalizePath(after.embeddedAuralynPreset.plugins[0].path), normalizePath(VST));
    assert.equal(normalizePath(after.mixing.postMix.plugins[0].path), normalizePath(postVst));
    assert.deepEqual(after.mixing.input.levels, levels);
    assert.equal(after.embeddedAuralynPreset.plugins[0].gain, 0.42);
    assert.equal(after.mixing.postMix.plugins[0].gain, 0.37);
    assert.equal(digest(readFileSync(backupPath)), backupDigest);
    assert.equal((await bundle({ action: 'recovery_status' })).value, null);
    results.checkpointRestoredBothRacksMutedAndOriginalRetained = true;
}

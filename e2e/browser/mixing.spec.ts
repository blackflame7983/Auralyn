import { test, expect } from './tauriFixture';

test('二入力を明示読込し、キーボードで調整する', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', inputId: 'mic', output: 'Test headphones', outputId: 'headphones', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] }));
        const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
        const levels = { voice: { gain: 0, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 };
        const config = { version: 1, source: { kind: 'device', config: { host: 'WASAPI', inputId: 'music', inputChannels: [0, 1] } }, levels };
        (window as any).__mixRequests = [];
        internal.invoke = async (command: string, args: any) => {
            if (command === 'live_output') return { config: { deviceId: 'out', splitProcessing: true, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
            if (command === 'mixing') { (window as any).__mixRequests.push(args.request); return { epoch: 'e', revision: '1', config, savedConfig: config, error: null, running: false, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [1.2, 1], knownVoiceProcessingFrames: null, pending: false, failed: false, primaryClock: null }; }
            return original(command, args);
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定' });
    await dialog.getByText('歌・モニター', { exact: true }).click();
    const summary = dialog.getByText('オケを追加して配信する', { exact: true });
    await summary.focus(); await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).__mixRequests.length)).toBe(0);
    const load = dialog.getByRole('button', { name: '読み込む', exact: true });
    await load.focus(); await page.keyboard.press('Enter');
    await expect(dialog.getByText(/声の既知の処理待ち: 不明/)).toBeVisible();
    await expect(dialog.getByText(/1.20/)).toBeVisible();
    const apply = dialog.getByRole('button', { name: '調整を適用' });
    await apply.scrollIntoViewIfNeeded(); await apply.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.some((r: any) => r.action === 'levels' && r.levels.voice.gain === 0))).toBe(true);
    await page.screenshot({ path: info.outputPath('mixing.png') });
});

test('オケ未選択でも配信 VST を明示読込し、キーボードで調整と復旧を操作する', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', inputId: 'mic', output: 'Test headphones', outputId: 'headphones', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] }));
        const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
        const plugin = { id: 'post-1', path: 'fixture.vst3', name: 'Fixture EQ', enabled: true, muted: false, gain: 0 };
        const post = { epoch: 'post-epoch', revision: '1', enabled: false, running: false, savedPlugins: [], plugins: [plugin], restored: true, error: null as string | null, transportLatencyFrames: 2048, declaredPluginLatencyFrames: null, opaqueState: 'OPAQUE_STATE_MUST_NOT_RENDER' };
        (window as any).__postRequests = []; (window as any).__postCorrupt = false;
        internal.invoke = async (command: string, args: any) => {
            if (command === 'live_output') return { config: { deviceId: null, splitProcessing: false, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
            if (command === 'mixing') return { epoch: 'mix-epoch', revision: '1', config: null, savedConfig: null, error: null, running: false, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [0, 0], knownVoiceProcessingFrames: null, pending: false, failed: false, primaryClock: null };
            if (command === 'post_mix') {
                const request = args.request; (window as any).__postRequests.push(request);
                if (request.action === 'gain') { plugin.gain = request.value; post.revision = '2'; }
                if (request.action === 'reset') { post.plugins = []; post.restored = false; post.revision = '3'; (window as any).__postCorrupt = false; }
                post.error = (window as any).__postCorrupt ? 'corrupt saved state' : null;
                return structuredClone(post);
            }
            return original(command, args);
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '設定' });
    await dialog.getByText('歌・モニター', { exact: true }).click();
    const mixing = dialog.getByText('オケを追加して配信する', { exact: true });
    await mixing.focus(); await page.keyboard.press('Enter');
    const mixLoad = dialog.getByRole('button', { name: '読み込む', exact: true });
    await mixLoad.focus(); await page.keyboard.press('Enter');
    await expect(dialog.getByText('現在の入力元: 未選択')).toBeVisible();
    const postDetails = dialog.locator('details').filter({ has: page.locator('summary').getByText('ミックス後の配信 VST', { exact: true }) }).last();
    const postSummary = postDetails.locator('summary').first();
    await postSummary.scrollIntoViewIfNeeded(); await postSummary.focus(); await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).__postRequests)).toEqual([]);
    const load = postDetails.getByRole('button', { name: '状態を読み込む' });
    await load.focus(); await page.keyboard.press('Enter');
    await expect(postDetails.getByText('追加の転送待ち: 2048 フレーム')).toBeVisible();
    expect((await page.evaluate(() => (window as any).__postRequests)).every((r: any) => r.action === 'snapshot')).toBe(true);
    await expect(postDetails.getByRole('checkbox', { name: '配信 VST を有効にする' })).toBeDisabled();
    await expect(dialog.getByText('OPAQUE_STATE_MUST_NOT_RENDER')).toHaveCount(0);
    const gain = postDetails.getByRole('group', { name: 'Fixture EQ' }).getByRole('spinbutton');
    await expect(gain).toHaveValue('0');
    const apply = postDetails.getByRole('button', { name: '音量を適用' });
    await apply.scrollIntoViewIfNeeded(); await apply.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__postRequests.some((r: any) => r.action === 'gain' && r.value === 0 && r.expectedRevision === '1'))).toBe(true);
    await page.evaluate(() => { (window as any).__postCorrupt = true; });
    await load.scrollIntoViewIfNeeded(); await load.focus(); await page.keyboard.press('Enter');
    await expect(postDetails.getByRole('alert')).toContainText('配信 VST を確認または変更できません');
    const recovery = postDetails.locator('details').filter({ has: page.locator('summary').getByText('保存設定を復旧する', { exact: true }) });
    const recoverySummary = recovery.locator('summary');
    await recoverySummary.scrollIntoViewIfNeeded(); await recoverySummary.focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const confirmation = recovery.getByRole('checkbox', { name: '保存状態を保管して配信 VST を無効にします。' });
    await expect(confirmation).toBeFocused(); await page.keyboard.press('Space');
    const reset = recovery.getByRole('button', { name: '保存状態を保管して無効にする' });
    await page.keyboard.press('Tab'); await expect(reset).toBeFocused();
    const box = await reset.boundingBox(); expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    const geometry = await dialog.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, overflow: Array.from(el.querySelectorAll('*')).filter(node => node.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 60), width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })) }));
    await page.screenshot({ path: info.outputPath('post-mix-recovery.png') });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.overflow).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(recovery.getByRole('status')).toContainText('保存状態の記録を残し');
    const requests = await page.evaluate(() => (window as any).__postRequests);
    expect(requests.filter((r: any) => r.action === 'reset')).toEqual([{ action: 'reset', expectedEpoch: 'post-epoch', expectedRevision: '2' }]);
    expect(requests.some((r: any) => ['restore_saved', 'add', 'enable'].includes(r.action))).toBe(false);
});

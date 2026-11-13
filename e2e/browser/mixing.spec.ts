import { test, expect } from './tauriFixture';
import type { Page, Locator } from '@playwright/test';

async function fixture(page: Page, configPresent = true, running = false, panelShown = true) {
    await page.addInitScript(({ configPresent, running, panelShown }) => {
        // 配信ミックスはホームのパネルで操作する（#299）。
        if (panelShown) localStorage.setItem('auralyn_stream_mix_panel', 'shown');
        localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Test microphone', inputId: 'mic', output: 'Test headphones', outputId: 'headphones', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] }));
        const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
        const levels = { voice: { gain: 0, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 };
        const config = { version: 1, source: { kind: 'device', config: { host: 'WASAPI', inputId: 'music', inputChannels: [0, 1] } }, levels };
        const mix = { epoch: 'mix', revision: '1', config: configPresent ? config : null, savedConfig: configPresent ? config : null, error: null, running, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [1.2, 1], knownVoiceProcessingFrames: 480, pending: false, failed: false, primaryClock: { outputRateHz: 48000 } };
        const post = { epoch: 'post', revision: '1', enabled: configPresent, running, savedPlugins: [], plugins: [{ id: 'post-1', path: 'fixture.vst3', name: 'Fixture EQ', enabled: true, muted: false, gain: 0 }, { id: 'post-2', path: 'comp.vst3', name: 'Fixture Comp', enabled: true, muted: false, gain: 1 }], restored: true, error: null as string | null, transportLatencyFrames: 2048, declaredPluginLatencyFrames: 0, attached: running, ready: running, failed: false, processedPackets: 42, sampleRate: 48000 };
        (window as any).__mixRequests = []; (window as any).__postRequests = []; (window as any).__postCorrupt = false;
        internal.invoke = async (command: string, args: any) => {
            if (command === 'live_output') return { config: { deviceId: (window as any).__liveOutputMissing ? null : 'out', splitProcessing: true, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
            if (command === 'mixing') { const r = args.request; (window as any).__mixRequests.push(r); if (r.action === 'levels' && (window as any).__mixFailLevels) throw new Error('stale revision'); if (r.action === 'levels') { config.levels = r.levels; mix.revision = String(Number(mix.revision) + 1); } return structuredClone(mix); }
            if (command === 'post_mix') { const r = args.request; (window as any).__postRequests.push(r);
                if (r.action === 'gain') { post.plugins[0].gain = r.value; post.revision = String(Number(post.revision) + 1); }
                if (r.action === 'reorder') { post.plugins = r.ids.map((id: string) => post.plugins.find(p => p.id === id)!); post.revision = String(Number(post.revision) + 1); }
                if (r.action === 'reset') { post.plugins = []; post.restored = false; post.enabled = false; post.revision = String(Number(post.revision) + 1); (window as any).__postCorrupt = false; }
                post.error = (window as any).__postCorrupt ? 'corrupt saved state' : null; return structuredClone(post);
            }
            return original(command, args);
        };
    }, { configPresent, running, panelShown });
}
async function settings(page: Page) {
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const surface = page.locator('[data-settings-page]');
    await expect(surface).toHaveAttribute('data-settings-page', 'connect');
    return surface;
}
async function streamMix(page: Page) { const panel = page.locator('#stream-mix-panel'); await expect(panel).toBeVisible(); return panel; }
async function keyboardOpen(page: Page, element: Locator) { await element.scrollIntoViewIfNeeded(); await element.focus(); await page.keyboard.press('Enter'); }
async function noOverflow(dialog: Locator) { expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1); }

test('オケは1段で自動表示し、キーボードの音量調整を適用ボタンなしで送る', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 }); await fixture(page); await page.goto('/'); const dialog = await streamMix(page);
    const mixing = dialog.locator('#mixing-settings'); await keyboardOpen(page, mixing.locator('summary').first());
    await expect(mixing.getByText('適用中の入力元:', { exact: false })).toBeVisible(); await expect(mixing.getByText('声の処理待ち：10.0 ms', { exact: true })).toBeVisible();
    await expect(mixing.getByRole('region', { name: '動作中の設定' })).toBeVisible();
    const draft = mixing.getByRole('region', { name: '編集中の内容' });
    const reload = draft.getByRole('button', { name: '保存内容で編集中の内容を置き換える' });
    expect(await reload.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
    const slider = mixing.getByRole('slider', { name: '声の音量' }); await slider.scrollIntoViewIfNeeded(); await slider.focus(); await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuetext', '1%');
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.some((r: any) => r.action === 'levels' && r.levels.voice.gain === 0.01 && r.expectedRevision === '1'))).toBe(true);
    await noOverflow(dialog); await page.screenshot({ path: info.outputPath('mixing-keyboard.png') });
});

test('オケを開かず配信VSTを自動表示し、音量・エラー詳細・確認付き初期化にキーボードで到達する', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 }); await fixture(page, false); await page.goto('/'); const dialog = await streamMix(page);
    const post = dialog.locator('details').filter({ has: page.locator('summary').getByText('配信音を仕上げるVST', { exact: true }) }).last();
    await keyboardOpen(page, post.locator('summary').first());
    await expect(dialog.locator('#mixing-settings')).not.toHaveAttribute('open', ''); await expect(post.getByText('転送の待ち時間：42.7 ms')).toBeVisible();
    await expect(post.getByRole('switch', { name: '配信VSTを有効にする' })).toBeDisabled();
    await expect(post.getByRole('switch', { name: '配信VSTを有効にする' })).toHaveAccessibleDescription(/オケの入力元/);
    const slider = post.getByRole('slider', { name: 'Fixture EQのゲイン' }); await slider.scrollIntoViewIfNeeded(); await slider.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => (window as any).__postRequests.some((r: any) => r.action === 'gain' && r.value === 0.01 && r.expectedRevision === '1'))).toBe(true);
    await page.evaluate(() => { (window as any).__postCorrupt = true; });
    await post.getByRole('button', { name: '最新の状態を読み直す' }).click();
    const error = post.getByRole('alert'); await expect(error).toContainText('保存ファイルを読み取れません');
    await keyboardOpen(page, error.locator('summary')); await expect(error.getByText('corrupt saved state', { exact: true })).toBeVisible();
    const recovery = post.locator('details').filter({ has: page.locator('summary').getByText('保存設定を復旧する', { exact: true }) });
    await keyboardOpen(page, recovery.locator('summary')); await page.keyboard.press('Tab');
    const confirmation = recovery.getByRole('checkbox'); await expect(confirmation).toBeFocused(); await page.keyboard.press('Space'); await page.keyboard.press('Tab');
    const reset = recovery.getByRole('button', { name: '保存状態を保管して無効にする' }); await expect(reset).toBeFocused(); await noOverflow(dialog);
    await page.screenshot({ path: info.outputPath('post-mix-reset.png') }); await page.keyboard.press('Enter'); await expect(recovery.getByRole('status')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__postRequests.filter((r: any) => r.action === 'reset'))).toEqual([{ action: 'reset', expectedEpoch: 'post', expectedRevision: '2' }]);
});

for (const size of [{ width: 900, height: 600 }, { width: 1024, height: 768 }]) {
    test(`英語・150%表示 ${size.width}x${size.height} で配信ミックスが収まる`, async ({ page }, info) => {
        await page.setViewportSize(size); await page.addInitScript(() => localStorage.setItem('vst_host_locale', 'en')); await fixture(page); await page.goto('/'); const dialog = await streamMix(page);
        await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
        const mixing = dialog.locator('#mixing-settings'); await keyboardOpen(page, mixing.locator('summary').first());
        const post = dialog.locator('details').filter({ has: page.locator('summary').getByText('Finish broadcast audio with VST', { exact: true }) }).last(); await keyboardOpen(page, post.locator('summary').first());
        const slider = post.getByRole('slider', { name: 'Fixture EQ gain' }); await expect(slider).toBeVisible(); await slider.scrollIntoViewIfNeeded(); await noOverflow(dialog);
        expect(await post.evaluate(el => Array.from(el.querySelectorAll('*')).filter(n => n.getClientRects().length && n.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(n => n.tagName))).toEqual([]);
        expect(await mixing.innerText()).not.toMatch(/[ぁ-んァ-ヶ一-龠]/); expect(await post.innerText()).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
        await page.screenshot({ path: info.outputPath('english-150.png') });
    });
}

test('ホームで設定を開かずオケ音量とミュートを変更し、停止状態から設定へ移動する', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 768 }); await fixture(page); await page.goto('/');
    const trigger = page.getByRole('button', { name: 'オケ音量とミュート' }); await trigger.click(); const popup = page.getByRole('dialog', { name: 'オケ音量とミュート' });
    const slider = popup.getByRole('slider'); await slider.focus(); await page.keyboard.press('Home');
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.some((r: any) => r.action === 'levels' && r.levels.accompaniment.gain === 0))).toBe(true);
    await popup.getByRole('button', { name: 'ミュート', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.some((r: any) => r.action === 'levels' && r.levels.accompaniment.muted))).toBe(true);
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(page.getByRole('button', { name: /オケ停止.*配信VST停止/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('home-mix.png') }); await page.getByRole('button', { name: /オケ停止.*配信VST停止/ }).click(); await expect(page.locator('#mixing-settings')).toHaveAttribute('open', '');
    await expect(page.locator('#mixing-settings > summary')).toBeFocused();
});

test('共通のVSTカードでキーボードの並べ替えを配信ラックへ送る', async ({ page }) => {
    await fixture(page, false); await page.goto('/'); const dialog = await streamMix(page);
    const post = dialog.locator('details').filter({ has: page.locator('summary').getByText('配信音を仕上げるVST', { exact: true }) }).last(); await keyboardOpen(page, post.locator('summary').first());
    const handle = post.getByRole('button', { name: 'Fixture EQを並べ替え' }); await handle.scrollIntoViewIfNeeded(); await handle.focus(); await page.keyboard.press('Space');
    await expect(handle).toHaveAttribute('aria-pressed', 'true');
    const announcements = page.locator('[id^="DndLiveRegion"]'); await expect(announcements).toContainText('並べ替えを開始');
    await page.keyboard.press('ArrowDown'); await expect(announcements).toContainText('2番目（全2件）へ移動');
    await page.keyboard.press('Space'); await expect.poll(() => page.evaluate(() => (window as any).__postRequests.filter((r: any) => r.action === 'reorder').map((r: any) => r.ids))).toEqual([['post-2', 'post-1']]);
});

test('ミュート直後の音量操作をまとめて反映し、失敗した音量を成功表示しない', async ({ page }) => {
    await fixture(page); await page.goto('/'); const trigger = page.getByRole('button', { name: 'オケ音量とミュート' }); await trigger.click();
    const popup = page.getByRole('dialog', { name: 'オケ音量とミュート' });
    await popup.getByRole('button', { name: 'ミュート', exact: true }).click(); await popup.getByRole('slider').focus(); await page.keyboard.press('Home');
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.filter((r: any) => r.action === 'levels').map((r: any) => r.levels.accompaniment).at(-1))).toEqual({ gain: 0, muted: true });
    await page.evaluate(() => { (window as any).__mixFailLevels = true; }); await page.keyboard.press('End');
    await expect(popup.getByRole('alert')).toContainText('音量・時間差の変更');
    await expect(popup.getByRole('slider')).toHaveAttribute('aria-valuetext', '0%');
    await expect.poll(() => page.evaluate(() => (window as any).__mixRequests.filter((r: any) => r.action === 'snapshot').length)).toBeGreaterThan(1);
    await expect(popup.getByRole('slider')).toHaveAttribute('aria-valuetext', '0%'); await expect(popup.getByRole('alert')).toBeVisible();
});

test('配信ミックスのパネルは既定で出さず、ホームの状態から出して開き、設定で隠せる（#299）', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 768 }); await fixture(page, true, false, false); await page.goto('/');
    await expect(page.locator('#stream-mix-panel')).toHaveCount(0);
    await page.getByRole('button', { name: /オケ停止.*配信VST停止/ }).click();
    await expect(page.locator('#stream-mix-panel #mixing-settings')).toHaveAttribute('open', '');
    await expect(page.locator('#mixing-settings > summary')).toBeFocused(); await page.screenshot({ path: info.outputPath('stream-mix-panel.png') });
    const dialog = await settings(page);
    // オーディオタブには機器と接続だけを残し、配信ミックスの操作は置かない。
    await expect(dialog.locator('#mixing-settings')).toHaveCount(0);
    const show = dialog.getByRole('checkbox', { name: 'ホームにパネルを出す' }); await expect(show).toBeChecked(); await show.uncheck();
    await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
    await expect(page.locator('[data-settings-page]')).toHaveCount(0);
    await expect(page.locator('#stream-mix-panel')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('auralyn_stream_mix_panel'))).toBe('hidden');
});

test('配信ミックスのパネルから出力先の区画へ移り、音づくりタブからパネルへ戻れる（#299）', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => { (window as any).__liveOutputMissing = true; });
    await fixture(page); await page.goto('/');
    const panel = await streamMix(page);
    await panel.locator('#mixing-settings > summary').click();
    await panel.getByRole('button', { name: '配信用の分離出力を設定' }).click();
    const dialog = page.locator('[data-settings-page]');
    await expect(dialog.locator('#live-output-settings')).toHaveAttribute('open', '');
    await expect(dialog.locator('#live-output-settings select').first()).toBeFocused();
    await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '音づくり', exact: true }).click();
    await page.locator('[data-settings-page]').getByRole('button', { name: '配信ミックスの設定' }).click();
    await expect(page.locator('[data-settings-page]')).toHaveCount(0);
    await expect(page.locator('#stream-mix-panel #mixing-settings > summary')).toBeFocused();
});

test('ホームの表示が音楽鑑賞向けなら、設定から配信ミックスを開く操作を止めて理由を示す（#299）', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('auralyn_display_purpose', 'music'));
    await fixture(page, true, false, false); await page.goto('/');
    const dialog = await settings(page);
    await expect(dialog.getByRole('button', { name: 'ホームで開く' })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: 'ホームにパネルを出す' })).toBeDisabled();
    await expect(dialog.getByText('ホームの表示が「音楽鑑賞向け」のときは出ません。')).toBeVisible();
});

// DOM試験では判断できない高さ・フッターとの重なり・操作位置を実ブラウザで守る。
test.describe('本番中の配信ミックスの配置', () => {
    test.use({ liveHome: true, builtinEnabled: true });
    for (const size of [{ width: 1280, height: 800 }, { width: 960, height: 640 }]) {
        for (const theme of ['light', 'dark', 'gaming']) {
            test(`配信ミックスの入口はスクロールせず届き、外枠を重ねない（#355 ${size.width} ${theme}）`, async ({ page }) => {
                await page.setViewportSize(size);
                await page.addInitScript(theme => localStorage.setItem('vst_host_theme', theme), theme);
                await fixture(page, true, true);
                await page.goto('/');
                const panel = await streamMix(page);
                const main = page.locator('main');
                // 起動画面の退場と区画の位置の補間（transform）が終わってから測る。
                await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
                const bounds = await panel.evaluate(el => {
                    const strip = document.querySelector('[aria-label="声の流れ"]')!;
                    const chain = document.querySelector('.sound-chain')!;
                    const box = el.getBoundingClientRect();
                    return { top: box.top, bottom: box.bottom, stripBottom: strip.getBoundingClientRect().bottom,
                        chainTop: chain.getBoundingClientRect().top, footerTop: window.innerHeight,
                        borders: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].map(key => getComputedStyle(el).getPropertyValue(key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`))) };
                });
                expect(bounds.top).toBeGreaterThanOrEqual(bounds.stripBottom);
                expect(bounds.bottom).toBeLessThanOrEqual(bounds.chainTop);
                expect(bounds.bottom).toBeLessThanOrEqual(bounds.footerTop);
                expect(bounds.borders).toEqual(['0px', '0px', '0px', '0px']);
                await expect(page.getByRole('region', { name: 'いまの状態', exact: true })).toBeVisible();
                // 折りたたみが0件でも素通りしないよう、先に件数を確かめる。
                await expect(panel.locator(':scope > details > summary')).not.toHaveCount(0);
                for (const summary of await panel.locator(':scope > details > summary').all()) {
                    await expect(summary).toBeInViewport({ ratio: 1 });
                    expect(await summary.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
                }
                expect(await main.evaluate(el => el.scrollTop)).toBe(0);
                // 本番帯の既存の近道でも音量操作を続けられる。
                await page.getByRole('button', { name: 'オケ音量とミュート' }).click();
                await expect(page.getByRole('dialog', { name: 'オケ音量とミュート' }).getByRole('slider')).toBeInViewport({ ratio: 1 });
                expect(await main.evaluate(el => el.scrollTop)).toBe(0);
            });
        }
    }
});

import { test, expect } from './tauriFixture';
import { presetOutputMuted } from './e2eHooks';
import { mustBox } from './mustBox';
import { settleLayoutMotion } from './layoutMotion';
import { message } from '../../src/i18n/messages';
import type { Page } from '@playwright/test';

test.use({ liveHome: true, builtinEnabled: true });

async function prepare(page: Page, theme = 'dark', locale: 'ja' | 'en' = 'ja') {
    await page.addInitScript(({ theme, locale }) => {
        localStorage.setItem('vst_host_theme', theme); localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        const internals = window.__TAURI_INTERNALS__;
        const setOutputMuted = window.__e2eSetOutputMuted;
        if (!internals || !setOutputMuted) throw new Error('模擬の Tauri 内部APIまたは出力ミュートの操作がありません');
        const original = internals.invoke;
        const asRecord = (value: unknown): Record<string, unknown> => {
            if (typeof value !== 'object' || value === null) throw new Error('オブジェクトではありません');
            return value as Record<string, unknown>;
        };
        const live = { mode: null as string | null, nextMode: null as string | null, pendingReads: 0, armed: false };
        let muted = false, noiseMode = 'low', preset = 'broadcast';
        const actions: string[] = [];
        window.__refineActions = actions; window.__refineUnknown = false;
        internals.invoke = async (command, args) => {
            if (command === 'obs_setup_history') return [];
            if (command === 'disconnect_obs') return;
            const params = args === undefined ? {} : asRecord(args);
            if (command === 'set_noise_control_config') { noiseMode = String(params.mode); actions.push(command); return; }
            if (command === 'set_built_in_effects') { preset = String(params.preset); actions.push(command); return; }
            // 模擬の緊急ミュートの切替が、実エンジンと同じ通知を送る。
            if (command === 'toggle_global_mute') { muted = !muted; setOutputMuted(muted); return; }
            if (command === 'live_modes') {
                const action = String(asRecord(params.request).action);
                if (action !== 'snapshot') {
                    actions.push(action);
                    if (action === 'singing_on') { live.nextMode = 'singing'; live.pendingReads = 1; }
                    else if (action === 'talk_on') { live.nextMode = 'talk'; live.pendingReads = 1; }
                    else if (action === 'arm') live.armed = true;
                    else if (action === 'disarm') live.armed = false;
                    else throw new Error(`Unexpected mode action: ${action}`);
                }
                const result = asRecord(await original(command, { request: { action: 'snapshot' } }));
                if (live.nextMode && live.pendingReads-- > 0) return { ...result, phase: 'queued', target: live.nextMode, applied: live.mode, armed: live.armed };
                if (live.nextMode) { live.mode = live.nextMode; live.nextMode = null; }
                return { ...result, phase: live.mode ? 'settled' : 'custom', target: live.mode, applied: live.mode, armed: live.armed };
            }
            const result = await original(command, args);
            if (command === 'get_engine_runtime_stats') {
                const stats = asRecord(result);
                Object.assign(stats, {
                    noiseReductionEnabled: true, noiseReductionActive: true, noiseReductionMode: noiseMode,
                    noiseControlStrength: 0.6, noiseVoiceGuard: false, builtInEffectsPreset: preset,
                });
                if (window.__refineUnknown) delete stats.preparation;
                Object.assign(asRecord(asRecord(asRecord(stats.latencyMetadata).stageBreakdown).nr), { enabled: true });
            }
            return result;
        };
    }, { theme, locale });    await page.goto('/');
    await presetOutputMuted(page, false);
    await expect(page.getByRole('region', { name: message(locale, 'prep.title'), exact: true }).getByRole('button', { name: message(locale, 'prep.steps'), exact: true })).toHaveAttribute('aria-expanded', 'false');
}

for (const theme of ['light', 'dark', 'gaming']) for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 600 }]) {
    test(`本番帯の優先順位と高さ配分 ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
        await page.setViewportSize(size); await prepare(page, theme);
        const live = page.getByRole('region', { name: message('ja', 'home.now'), exact: true });
        const modes = page.getByRole('region', { name: message('ja', 'band.label'), exact: true }).getByRole('radiogroup', { name: message('ja', 'liveBar.mode') });
        for (const key of ['liveBar.singing', 'liveBar.talk'] as const) await expect(modes.getByRole('radio', { name: message('ja', key), exact: true })).toBeInViewport();
        await expect(modes.getByRole('radio', { checked: true })).toHaveCount(0);
        await expect(modes.getByText(message('ja', 'liveBar.custom'))).toHaveCount(0);
        const customHeading = live.getByRole('heading', { name: message('ja', 'liveBar.custom'), exact: true });
        await expect(customHeading).toHaveAttribute('title', message('ja', 'liveBar.customHint'));
        await expect(page.getByRole('complementary', { name: message('ja', 'shell.safetyColumn'), exact: true }).getByRole('button', { name: message('ja', 'liveBar.protect'), exact: true })).toHaveAttribute('title', `${message('ja', 'liveBar.protect')}\n${message('ja', 'liveBar.protectHint')}`);
        await expect(live.getByRole('button', { name: message('ja', 'liveBar.editRegistration'), exact: true })).toHaveCount(0);
        expect(await page.locator('main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        if (size.width === 1280) {
            // 配置が落ち着く前（区画が滑って移る途中）の位置で比べない。
            await settleLayoutMotion(page);
            const column = page.getByRole('complementary', { name: message('ja', 'shell.safetyColumn'), exact: true });
            expect((await mustBox(column.getByRole('meter').first())).height).toBe(16);
            const bars = await column.getByRole('meter').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, name: el.getAttribute('aria-label') }; }));
            expect(bars).toHaveLength(1);
            expect(bars[0].name).toBe(message('ja', 'home.inputLevel'));
            await expect(column.locator('p', { hasText: /出力のピーク/ })).toBeVisible();
            const statuses = column.locator('[role="meter"] [data-meter-status]');
            await expect(statuses).toHaveCount(1);
            expect(await statuses.evaluateAll(nodes => nodes.every(el => {
                const meter = el.closest('[role="meter"]');
                if (!meter) return false;
                const bar = meter.getBoundingClientRect();
                const text = el.getBoundingClientRect();
                return getComputedStyle(el).position === 'absolute'
                    && text.left >= bar.left && text.right <= bar.right
                    && text.top >= bar.top && text.bottom <= bar.bottom
                    && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight;
            }))).toBe(true);
            await expect(page.getByRole('region', { name: message('ja', 'prep.title'), exact: true })).toBeInViewport();
        }
        await page.screenshot({ path: info.outputPath('healthy.png') });
        await page.getByRole('button', { name: message('ja', 'prep.steps'), exact: true }).click();
        await expect(live).toBeVisible();
        await expect(page.getByRole('radiogroup', { name: message('ja', 'prep.usage') })).toBeVisible();
        await live.getByRole('button', { name: message('ja', 'liveBar.actions'), exact: true }).click();
        await page.getByRole('button', { name: message('ja', 'home.singingSetup'), exact: true }).click();
        // 歌配信の準備は設定ではなく、ホームの配信ミックスのパネルを開いて移る（#299）。
        await expect(page.locator('#stream-mix-panel #mixing-settings > summary')).toBeFocused();
        await expect(page.locator('#stream-mix-panel')).toBeInViewport();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
}

for (const locale of ['ja', 'en'] as const) test(`900x600の150%で状態文字と操作が切れない ${locale}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 }); await prepare(page, 'light', locale);
    await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; document.documentElement.style.setProperty('--ui-zoom', '1.5'); });
    const live = page.getByRole('region', { name: message(locale, 'home.now'), exact: true });
    const statuses = page.getByRole('complementary', { name: message(locale, 'shell.safetyColumn'), exact: true }).locator('[role="meter"] [data-meter-status]');
    await expect(statuses.first()).toHaveText(message(locale, 'meter.waitingShort'));
    expect(await statuses.evaluateAll(nodes => nodes.every(el => getComputedStyle(el).textOverflow !== 'ellipsis' && el.scrollHeight <= el.clientHeight + 1))).toBe(true);
    expect(await page.locator('main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await live.getByRole('button', { name: message(locale, 'liveBar.actions'), exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('zoom-waiting.png') });
    await live.getByRole('button', { name: message(locale, 'liveBar.actions'), exact: true }).click();
    await page.getByRole('button', { name: message(locale, 'liveBar.editRegistration'), exact: true }).click();
    const dialog = page.locator('[data-settings-page]');
    const modes = dialog.locator('#live-mode-settings');
    for (const key of ['settings.LiveModeControls.212', 'settings.LiveModeControls.213'] as const) {
        const card = modes.getByRole('region', { name: message(locale, key), exact: true });
        await expect(card.getByRole('button', { name: message(locale, 'settings.mode.save', { mode: message(locale, key) }), exact: true })).toBeVisible();
        await expect(card.getByRole('combobox')).toBeHidden();
    }
    expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('zoom-mode-cards.png') });
});

for (const theme of ['light', 'dark', 'gaming']) test(`設定の階層と明示スタイルを150%で維持する ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 }); await prepare(page, theme);
    await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; document.documentElement.style.setProperty('--ui-zoom', '1.5'); });
    const modes = page.getByRole('region', { name: message('ja', 'band.label'), exact: true }).getByRole('radiogroup', { name: message('ja', 'liveBar.mode') });
    await expect(modes.getByRole('radio', { checked: true })).toHaveCount(0);
    const marker = modes.locator('[data-segment-indicator]');
    await expect(marker).toHaveCSS('opacity', '0');
    await modes.getByRole('radio', { name: '歌', exact: true }).click();
    await expect(modes.getByRole('radio', { name: '歌', exact: true })).toHaveAttribute('aria-checked', 'true');
    // 拡大時の境界線は物理ピクセルに丸められるため、CSS上の厳密な3px比較はしない。
    expect(await marker.evaluate(el => parseFloat(getComputedStyle(el).borderBottomWidth))).toBeGreaterThanOrEqual(2.5);
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const dialog = page.locator('[data-settings-page]');
    // 入力の用途の選択欄は無くなり（#723）、配信・通話の入力は「マイク」の欄の1つだけ。
    const inputName = message('ja', 'settings.AudioSettingsModal.038');
    const input = dialog.getByRole('group', { name: inputName, exact: true });
    await expect(input).toBeVisible();
    expect(await input.locator('legend').evaluate(el => getComputedStyle(el).fontSize)).toBe('20px');
    expect(await input.getByRole('combobox', { name: inputName, exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    await page.screenshot({ path: info.outputPath('audio-zoom.png') });
    const rail = page.getByRole('navigation', { name: '行き先' });
    for (const tab of ['settings.sound', 'settings.obs', 'settings.shortcuts', 'settings.system', 'settings.appearance'] as const) {
        if (tab === 'settings.sound') await rail.getByRole('button', { name: '音づくり', exact: true }).click();
        else {
            await rail.getByRole('button', { name: '設定', exact: true }).click();
            await dialog.getByRole('tab', { name: message('ja', tab), exact: true }).click();
        }
        const headings = dialog.getByRole('tabpanel').getByRole('heading', { level: 3 });
        expect(await headings.evaluateAll(nodes => nodes.filter(el => parseFloat(getComputedStyle(el).fontSize) < 20).map(el => ({ text: el.textContent, size: getComputedStyle(el).fontSize })))).toEqual([]);
        expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath(`${tab}-zoom.png`) });
    }
});

test('選択背景が確定値へ移動し、ミュート押下と動きを減らす設定を守る', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 }); await prepare(page);
    const noise = page.getByRole('radiogroup', { name: message('ja', 'structure.noise.standard') });
    const indicator = noise.locator('[data-segment-indicator]');
    await expect(noise.getByRole('radio', { name: message('ja', 'master.nrLow'), exact: true })).toHaveAttribute('aria-checked', 'true');
    const before = await indicator.boundingBox();
    await noise.getByRole('radio', { name: message('ja', 'master.nrHigh'), exact: true }).focus();
    expect(await page.evaluate(() => (window as any).__refineActions)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(noise.getByRole('radio', { name: message('ja', 'master.nrHigh'), exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await indicator.boundingBox())!.x).toBeGreaterThan(before!.x + 20);
    expect(await indicator.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0.2s');
    const modes = page.getByRole('radiogroup', { name: message('ja', 'liveBar.mode') });
    const modeMarker = await modes.locator('[data-segment-indicator]').elementHandle();
    await modes.getByRole('radio', { name: message('ja', 'liveBar.singing'), exact: true }).click();
    await expect(modes.getByRole('radio', { name: message('ja', 'liveBar.singing'), exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(await modeMarker!.evaluate(el => el.isConnected)).toBe(true);
    const protect = page.getByRole('button', { name: message('ja', 'liveBar.protect'), exact: true });
    await protect.focus();
    await page.keyboard.press('Enter');
    await expect(protect).toHaveAttribute('aria-pressed', 'true');
    await expect(protect).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(protect).toHaveAttribute('aria-pressed', 'false');
    await expect(protect).toBeFocused();
    await protect.hover(); await page.mouse.down();
    expect(await protect.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    await page.mouse.move(1, 1); await page.mouse.up();
    const mute = page.getByRole('button', { name: message('ja', 'header.emergency'), exact: true });
    await mute.hover(); await page.mouse.down();
    await expect.poll(() => mute.evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
    await page.mouse.up();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await indicator.evaluate(el => getComputedStyle(el).transitionProperty)).not.toMatch(/(?:^|,\s*)(?:all|transform)(?:,|$)/);
    await mute.hover(); await page.mouse.down();
    expect(await mute.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    await page.mouse.up();
    await page.screenshot({ path: info.outputPath('selection.png') });
});

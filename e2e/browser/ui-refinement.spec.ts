import { test, expect } from './tauriFixture';
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
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let mode: string | null = null, nextMode: string | null = null, pendingReads = 0, armed = false, muted = false, noiseMode = 'low', preset = 'broadcast';
        (window as any).__refineActions = []; (window as any).__refineUnknown = false;
        (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
            if (command === 'obs_setup_history') return [];
            if (command === 'disconnect_obs') return;
            if (command === 'set_noise_control_config') { noiseMode = args.mode; (window as any).__refineActions.push(command); return; }
            if (command === 'set_built_in_effects') { preset = args.preset; (window as any).__refineActions.push(command); return; }
            if (command === 'toggle_global_mute') { muted = !muted; (window as any).__e2eSetOutputMuted(muted); (window as any).__e2eEmit('global-mute-changed', muted); return; }
            if (command === 'live_modes') {
                if (args.request.action !== 'snapshot') {
                    (window as any).__refineActions.push(args.request.action);
                    if (args.request.action === 'singing_on') { nextMode = 'singing'; pendingReads = 1; }
                    else if (args.request.action === 'talk_on') { nextMode = 'talk'; pendingReads = 1; }
                    else if (args.request.action === 'arm') armed = true;
                    else if (args.request.action === 'disarm') armed = false;
                    else throw new Error(`Unexpected mode action: ${args.request.action}`);
                }
                const result = await original(command, { request: { action: 'snapshot' } });
                if (nextMode && pendingReads-- > 0) return { ...result, phase: 'queued', target: nextMode, applied: mode, armed };
                if (nextMode) { mode = nextMode; nextMode = null; }
                return { ...result, phase: mode ? 'settled' : 'custom', target: mode, applied: mode, armed };
            }
            const result = await original(command, args);
            if (command === 'get_engine_runtime_stats') {
                result.noiseReductionEnabled = true; result.noiseReductionActive = true; result.noiseReductionMode = noiseMode;
                result.noiseControlStrength = 0.6; result.noiseVoiceGuard = false;
                result.builtInEffectsPreset = preset;
                if ((window as any).__refineUnknown) delete result.preparation;
                result.latencyMetadata.stageBreakdown.nr.enabled = true;
            }
            return result;
        };
    }, { theme, locale });
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    await expect(page.getByRole('region', { name: message(locale, 'prep.title'), exact: true }).getByRole('button', { name: message(locale, 'prep.steps'), exact: true })).toHaveAttribute('aria-expanded', 'false');
}

for (const theme of ['light', 'dark', 'gaming']) for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 600 }]) {
    test(`本番帯の優先順位と高さ配分 ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
        await page.setViewportSize(size); await prepare(page, theme);
        const live = page.getByRole('region', { name: message('ja', 'home.now'), exact: true });
        const modes = page.getByRole('region', { name: message('ja', 'band.label'), exact: true }).getByRole('radiogroup', { name: message('ja', 'liveBar.mode') });
        for (const key of ['liveBar.singing', 'liveBar.talk'] as const) await expect(modes.getByRole('radio', { name: message('ja', key), exact: true })).toBeInViewport();
        await expect(modes.locator('[aria-current=true]')).toHaveText(message('ja', 'liveBar.custom'));
        await expect(page.getByRole('complementary', { name: message('ja', 'shell.safetyColumn'), exact: true }).getByRole('button', { name: message('ja', 'liveBar.protect'), exact: true })).toHaveAttribute('title', message('ja', 'liveBar.protect'));
        await expect(live.getByRole('button', { name: message('ja', 'liveBar.editRegistration'), exact: true })).toHaveCount(0);
        expect(await page.locator('main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        if (size.width === 1280) {
            // 配置が落ち着く前（区画が滑って移る途中）の位置で比べない。
            await settleLayoutMotion(page);
            const column = page.getByRole('complementary', { name: message('ja', 'shell.safetyColumn'), exact: true });
            expect((await column.getByRole('meter').first().boundingBox())!.height).toBe(16);
            const bars = await column.getByRole('meter').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; }));
            expect(bars).toHaveLength(2);
            expect(bars[0].top).toBeLessThan(bars[1].top);
            const statuses = column.locator('[role="meter"] [data-meter-status]');
            await expect(statuses).toHaveCount(2);
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
    await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
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
    await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
    const modes = page.getByRole('region', { name: message('ja', 'band.label'), exact: true }).getByRole('radiogroup', { name: message('ja', 'liveBar.mode') });
    const custom = modes.locator('[aria-current=true]');
    expect(await custom.evaluate(el => el.parentElement!.querySelector('[data-segment-indicator]')!.parentElement!.contains(el))).toBe(false);
    await modes.getByRole('radio', { name: '歌', exact: true }).click();
    await expect(modes.getByRole('radio', { name: '歌', exact: true })).toHaveAttribute('aria-checked', 'true');
    const marker = modes.locator('[data-segment-indicator]');
    // 拡大時の境界線は物理ピクセルに丸められるため、CSS上の厳密な3px比較はしない。
    expect(await marker.evaluate(el => parseFloat(getComputedStyle(el).borderBottomWidth))).toBeGreaterThanOrEqual(2.5);
    await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
    const dialog = page.locator('[data-settings-page]');
    const input = dialog.getByRole('group', { name: '入力元と用途', exact: true });
    await expect(input).toBeVisible();
    expect(await input.locator('legend').evaluate(el => getComputedStyle(el).fontSize)).toBe('20px');
    expect(await input.getByRole('combobox', { name: '入力元', exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
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

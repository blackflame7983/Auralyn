import { test, expect } from './tauriFixture';
import { message } from '../../src/i18n/messages';

test.use({ liveHome: true, builtinEnabled: true });

for (const theme of ['dark', 'light', 'gaming']) {
    test(`本番操作と正常時の1行表示 ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.addInitScript(theme => {
            localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_setup_goal', 'obs');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, theme);
        await page.goto('/');
        await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
        const prep = page.getByRole('region', { name: message('ja', 'prep.title'), exact: true });
        await expect(prep.getByRole('button', { name: message('ja', 'prep.steps') })).toHaveAttribute('aria-expanded', 'false');
        expect((await prep.boundingBox())!.height).toBeLessThan(55);
        await expect(page.getByRole('radio')).toHaveCount(0);
        await expect(page.getByRole('button', { name: message('ja', 'header.setupOpen'), exact: true })).toHaveCount(0);
        for (const key of ['header.emergency', 'liveBar.singing', 'liveBar.talk', 'liveBar.actions'] as const) {
            await expect(page.getByRole('button', { name: message('ja', key), exact: true })).toBeInViewport();
        }
        await expect(page.getByRole('button', { name: message('ja', 'home.voiceCheck'), exact: true })).toBeInViewport();
        await page.evaluate(() => { const emit = () => (window as any).__e2eEmit('audio-level', { input: [0.2, 0.15], output: [0.15, 0.1] }); emit(); window.setInterval(emit, 100); });
        await expect(page.getByRole('meter', { name: message('ja', 'home.inputLevel'), exact: true })).toHaveAttribute('aria-valuenow', /.+/);
        await page.screenshot({ path: info.outputPath('home.png') });
        await prep.getByRole('button', { name: message('ja', 'prep.steps') }).click();
        await expect(prep.getByRole('region', { name: message('ja', 'flow.diagram') })).toContainText('CABLE Output');
        await expect(prep).toContainText(message('ja', 'flow.receiverUnknown'));
        await page.getByRole('button', { name: message('ja', 'liveBar.actions'), exact: true }).click();
        await page.getByRole('button', { name: message('ja', 'home.singingSetup'), exact: true }).click();
        await expect(page.locator('#mixing-settings')).toHaveAttribute('open', '');
        await expect(page.locator('#mixing-settings > summary')).toBeFocused();
    });
}

test('音楽鑑賞は送り先を変更せず、再生元と聴く機器を示す', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_display_purpose', 'music');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    await expect(page.getByRole('button', { name: message('ja', 'prep.steps') })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('main')).not.toContainText('OBS');
    await expect(page.locator('main')).not.toContainText('通話');
    await expect(page.locator('main')).not.toContainText('マイク');
    await expect(page.locator('main')).not.toContainText(message('ja', 'purpose.liveDetails'));
    await expect(page.locator('main')).toContainText('CABLE Output');
    await expect(page.locator('main')).toContainText('スピーカー');
    await page.getByRole('button', { name: message('ja', 'prep.steps') }).click();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('region', { name: message('ja', 'flow.diagram') })).toContainText(message('ja', 'music.source'));
    expect(await page.evaluate(() => localStorage.getItem('vst_host_setup_goal'))).toBe('obs');
    await page.screenshot({ path: info.outputPath('music.png') });
});

test('オーロラは入力に反応し、動きを減らす設定と表示OFFを守る', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
    });
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    const glow = page.locator('.live-aurora');
    // 普通の話し声に近い −20 dBFS でも、見て分かる強さで反応する。
    await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.1, 0.08], output: [0.05, 0.04] }));
    await expect.poll(() => glow.evaluate(el => Number((el as HTMLElement).style.getPropertyValue('--aurora-energy')))).toBeGreaterThanOrEqual(0.6);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await glow.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    expect(await glow.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
    await page.getByRole('button', { name: message('ja', 'header.audioSettingsOpen'), exact: true }).click();
    await page.getByRole('tab', { name: message('ja', 'settings.appearance'), exact: true }).click();
    const toggle = page.getByRole('switch', { name: message('ja', 'aurora.label') });
    await toggle.click();
    await expect(glow).toHaveCount(0);
});

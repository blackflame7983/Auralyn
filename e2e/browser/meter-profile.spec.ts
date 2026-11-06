import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test as base, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';

// 専用runnerが起動した隔離WebView2だけを使う。通常のブラウザ試験では実行しない。
const test = base.extend({ page: async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.METER_PROFILE_CDP!);
    try { await use(browser.contexts()[0].pages()[0]); } finally { await browser.close(); }
} });
test.skip(!process.env.METER_PROFILE_CDP, 'node scripts/measure-meter-render.mjs から実行する');
test.use({ liveHome: true, registeredModes: false, nativeMeterProfile: true });

for (const theme of ['dark', 'light', 'gaming']) test(`WebView2のメーター描画計測 ${theme}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.addInitScript(theme => {
        (window as any).__meterRenderCounts = {};
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    }, theme);
    await page.goto('http://127.0.0.1:1427/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    await settleLayoutMotion(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const results = [];
    if (theme === 'dark') for (const channel of ['idle', 'input', 'output']) {
        await page.evaluate(() => (window as any).__meterRenderCounts = {});
        const before = await cdp.send('Performance.getMetrics');
        const counts = await page.evaluate(async channel => {
            let ticks = 0, frames = 0;
            const frame = () => { frames++; raf = requestAnimationFrame(frame); };
            let raf = requestAnimationFrame(frame);
            const timer = setInterval(() => {
                ticks++;
                if (channel !== 'idle') {
                    const n = .25 + (ticks % 20) / 100;
                    (window as any).__e2eEmit('audio-level', { input: channel === 'input' ? [n, n] : [0, 0], output: channel === 'output' ? [n, n] : [0, 0] });
                }
            }, 16);
            await new Promise(resolve => setTimeout(resolve, 5000));
            clearInterval(timer); cancelAnimationFrame(raf);
            return { renders: { ...(window as any).__meterRenderCounts }, ticks, frames };
        }, channel);
        const after = await cdp.send('Performance.getMetrics');
        const metrics = Object.fromEntries(after.metrics.filter(m => ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(m.name))
            .map(m => [m.name, m.value - before.metrics.find(v => v.name === m.name)!.value]));
        results.push({ channel, ...counts, metrics });
    }
    // 同じ一定値へ収束した状態で、見た目・寸法と値を保存する。
    await page.evaluate(() => { (window as any).__profileTimer = setInterval(() => (window as any).__e2eEmit('audio-level', { input: [.25, .25], output: [.4, .4] }), 16); });
    await expect.poll(async () => Number(await page.getByRole('meter', { name: 'マイクの入力レベル', exact: true }).getAttribute('aria-valuenow'))).toBeCloseTo(20 * Math.log10(.25), 3);
    await page.waitForTimeout(500);
    await page.screenshot({ path: info.outputPath(`${theme}.png`) });
    const meters = await page.getByRole('meter').evaluateAll(nodes => nodes.map(node => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { name: node.getAttribute('aria-label'), value: node.getAttribute('aria-valuenow'), x, y, width, height };
    }));
    await page.evaluate(() => clearInterval((window as any).__profileTimer));
    const file = info.outputPath('profile.json');
    await writeFile(file, JSON.stringify({ theme, userAgent: await page.evaluate(() => navigator.userAgent), results, meters }, null, 2));
    await info.attach('profile.json', { path: file, contentType: 'application/json' });
});

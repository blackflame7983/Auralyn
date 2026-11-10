import { test, expect } from './tauriFixture';
import type { Page } from '@playwright/test';
import sharp from 'sharp';

// 文字だけを一時的に透明にし、カーテンと文字背面を合成した実画素で可読性を確認する。
async function stageTitleContrast(page: Page) {
    const title = page.locator('.live-stage-mode');
    const color = await title.evaluate(element => {
        const color = getComputedStyle(element).color;
        (element as HTMLElement).style.color = 'transparent';
        return color;
    });
    let background: Buffer;
    try { background = await title.screenshot(); }
    finally { await title.evaluate(element => (element as HTMLElement).style.removeProperty('color')); }
    const luminance = (rgb: number[]) => rgb.map(value => {
        const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(color.match(/[\d.]+/g)!.slice(0, 3).map(Number));
    const { data, info } = await sharp(background).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let minimum = Infinity;
    for (let i = 0; i < data.length; i += info.channels) {
        const pixel = luminance([data[i], data[i + 1], data[i + 2]]);
        minimum = Math.min(minimum, (Math.max(foreground, pixel) + 0.05) / (Math.min(foreground, pixel) + 0.05));
    }
    return minimum;
}

test.use({ liveHome: true, video: { mode: 'on', size: { width: 1280, height: 800 } } });
test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});

test('一定の入力でも光のカーテンが流れ、動きを減らす設定では静止する', async ({ page }, info) => {
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    const canvas = page.locator('.live-aurora-canvas');
    await expect(canvas).toHaveAttribute('data-ready', 'true');
    await expect(canvas).toHaveAttribute('data-animated', 'true');
    await page.waitForTimeout(900);
    // 入力イベントを送らなくても、形状が時間とともに変わることを描画結果で確認する。
    const before = await canvas.screenshot({ path: info.outputPath('curtain-before.png') });
    await page.waitForTimeout(1800);
    const after = await canvas.screenshot({ path: info.outputPath('curtain-after.png') });
    expect(before.equals(after)).toBe(false);
    await page.screenshot({ path: info.outputPath('home-aurora.png') });
    const contrast = await stageTitleContrast(page);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await info.attach('title-contrast-dark', { body: String(contrast), contentType: 'text/plain' });
    await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.5, 0.4], output: [0.3, 0.3] }));
    await expect.poll(() => page.locator('.live-aurora').evaluate(element => Number((element as HTMLElement).style.getPropertyValue('--aurora-energy')))).toBeGreaterThan(0.5);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(canvas).toHaveAttribute('data-animated', 'false');
    // 音量が変わっても静止画を維持する。メーター自体は止めない。
    const still = await canvas.screenshot();
    await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.8, 0.7], output: [0.5, 0.5] }));
    await page.waitForTimeout(400);
    expect(still.equals(await canvas.screenshot())).toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(canvas).toHaveAttribute('data-animated', 'true');
    const rendering = await canvas.evaluate(async element => {
        const surface = element as HTMLCanvasElement;
        const gl = surface.getContext('webgl')!;
        const original = gl.drawArrays.bind(gl);
        const timestamps: number[] = [];
        gl.drawArrays = (...args) => { timestamps.push(performance.now()); original(...args); };
        await new Promise(resolve => setTimeout(resolve, 2000));
        gl.drawArrays = original;
        const intervals = timestamps.slice(1).map((time, index) => time - timestamps[index]);
        return { width: surface.width, height: surface.height, draws: timestamps.length, meanIntervalMs: intervals.reduce((a, b) => a + b, 0) / intervals.length };
    });
    expect(rendering.draws).toBeGreaterThan(0);
    await info.attach('browser-rendering-sample', { body: JSON.stringify(rendering), contentType: 'application/json' });
});

test('オーロラを隠すと描画面を外し、音声停止後は消灯する', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.live-aurora-canvas')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => {
        localStorage.setItem('vst_host_aurora_display', 'false');
        window.dispatchEvent(new StorageEvent('storage', { key: 'vst_host_aurora_display' }));
    });
    await expect(page.locator('.live-aurora')).toHaveCount(0);
    await page.evaluate(() => {
        localStorage.setItem('vst_host_aurora_display', 'true');
        window.dispatchEvent(new StorageEvent('storage', { key: 'vst_host_aurora_display' }));
    });
    await expect(page.locator('.live-aurora-canvas')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => (window as any).__e2eEmit('audio-stopped', null));
    await expect(page.locator('.live-aurora')).toHaveAttribute('data-lit', 'false');
    await expect(page.locator('.live-aurora-canvas')).toHaveAttribute('data-animated', 'false');
    await expect(page.locator('.live-aurora')).toHaveCSS('opacity', '0');
});

test('ライトの最小窓でもカーテンと操作面を分ける', async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => localStorage.setItem('vst_host_theme', 'light'));
    await page.goto('/');
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
    await expect(page.locator('.live-aurora-canvas')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.live-stage-mode')).toBeVisible();
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('home-aurora-light.png') });
    const contrast = await stageTitleContrast(page);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await info.attach('title-contrast-light', { body: String(contrast), contentType: 'text/plain' });
});

test('非表示・ゲーミングでは描画を休止し、復帰時は再開する', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.live-aurora-canvas');
    await expect(canvas).toHaveAttribute('data-animated', 'true');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(canvas).toHaveAttribute('data-animated', 'false');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(canvas).toHaveAttribute('data-animated', 'true');
    await page.evaluate(() => document.documentElement.classList.add('gaming'));
    await expect(canvas).toHaveAttribute('data-animated', 'false');
    await page.evaluate(() => document.documentElement.classList.remove('gaming'));
    await expect(canvas).toHaveAttribute('data-animated', 'true');
});

test('GPUコンテキストを失っても操作を残し、復旧するとカーテンを描き直す', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.live-aurora-canvas');
    await expect(canvas).toHaveAttribute('data-ready', 'true');
    await canvas.evaluate(element => {
        const extension = (element as HTMLCanvasElement).getContext('webgl')!.getExtension('WEBGL_lose_context')!;
        (window as any).__auroraContextRecovery = extension;
        extension.loseContext();
    });
    await expect(canvas).toHaveAttribute('data-ready', 'false');
    await expect(page.locator('.live-aurora svg')).toBeVisible();
    await expect(page.getByRole('button', { name: '設定を開く', exact: true })).toBeEnabled();
    await page.evaluate(() => (window as any).__auroraContextRecovery.restoreContext());
    await expect(canvas).toHaveAttribute('data-ready', 'true');
    await expect(canvas).toHaveAttribute('data-animated', 'true');
});

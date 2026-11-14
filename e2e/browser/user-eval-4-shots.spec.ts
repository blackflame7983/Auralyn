import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

// 段階4の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-4';

async function openHome(page: Page, shot: { width: number; height: number; locale: 'ja' | 'en'; music?: boolean; muted?: boolean }) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.addInitScript(({ locale, music }: { locale: 'ja' | 'en'; music?: boolean }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
    }, shot);
    await page.goto('/');
    const splash = shot.locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
    await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
    if (!shot.muted) await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
}

test.describe('段階4の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.use({ liveHome: true, builtinEnabled: true });
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    const shots: { name: string; width: number; height: number; locale: 'ja' | 'en'; music?: boolean; muted?: boolean; silent?: boolean; level?: boolean }[] = [
        { name: 'live-ja-960x640', width: 960, height: 640, locale: 'ja', level: true },
        { name: 'live-ja-1024x768', width: 1024, height: 768, locale: 'ja', level: true },
        { name: 'live-ja-1920x1080', width: 1920, height: 1080, locale: 'ja', level: true },
        { name: 'live-en-1024x768', width: 1024, height: 768, locale: 'en', level: true },
        { name: 'silent-ja-1024x768', width: 1024, height: 768, locale: 'ja', silent: true },
        { name: 'music-ja-1024x768', width: 1024, height: 768, locale: 'ja', music: true, level: true },
        { name: 'muted-ja-1024x768', width: 1024, height: 768, locale: 'ja', muted: true, level: true },
    ];
    for (const shot of shots) {
        test(shot.name, async ({ page }) => {
            await openHome(page, shot);
            if (shot.silent) await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0, 0], output: [0, 0] }));
            if (shot.level) await page.evaluate(() => (window as any).__e2eEmit('audio-level', { input: [0.35, 0.3], output: [0.3, 0.25] }));
            const now = shot.locale === 'ja' ? 'いまの状態' : 'Current status';
            await expect(page.getByRole('region', { name: now, exact: true })).toBeVisible();
            await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
        });
    }
});

test.describe('段階4の停止中の画面記録', () => {
    test.skip(!recordShots, '画面の記録は USER_EVAL_SHOTS=1 のときだけ撮る');
    test.use({ liveHome: true, stoppedHome: true, builtinEnabled: true });
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    test('stopped-ja-960x640', async ({ page }) => {
        await page.setViewportSize({ width: 960, height: 640 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_locale', 'ja');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_setup_goal', 'obs');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: '声の流れ', exact: true }).locator('[data-flow-status="stopped"]')).toHaveText('音声停止中');
        await page.screenshot({ path: `${dir}/stopped-ja-960x640.png`, animations: 'disabled' });
    });
});

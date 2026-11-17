import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

// 段階5の画面記録。通常の試験と CI では撮らない。
const recordShots = process.env.USER_EVAL_SHOTS === '1';
const dir = 'docs/verification/user-eval-5';

async function openConfigured(page: Page, locale: 'ja' | 'en', width: number, height: number, music: boolean) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(({ locale, music }: { locale: 'ja' | 'en'; music: boolean }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', music ? 'music' : 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        if (music) localStorage.setItem('auralyn_display_purpose', 'music');
    }, { locale, music });
    await page.goto('/');
    const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
    await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
}

test.describe('段階5の画面記録', () => {
    test.beforeAll(() => { if (recordShots) mkdirSync(dir, { recursive: true }); });

    test.describe('最初の画面', () => {
        for (const locale of ['ja', 'en'] as const) {
            test(`setup-${locale}-900x600`, async ({ page }) => {
                await page.setViewportSize({ width: 900, height: 600 });
                await page.addInitScript(locale => localStorage.setItem('vst_host_locale', locale), locale);
                await page.goto('/');
                const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
                await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
                const wizard = page.getByRole('dialog', { name: locale === 'ja' ? 'セットアップ' : 'Setup', exact: true });
                await expect(wizard).toBeVisible();
                await expect(wizard.getByRole('radio', { name: locale === 'ja' ? '音楽を聴く（PCの音にVSTをかける）' : 'Listen to music (apply VST to PC audio)', exact: true })).toBeVisible();
                if (recordShots) await page.screenshot({ path: `${dir}/setup-${locale}-900x600.png`, animations: 'disabled' });
            });
        }
    });

    test.describe('音楽鑑賞のホーム', () => {
        test.use({ liveHome: true, builtinEnabled: true });
        const homes = [
            { name: 'music-ja-1024x768', locale: 'ja' as const, width: 1024, height: 768 },
            { name: 'music-ja-900x600', locale: 'ja' as const, width: 900, height: 600 },
            { name: 'music-en-1024x768', locale: 'en' as const, width: 1024, height: 768 },
        ];
        for (const shot of homes) {
            test(shot.name, async ({ page }) => {
                await openConfigured(page, shot.locale, shot.width, shot.height, true);
                const heading = shot.locale === 'ja' ? '音楽鑑賞' : 'Music listening';
                await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
                const playback = shot.locale === 'ja' ? '保存した構成' : 'Saved setups';
                await expect(page.getByRole('region', { name: playback, exact: true })).toHaveCount(0);
                if (recordShots) await page.screenshot({ path: `${dir}/${shot.name}.png`, animations: 'disabled' });
            });
        }
    });

    test.describe('接続の使い方と外観の案内', () => {
        test.use({ liveHome: true, builtinEnabled: true });
        for (const locale of ['ja', 'en'] as const) {
            test(`connect-${locale}-1024x768`, async ({ page }) => {
                await openConfigured(page, locale, 1024, 768, false);
                await page.getByRole('button', { name: locale === 'ja' ? '接続（オーディオの設定）' : 'Connection (audio settings)', exact: true }).click();
                await expect(page.getByRole('button', { name: locale === 'ja' ? '切り替える' : 'Switch', exact: true })).toBeVisible();
                if (recordShots) await page.screenshot({ path: `${dir}/connect-${locale}-1024x768.png`, animations: 'disabled' });
                if (locale !== 'ja') return;
                await page.getByRole('button', { name: '設定', exact: true }).click();
                await page.getByRole('tab', { name: '外観', exact: true }).click();
                await expect(page.getByText('配信と音楽鑑賞の切り替えは、接続のページの「使い道」にあります。')).toBeVisible();
                if (recordShots) await page.screenshot({ path: `${dir}/appearance-ja-1024x768.png`, animations: 'disabled' });
            });
        }
    });
});

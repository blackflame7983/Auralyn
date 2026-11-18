import type { Page } from '@playwright/test';
import { expect } from '../tauriFixture';
import '../tauriWindow';
import { setOutputMuted } from '../e2eHooks';
import { waitForStableLayout } from './waitForStableLayout';

export type Locale = 'ja' | 'en';
export type Purpose = 'voice' | 'music';
export type Theme = 'dark' | 'light' | 'gaming';
export type RunState = 'running' | 'stopped';

const splash = (locale: Locale) => locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';

const seed = ({ locale, purpose, theme }: { locale: Locale; purpose: Purpose; theme: Theme }) => {
    localStorage.setItem('vst_host_locale', locale);
    localStorage.setItem('vst_host_theme', theme);
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('vst_host_tutorial_completed', 'true');
    localStorage.setItem('auralyn_vst_panel_open', 'false');
    localStorage.setItem('auralyn_display_purpose', purpose);
    localStorage.setItem('vst_host_setup_goal', purpose === 'music' ? 'listening' : 'obs');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
};

/** 一定のレベルを流し続けて、音が届いている状態にする。 */
export async function streamLevels(page: Page) {
    await page.evaluate(() => {
        const emit = window.__e2eEmit;
        if (!emit) throw new Error('__e2eEmit がありません');
        window.setInterval(() => emit('audio-level', { input: [0.1, 0.1], output: [0.1, 0.1] }), 50);
    });
    await expect(page.locator('body')).toContainText('−20.0 dBFS');
}

/** 保存した構成の名前を返す・使い道を未選択にする、といった開く前の状態の追加。 */
export interface HomeSetup {
    /** list_presets が返す、保存した VST の構成の名前。 */
    presets?: string[];
    /** 使い道（配信・通話の送り先）を未選択にして開く。 */
    destinationUnset?: boolean;
}

const applySetup = ({ presets, destinationUnset }: HomeSetup) => {
    if (destinationUnset) localStorage.removeItem('vst_host_setup_goal');
    const internals = window.__TAURI_INTERNALS__;
    if (!presets || !internals) return;
    const original = internals.invoke;
    internals.invoke = async (command, args) => command === 'list_presets' ? presets : original(command, args);
};

/**
 * 設定済みのホームを開く。呼び出し側で test.use({ liveHome: true, stoppedHome }) を指定する。
 * 実行中の `levels: true` は音が届いている状態、false は何も届いていない状態。
 */
export async function openHome(
    page: Page,
    options: { state: RunState; locale: Locale; purpose: Purpose; theme: Theme; size: { width: number; height: number }; levels?: boolean } & HomeSetup,
) {
    await page.setViewportSize(options.size);
    await page.addInitScript(seed, { locale: options.locale, purpose: options.purpose, theme: options.theme });
    await page.addInitScript(applySetup, { presets: options.presets, destinationUnset: options.destinationUnset });
    await page.goto('/');
    await expect(page.getByText(splash(options.locale), { exact: true })).toHaveCount(0);
    await expect(page.locator('.home-content')).toBeVisible();
    if (options.state === 'running') {
        await setOutputMuted(page, false);
        if (options.levels ?? true) await streamLevels(page);
    }
    await waitForStableLayout(page);
}

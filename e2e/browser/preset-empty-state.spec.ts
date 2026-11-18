import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';
import './tauriWindow';

// 設定の保存・復帰（presets）は、保存済みが0件でも取得に失敗しても、案内や失敗が初期表示に入る（#773）。

test.use({ liveHome: true });

const SIZE = { width: 900, height: 600 };
const SAVED = { name: '既存の設定', hasPlugins: true, hasAudioConfig: false, hasNoiseControl: true, hasBuiltinFx: true };

async function openPresets(page: Page, locale: 'ja' | 'en') {
    const t = (key: MessageKey) => message(locale, key);
    await page.setViewportSize(SIZE);
    await page.addInitScript(locale => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    }, locale);
    await page.goto('/');
    await expect(page.getByText(t('app.initializing'), { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: t('rail.label') }).getByRole('button', { name: t('rail.vst'), exact: true }).click();
    await page.getByRole('button', { name: t('rack.manageProfiles'), exact: true }).click();
    return page.getByRole('dialog');
}

for (const locale of ['ja', 'en'] as const) {
    test(`900×600 の設定の保存・復帰は、保存済みが0件のとき空の案内と保存・インポートの案内が初期表示に入る ${locale}`, async ({ page }) => {
        const t = (key: MessageKey) => message(locale, key);
        const dialog = await openPresets(page, locale);
        const empty = dialog.getByText(t('presets.copy.070'), { exact: true });
        const guide = dialog.getByText(t('presets.copy.072'), { exact: true });
        await expect(empty).toBeInViewport({ ratio: 1 });
        await expect(guide).toBeInViewport({ ratio: 1 });
        await expect(dialog.getByRole('group', { name: t('profilePurpose.apply') })).toHaveCount(0);
        await expect(dialog.getByRole('textbox', { name: t('presets.copy.066') })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: t('presets.copy.065') })).toHaveCount(1);
    });
}

for (const locale of ['ja', 'en'] as const) {
    test(`設定の保存・復帰は、保存の成功後に一覧の再取得に失敗したら範囲と検索を隠し、再読み込みで選んだ範囲が戻る ${locale}`, async ({ page }) => {
        const t = (key: MessageKey) => message(locale, key);
        await page.addInitScript(saved => {
            const internals = window.__TAURI_INTERNALS__;
            if (!internals) throw new Error('__TAURI_INTERNALS__ がありません');
            const original = internals.invoke;
            internals.invoke = async (command, args) => {
                if (command === 'list_profiles') {
                    if (window.__presetListFailure) throw new Error('read failed');
                    return [saved];
                }
                if (command === 'save_profile') { window.__presetListFailure = true; return; }
                return original(command, args);
            };
        }, SAVED);
        const dialog = await openPresets(page, locale);
        const scope = dialog.getByRole('group', { name: t('profilePurpose.apply') });
        await expect(scope).toBeVisible();
        await scope.getByRole('checkbox').uncheck();
        await dialog.getByRole('textbox', { name: t('presets.copy.061') }).fill('新しい設定');
        await dialog.getByRole('button', { name: t('presets.copy.063'), exact: true }).click();
        const alert = dialog.getByRole('alert');
        await expect(alert).toContainText(t('presets.copy.016'));
        await expect(alert.getByRole('button', { name: t('presets.copy.068') })).toBeVisible();
        await expect(dialog.getByRole('group', { name: t('profilePurpose.apply') })).toHaveCount(0);
        await expect(dialog.getByRole('textbox', { name: t('presets.copy.066') })).toHaveCount(0);
        await page.evaluate(() => { window.__presetListFailure = false; });
        await alert.getByRole('button', { name: t('presets.copy.068') }).click();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(dialog.getByRole('textbox', { name: t('presets.copy.066') })).toBeVisible();
        await expect(dialog.getByRole('group', { name: t('profilePurpose.apply') }).getByRole('checkbox')).not.toBeChecked();
    });
}

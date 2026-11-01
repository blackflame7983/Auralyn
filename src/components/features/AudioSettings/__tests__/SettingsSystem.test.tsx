import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        if (command === 'get_autostart_status') return { enabled: false, canChange: true };
        return null;
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['ja', 'en'] as const)('システム操作の対象と確認を区別する (%s)', async locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} onOpenWizard={vi.fn()} /></LocaleProvider>);
    fireEvent.mouseDown(screen.getByRole('tab', { name: locale === 'ja' ? 'システム' : 'System' }), { button: 0, ctrlKey: false });
    const blocklist = locale === 'ja' ? '除外リストをリセット' : 'Reset blocklist';
    const reset = locale === 'ja' ? 'すべて初期化' : 'Reset all';
    expect(screen.getByRole('heading', { name: locale === 'ja' ? 'セットアップ' : 'Setup' })).toBeVisible();
    expect(screen.getByText(locale === 'ja' ? 'マイクと出力先を選び直せます。' : 'Choose your microphone and output again.')).toBeVisible();
    expect(screen.getByRole('button', { name: locale === 'ja' ? '音声処理を再起動' : 'Restart audio processing' })).toBeVisible();
    const resetButton = screen.getByRole('button', { name: reset });
    expect(resetButton).toHaveClass('bg-destructive');
    fireEvent.click(screen.getByRole('button', { name: blocklist }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: locale === 'ja' ? '除外リストをリセットしますか？' : 'Reset the blocklist?' })).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: locale === 'ja' ? 'キャンセル' : 'Cancel' }));
    fireEvent.click(resetButton);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: locale === 'ja' ? 'すべての設定を初期化しますか？' : 'Reset all settings?' })).toBeVisible();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'clear_plugin_blacklist' || command === 'stop_audio')).toBe(false);
});

it.each(['ja', 'en'] as const)('ライトテーマにも説明を表示する (%s)', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} /></LocaleProvider>);
    fireEvent.mouseDown(screen.getByRole('tab', { name: locale === 'ja' ? '外観' : 'Appearance' }), { button: 0, ctrlKey: false });
    expect(screen.getByText(locale === 'ja' ? '明るい背景に、青緑を差し色にします。' : 'A light background with teal accents.')).toBeVisible();
});

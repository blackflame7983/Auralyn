import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        if (command === 'get_engine_tuning_config') return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
        if (command === 'get_autostart_status') return { enabled: false, canChange: true };
        return null;
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['音声処理の最適化', '診断情報', '設定の移行'])('StrictModeでも%sを開閉し、タブ移動後に開閉状態を保持する', async name => {
    render(<StrictMode><AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} /></StrictMode>);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
    const details = screen.getByText(name).closest('details')!;
    fireEvent.click(within(details).getByText(name));
    await waitFor(() => expect(details).toHaveAttribute('open'));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '外観' }), { button: 0, ctrlKey: false });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
    expect(screen.getByText(name).closest('details')).toHaveAttribute('open');
    fireEvent.click(screen.getByText(name));
    await waitFor(() => expect(screen.getByText(name).closest('details')).not.toHaveAttribute('open'));
});

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

it('音づくりとシステムの詳細・未保存値をタブ移動と閉じて再表示した後も保持する', async () => {
    const props = { onClose: vi.fn(), onConfigChange: vi.fn(), initialTab: 'sound' as const };
    const view = render(<AudioSettingsModal {...props} isOpen />);
    fireEvent.click(screen.getByText('ノイズ低減の詳細'));
    await waitFor(() => expect(screen.getByText('ノイズ低減の詳細').closest('details')).toHaveAttribute('open'));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
    const optimization = screen.getByText('音声処理の最適化').closest('details')!;
    fireEvent.click(within(optimization).getByText('音声処理の最適化'));
    await waitFor(() => expect(optimization).toHaveAttribute('open'));
    const mask = screen.getByRole('textbox', { name: 'アフィニティマスク' });
    fireEvent.change(mask, { target: { value: '0x3' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '音づくり' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('ノイズ低減の詳細').closest('details')).toHaveAttribute('open');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('音声処理の最適化').closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('textbox', { name: 'アフィニティマスク' })).toHaveValue('0x3');
    view.rerender(<AudioSettingsModal {...props} isOpen={false} />);
    view.rerender(<AudioSettingsModal {...props} isOpen />);
    expect(screen.getByText('音声処理の最適化').closest('details')).toHaveAttribute('open');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'アフィニティマスク' })).toHaveValue('0x3'));
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIState } from '@/hooks/useUIState';
import { applyPreviewScreen, previewScreenNames, type PreviewScreenControls } from '../previewScreen';
import { applyPreviewStorage, previewStorageKeys } from '../previewMock';

vi.mock('@/hooks/useVstPanel', () => ({ saveVstPanelOpen: vi.fn() }));
vi.mock('@/lib/streamMixPanel', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/streamMixPanel')>(), openStreamMixPanel: vi.fn() }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

afterEach(() => { cleanup(); localStorage.clear(); });

function controls(): PreviewScreenControls {
    return {
        setIsSettingsOpen: vi.fn(),
        openSoundSettings: vi.fn(),
        openObsSettings: vi.fn(),
        openShortcuts: vi.fn(),
        setIsOBSGuideOpen: vi.fn(),
        setIsDiscordGuideOpen: vi.fn(),
        setIsTroubleshootOpen: vi.fn(),
        setIsVoiceCheckOpen: vi.fn(),
        setIsBrowserOpen: vi.fn(),
        setIsPresetManagerOpen: vi.fn(),
        setIsTemplateWizardOpen: vi.fn(),
        setIsLicenseModalOpen: vi.fn(),
    };
}

describe('プレビューの画面指定', () => {
    it('一覧の画面は開ける', () => {
        for (const name of previewScreenNames) {
            expect(applyPreviewScreen(name, controls())).toBe(true);
        }
    });

    it('外観とシステムは開くタブを一度に指定する', () => {
        const ui = controls();
        applyPreviewScreen('settings-appearance', ui);
        expect(ui.setIsSettingsOpen).toHaveBeenCalledWith(true, 'appearance');
        applyPreviewScreen('settings-system', ui);
        expect(ui.setIsSettingsOpen).toHaveBeenCalledWith(true, 'system');
    });

    it.each([['settings-appearance', 'appearance'], ['settings-system', 'system']] as const)(
        '%s は通常の設定を開閉した後も指定タブで開く', (screen, tab) => {
            const { result } = renderHook(useUIState);
            act(() => result.current.setIsSettingsOpen(true));
            act(() => result.current.setIsSettingsOpen(false));
            act(() => { applyPreviewScreen(screen, result.current); });
            expect(result.current.isSettingsOpen).toBe(true);
            expect(result.current.settingsTab).toBe(tab);
            expect(result.current.settingsSection).toBeUndefined();
            act(() => result.current.setIsSettingsOpen(false));
            act(() => result.current.setIsSettingsOpen(true));
            expect(result.current.settingsTab).toBe('audio');
        },
    );

    it('未知の名前は開かない', () => {
        expect(applyPreviewScreen('missing', controls())).toBe(false);
    });

    it.each([['settings-appearance', '外観'], ['settings-system', 'システム']] as const)(
        '%s を開いた実際の設定画面でも移動先を保持する', async (requested, label) => {
            const { AudioSettingsModal } = await import('@/components/features/AudioSettings/AudioSettingsModal');
            vi.mocked(invoke).mockImplementation(async command => {
                if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
                if (command === 'get_engine_runtime_stats') return {};
                if (command === 'get_autostart_status') return { enabled: false, canChange: true };
                return null;
            });
            function PreviewSettings() {
                const ui = useUIState();
                useEffect(() => { applyPreviewScreen(requested, ui); }, []);
                return ui.isSettingsOpen ? createElement(AudioSettingsModal, {
                    isOpen: true, initialTab: ui.settingsTab, tabRequest: ui.settingsTabRequest,
                    onClose: () => ui.setIsSettingsOpen(false), onConfigChange: vi.fn(),
                }) : null;
            }
            render(createElement(PreviewSettings));
            expect(await screen.findByRole('tab', { name: label, selected: true })).toBeVisible();
            expect(screen.getByRole('tab', { name: 'オーディオ' })).toHaveAttribute('aria-selected', 'false');
        },
    );
});

describe('プレビューの保存値', () => {
    afterEach(() => localStorage.clear());

    it('前の状態が書いた保存値を消してから、今の状態だけ書く', () => {
        for (const key of previewStorageKeys) localStorage.setItem(key, 'stale');
        applyPreviewStorage({ vst_host_setup_goal: 'obs' });
        expect(localStorage.getItem('vst_host_wizard_done')).toBeNull();
        expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    });
});

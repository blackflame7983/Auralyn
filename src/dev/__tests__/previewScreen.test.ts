import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIState } from '@/hooks/useUIState';
import { applyPreviewScreen, previewScreenNames, type PreviewScreenControls } from '../previewScreen';
import { applyPreviewPurpose, applyPreviewStorage, previewStateFor, previewStorageKeys } from '../previewMock';
import { realisticAudioConfig } from '../tauriMock';

vi.mock('@/lib/streamMixPanel', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/streamMixPanel')>(), openStreamMixPanel: vi.fn() }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

type SettingsModal = typeof import('@/components/features/AudioSettings/AudioSettingsModal')['AudioSettingsModal'];
let AudioSettingsModal: SettingsModal;
// 設定画面は大きいため、読み込みを各試験の待ち時間に混ぜず、先に済ませる。
beforeAll(async () => {
    ({ AudioSettingsModal } = await import('@/components/features/AudioSettings/AudioSettingsModal'));
}, 60_000);

afterEach(async () => { cleanup(); await act(async () => {}); localStorage.clear(); });

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
        openVst: vi.fn(),
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
            vi.mocked(invoke).mockImplementation(async command => {
                if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
                if (command === 'get_engine_runtime_stats') return {};
                if (command === 'get_autostart_status') return { enabled: false, canChange: true };
                return null;
            });
            function PreviewSettings() {
                const ui = useUIState();
                const applied = useRef(false);
                useEffect(() => {
                    if (applied.current) return;
                    applied.current = true;
                    applyPreviewScreen(requested, ui);
                }, [ui]);
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

    it('クエリが無い live-home は、登録済みと従来の機器名のまま', () => {
        const state = previewStateFor('live-home', new URLSearchParams());
        expect(state?.mock).toMatchObject({ liveHome: true, stoppedHome: false, registeredModes: true, builtinEnabled: false, devices: 'legacy' });
        expect(state?.storage.vst_host_audio_config).toContain('"input":"CABLE Output"');
        expect(state?.storage.vst_host_audio_config).toContain('"output":"スピーカー"');
    });

    it('realistic と registered=0 は未登録の配信構成にし、既定の preset は汚さない', () => {
        const changed = previewStateFor('live-home', new URLSearchParams('devices=realistic&registered=0&purpose=voice'));
        expect(changed?.mock.registeredModes).toBe(false);
        expect(changed?.mock.devices).toBe('realistic');
        expect(changed?.storage.vst_host_audio_config).toBe(realisticAudioConfig('voice'));
        const again = previewStateFor('live-home', new URLSearchParams());
        expect(again?.mock.registeredModes).toBe(true);
        expect(again?.storage.vst_host_audio_config).toContain('"output":"スピーカー"');
    });

    it('音楽鑑賞の realistic は CABLE Output から USB Headphones にする', () => {
        const state = previewStateFor('stopped-home', new URLSearchParams('devices=realistic&purpose=music'));
        expect(state?.mock).toMatchObject({ stoppedHome: true, registeredModes: true, devices: 'realistic' });
        expect(state?.storage.vst_host_audio_config).toBe(realisticAudioConfig('music'));
    });

    it('first-run は機器設定を足さない', () => {
        expect(previewStateFor('first-run', new URLSearchParams())?.mock.registeredModes).toBe(false);
        const state = previewStateFor('first-run', new URLSearchParams('devices=realistic&registered=1'));
        expect(state?.storage).toEqual({});
        expect(state?.mock).toMatchObject({ liveHome: false, registeredModes: true, devices: 'realistic' });
        expect(previewStateFor('missing', new URLSearchParams())).toBeNull();
    });

    it('purpose=voice は表示用途を消し、省いたときは残す', () => {
        localStorage.setItem('auralyn_display_purpose', 'music');
        applyPreviewPurpose(null);
        expect(localStorage.getItem('auralyn_display_purpose')).toBe('music');
        applyPreviewPurpose('voice');
        expect(localStorage.getItem('auralyn_display_purpose')).toBeNull();
        applyPreviewPurpose('music');
        expect(localStorage.getItem('auralyn_display_purpose')).toBe('music');
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPreviewScreen, previewScreenNames, type PreviewScreenControls } from '../previewScreen';
import { applyPreviewStorage, previewStorageKeys } from '../previewMock';

vi.mock('@/hooks/useVstPanel', () => ({ saveVstPanelOpen: vi.fn() }));
vi.mock('@/lib/streamMixPanel', () => ({ openStreamMixPanel: vi.fn() }));

function controls(): PreviewScreenControls {
    return {
        setIsSettingsOpen: vi.fn(),
        setSettingsTab: vi.fn(),
        openSoundSettings: vi.fn(),
        openObsSettings: vi.fn(),
        openShortcuts: vi.fn(),
        setIsOBSGuideOpen: vi.fn(),
        setIsDiscordGuideOpen: vi.fn(),
        setIsTroubleshootOpen: vi.fn(),
        setIsVoiceCheckOpen: vi.fn(),
        setIsLargeMeterOpen: vi.fn(),
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

    it('外観とシステムは設定を開いてからそのタブへ移す', () => {
        const ui = controls();
        applyPreviewScreen('settings-appearance', ui);
        expect(ui.setIsSettingsOpen).toHaveBeenCalledWith(true);
        expect(ui.setSettingsTab).toHaveBeenCalledWith('appearance');
        applyPreviewScreen('settings-system', ui);
        expect(ui.setSettingsTab).toHaveBeenCalledWith('system');
    });

    it('未知の名前は開かない', () => {
        expect(applyPreviewScreen('missing', controls())).toBe(false);
    });
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

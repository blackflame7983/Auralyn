import { openStreamMixPanel } from '@/lib/streamMixPanel';
import { useCallback, useState } from 'react';
import type { AudioEngineExit } from '@/lib/audioEngineExit';
import { consumeLeaveSkip, requestLeave } from '@/components/layout/pageLeave';

export type AppPage = 'home' | 'sound' | 'connect' | 'settings';
export type SettingsPane = 'appearance' | 'shortcuts' | 'obs' | 'system';
export type SettingsTab = 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system';
export type SettingsAnchor = 'liveModes' | 'singing' | 'audioTuning' | 'liveOutput' | 'primaryInput';

type Navigation = { page: AppPage; pane?: SettingsPane; section?: SettingsAnchor; retry?: boolean };

const settingsPanes: SettingsPane[] = ['appearance', 'shortcuts', 'obs', 'system'];

function pageOf(tab: SettingsTab): AppPage {
    if (tab === 'audio') return 'connect';
    if (tab === 'sound') return 'sound';
    return 'settings';
}

function paneOf(tab: SettingsTab): SettingsPane {
    return settingsPanes.includes(tab as SettingsPane) ? tab as SettingsPane : 'appearance';
}

export const useUIState = () => {
    const [page, setPage] = useState<AppPage>('home');
    const [settingsPane, setSettingsPane] = useState<SettingsPane>('appearance');
    // 同じ場所への移動を続けて頼まれても切り替わるよう、頼むたびに番号を進める。
    const [settingsTabRequest, setSettingsTabRequest] = useState(0);
    const [settingsSection, setSettingsSection] = useState<SettingsAnchor>();
    const [settingsNeedsRetry, setSettingsNeedsRetry] = useState(false);
    // ホームと接続は、以前の音声タブと同じ入口として扱う。
    const settingsTab: SettingsTab = page === 'sound' ? 'sound' : page === 'settings' ? settingsPane : 'audio';
    const isSettingsOpen = page !== 'home';

    const commit = useCallback((next: Navigation) => {
        if (next.pane) setSettingsPane(next.pane);
        setSettingsSection(next.section);
        setSettingsNeedsRetry(next.retry ?? false);
        setSettingsTabRequest(n => n + 1);
        setPage(next.page);
    }, []);

    const samePlace = (next: Navigation) => page === next.page && (next.page !== 'settings' || !next.pane || next.pane === settingsPane);

    const go = (next: Navigation) => {
        // システムの再起動は、接続ページの未保存の変更を適用する。ここで捨てると、再起動の条件が変わる（6.3）。
        const restartKeepsConnection = page === 'connect' && next.page === 'settings' && next.pane === 'system';
        // 保存成功の一度だけは、同じ場所でも処理中の停止を消費する。
        if (restartKeepsConnection || consumeLeaveSkip() || samePlace(next)) { commit(next); return; }
        requestLeave(() => commit(next));
    };

    const applyNavigation = commit;
    const leave = useCallback((action: () => void) => requestLeave(action), []);

    // 開く画面と区分を一度に指定し、既定の場所への初期化で移動先を失わないようにする。
    const setIsSettingsOpen = (open: boolean, tab: SettingsTab = 'audio') => {
        if (!open) { go({ page: 'home' }); return; }
        const destination = pageOf(tab);
        go({ page: destination, pane: destination === 'settings' ? paneOf(tab) : undefined });
    };
    const openShortcuts = () => go({ page: 'settings', pane: 'shortcuts' });
    const openObsSettings = () => go({ page: 'settings', pane: 'obs' });
    const openAudioTuning = () => go({ page: 'connect', section: 'audioTuning' });
    // 配信ミックスは設定ではなくホームのパネルで扱う（#299）。
    const openMixingSettings = () => openStreamMixPanel();
    // 配信ミックスのパネルから、出力先・入力元の区画を開いて案内する。
    const openDeviceSettings = (target: 'output' | 'input') => go({ page: 'connect', section: target === 'output' ? 'liveOutput' : 'primaryInput' });
    const openSoundSettings = (section?: 'liveModes' | 'singing') => {
        // イベントハンドラーとして渡された場合も、選択イベントを移動先へ持ち込まない。
        const anchor = section === 'liveModes' || section === 'singing' ? section : undefined;
        go({ page: 'sound', section: anchor });
    };
    const openLiveModeSettings = () => go({ page: 'sound', section: 'liveModes' });
    const openAudioSettingsRetry = () => go({ page: 'connect', retry: true });
    const [isBrowserOpen, setIsBrowserOpen] = useState(false);
    const [isOBSGuideOpen, setIsOBSGuideOpen] = useState(false);
    const [isDiscordGuideOpen, setIsDiscordGuideOpen] = useState(false);
    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [isTemplateWizardOpen, setIsTemplateWizardOpen] = useState(false);
    const [isLicenseModalOpen, setIsLicenseModalOpen] = useState(false);
    const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
    const [crashError, setCrashError] = useState<string | null>(null);
    const [crashExit, setCrashExit] = useState<AudioEngineExit>();
    const [isPresetManagerOpen, setIsPresetManagerOpen] = useState(false);
    const [isTroubleshootOpen, setIsTroubleshootOpen] = useState(false);
    const [isVoiceCheckOpen, setIsVoiceCheckOpen] = useState(false);

    return {
        page,
        settingsPane,
        isSettingsOpen,
        setIsSettingsOpen,
        settingsTab,
        settingsTabRequest,
        settingsSection,
        settingsNeedsRetry,
        openAudioSettingsRetry,
        openLiveModeSettings,
        openObsSettings,
        openShortcuts,
        openAudioTuning,
        openMixingSettings,
        openDeviceSettings,
        openSoundSettings,
        leave,
        applyNavigation,
        isBrowserOpen,
        setIsBrowserOpen,
        isOBSGuideOpen,
        setIsOBSGuideOpen,
        isDiscordGuideOpen,
        setIsDiscordGuideOpen,
        isWizardOpen,
        setIsWizardOpen,
        isTemplateWizardOpen,
        setIsTemplateWizardOpen,
        isRecoveryModalOpen,
        setIsRecoveryModalOpen,
        crashError,
        setCrashError,
        crashExit,
        setCrashExit,
        isPresetManagerOpen,
        setIsPresetManagerOpen,
        isLicenseModalOpen,
        setIsLicenseModalOpen,
        isTroubleshootOpen,
        setIsTroubleshootOpen,
        isVoiceCheckOpen,
        setIsVoiceCheckOpen,
    };
};

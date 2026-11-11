import { openStreamMixPanel } from '@/lib/streamMixPanel';
import { useState } from 'react';
import type { AudioEngineExit } from '@/lib/audioEngineExit';

export const useUIState = () => {
    const [isSettingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setStoredSettingsTab] = useState<'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system'>('audio');
    // 同じタブへの移動を続けて頼まれても切り替わるよう、頼むたびに番号を進める。
    const [settingsTabRequest, setSettingsTabRequest] = useState(0);
    const setSettingsTab = (tab: 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system') => { setStoredSettingsTab(tab); setSettingsTabRequest(n => n + 1); };
    const [settingsSection, setSettingsSection] = useState<'liveModes' | 'singing' | 'audioTuning' | 'liveOutput' | 'primaryInput'>();
    const [settingsNeedsRetry, setSettingsNeedsRetry] = useState(false);
    // 開く画面とタブを一度に指定し、既定タブへの初期化で移動先を失わないようにする。
    const setIsSettingsOpen = (open: boolean, tab: typeof settingsTab = 'audio') => {
        setSettingsNeedsRetry(false);
        setSettingsSection(undefined);
        setSettingsTab(tab);
        setSettingsOpen(open);
    };
    const openShortcuts = () => {
        setSettingsNeedsRetry(false);
        setSettingsSection(undefined);
        setSettingsTab('shortcuts');
        setSettingsOpen(true);
    };
    const openObsSettings = () => {
        setSettingsNeedsRetry(false);
        setSettingsSection(undefined);
        setSettingsTab('obs');
        setSettingsOpen(true);
    };
    const openAudioTuning = () => {
        setSettingsNeedsRetry(false);
        setSettingsSection('audioTuning');
        setSettingsTab('audio');
        setSettingsOpen(true);
    };
    // 配信ミックスは設定ではなくホームのパネルで扱う（#299）。
    const openMixingSettings = () => openStreamMixPanel();
    // 配信ミックスのパネルから、出力先・入力元の区画を開いて案内する。
    const openDeviceSettings = (target: 'output' | 'input') => {
        setSettingsNeedsRetry(false);
        setSettingsSection(target === 'output' ? 'liveOutput' : 'primaryInput');
        setSettingsTab('audio');
        setSettingsOpen(true);
    };
    const openSoundSettings = (section?: 'liveModes' | 'singing') => {
        setSettingsNeedsRetry(false);
        // イベントハンドラーとして渡された場合も、選択イベントを移動先へ持ち込まない。
        setSettingsSection(section === 'liveModes' || section === 'singing' ? section : undefined);
        setSettingsTab('sound');
        setSettingsOpen(true);
    };
    const openLiveModeSettings = () => {
        setSettingsNeedsRetry(false);
        setSettingsTab('sound');
        setSettingsSection('liveModes');
        setSettingsOpen(true);
    };
    const openAudioSettingsRetry = () => {
        setSettingsSection(undefined);
        setSettingsTab('audio');
        setSettingsNeedsRetry(true);
        setSettingsOpen(true);
    };
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
    const [isLargeMeterOpen, setIsLargeMeterOpen] = useState(false);
    const [isTroubleshootOpen, setIsTroubleshootOpen] = useState(false);
    const [isVoiceCheckOpen, setIsVoiceCheckOpen] = useState(false);

    return {
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
        isLargeMeterOpen,
        setIsLargeMeterOpen,
        isLicenseModalOpen,
        setIsLicenseModalOpen,
        isTroubleshootOpen,
        setIsTroubleshootOpen,
        isVoiceCheckOpen,
        setIsVoiceCheckOpen,
    };
};

import { useState } from 'react';

export const useUIState = () => {
    const [isSettingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState<'audio' | 'obs' | 'sound'>('audio');
    const [settingsSection, setSettingsSection] = useState<'liveModes' | 'singing' | 'audioTuning'>();
    const [settingsNeedsRetry, setSettingsNeedsRetry] = useState(false);
    const setIsSettingsOpen = (open: boolean) => {
        setSettingsNeedsRetry(false);
        setSettingsSection(undefined);
        setSettingsTab('audio');
        setSettingsOpen(open);
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
    const [isPresetManagerOpen, setIsPresetManagerOpen] = useState(false);
    const [isLargeMeterOpen, setIsLargeMeterOpen] = useState(false);
    const [isTroubleshootOpen, setIsTroubleshootOpen] = useState(false);
    const [isVoiceCheckOpen, setIsVoiceCheckOpen] = useState(false);

    return {
        isSettingsOpen,
        setIsSettingsOpen,
        settingsTab,
        settingsSection,
        settingsNeedsRetry,
        openAudioSettingsRetry,
        openLiveModeSettings,
        openObsSettings,
        openAudioTuning,
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

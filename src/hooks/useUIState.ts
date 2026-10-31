import { useState } from 'react';

export const useUIState = () => {
    const [isSettingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState<'audio' | 'obs' | 'sound'>('audio');
    const [settingsSection, setSettingsSection] = useState<'liveModes'>();
    const setIsSettingsOpen = (open: boolean) => {
        setSettingsSection(undefined);
        setSettingsTab('audio');
        setSettingsOpen(open);
    };
    const openObsSettings = () => {
        setSettingsSection(undefined);
        setSettingsTab('obs');
        setSettingsOpen(true);
    };
    const openSoundSettings = () => {
        setSettingsSection(undefined);
        setSettingsTab('sound');
        setSettingsOpen(true);
    };
    const openLiveModeSettings = () => {
        setSettingsTab('sound');
        setSettingsSection('liveModes');
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
        openLiveModeSettings,
        openObsSettings,
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

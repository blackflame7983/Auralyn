import { useState } from 'react';

export const useUIState = () => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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

    return {
        isSettingsOpen, setIsSettingsOpen,
        isBrowserOpen, setIsBrowserOpen,
        isOBSGuideOpen, setIsOBSGuideOpen,
        isDiscordGuideOpen, setIsDiscordGuideOpen,
        isWizardOpen, setIsWizardOpen,
        isTemplateWizardOpen, setIsTemplateWizardOpen,
        isRecoveryModalOpen, setIsRecoveryModalOpen,
        crashError, setCrashError,
        isPresetManagerOpen, setIsPresetManagerOpen,
        isLargeMeterOpen, setIsLargeMeterOpen,
        isLicenseModalOpen, setIsLicenseModalOpen
    };
};

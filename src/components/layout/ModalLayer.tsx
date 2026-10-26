import { useSingingDraft } from '../../hooks/useSingingDraft';
import type { LiveModesModel } from '../../hooks/useLiveModes';
import { Suspense, lazy, useEffect, useState } from 'react';
import { useObsUsage } from '../../hooks/useObsUsage';
import { VstPlugin } from '../../api/audio';
import { audioApi } from '../../api/audio';
import type { Plugin } from '../features/PluginRack/PluginCard';

// Lazy load modals
const AudioSettingsModal = lazy(() => import('../features/AudioSettings/AudioSettingsModal').then(m => ({ default: m.AudioSettingsModal })));
const PluginBrowserModal = lazy(() => import('../features/PluginBrowser/PluginBrowserModal').then(m => ({ default: m.PluginBrowserModal })));
const OBSGuideModal = lazy(() => import('../features/Guide/OBSGuideModal').then(m => ({ default: m.OBSGuideModal })));
const DiscordGuideModal = lazy(() => import('../features/Guide/DiscordGuideModal').then(m => ({ default: m.DiscordGuideModal })));
const LicenseModal = lazy(() => import('../features/Settings/LicenseModal').then(m => ({ default: m.LicenseModal })));
const SetupWizardModal = lazy(() => import('../features/SetupWizard/SetupWizardModal').then(m => ({ default: m.SetupWizardModal })));
const PresetManagerModal = lazy(() => import('../features/Presets/PresetManagerModal').then(m => ({ default: m.PresetManagerModal })));
const TemplateWizardModal = lazy(() => import('../features/Templates/TemplateWizardModal').then(m => ({ default: m.TemplateWizardModal })));
const RecoveryModal = lazy(() => import('../features/Recovery/RecoveryModal').then(m => ({ default: m.RecoveryModal })));
const LargeLevelMeter = lazy(() => import('../features/LevelMeter/LargeLevelMeter').then(m => ({ default: m.LargeLevelMeter })));
const TroubleshootModal = lazy(() => import('../features/Troubleshoot/TroubleshootModal').then(m => ({ default: m.TroubleshootModal })));
const VoiceCheckModal = lazy(() => import('../features/VoiceCheck/VoiceCheckModal').then(m => ({ default: m.VoiceCheckModal })));

// 同一ウィンドウではstorageイベントが発生しないため、保存後に開始条件の再確認を通知する。
const markWizardDone = () => {
    localStorage.setItem('vst_host_wizard_done', 'true');
    window.dispatchEvent(new Event('vst_host_tutorial_start'));
};

interface UIState {
    settingsTab?: 'audio' | 'obs' | 'sound';
    isSettingsOpen: boolean;
    setIsSettingsOpen: (v: boolean) => void;
    openSoundSettings: () => void;
    openObsSettings: () => void;
    isBrowserOpen: boolean;
    setIsBrowserOpen: (v: boolean) => void;
    isOBSGuideOpen: boolean;
    setIsOBSGuideOpen: (v: boolean) => void;
    isDiscordGuideOpen: boolean;
    setIsDiscordGuideOpen: (v: boolean) => void;
    isWizardOpen: boolean;
    setIsWizardOpen: (v: boolean) => void;
    isTemplateWizardOpen: boolean;
    setIsTemplateWizardOpen: (v: boolean) => void;
    isLicenseModalOpen: boolean;
    setIsLicenseModalOpen: (v: boolean) => void;
    isRecoveryModalOpen: boolean;
    setIsRecoveryModalOpen: (v: boolean) => void;
    crashError: string | null;
    isPresetManagerOpen: boolean;
    setIsPresetManagerOpen: (v: boolean) => void;
    isLargeMeterOpen: boolean;
    setIsLargeMeterOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
    isTroubleshootOpen: boolean;
    setIsTroubleshootOpen: (v: boolean) => void;
    isVoiceCheckOpen: boolean;
    setIsVoiceCheckOpen: (v: boolean) => void;
}

interface AudioConfig {
    host: string;
    input?: string;
    output?: string;
    sampleRate?: number;
    bufferSize?: number;
    inputChannels?: [number, number];
}

interface PluginsApi {
    plugins: Plugin[];
    availablePlugins: VstPlugin[];
    isScanning: boolean;
    error: string | null;
    scanPlugins: () => Promise<void>;
    addPlugin: (vstPlugin: VstPlugin) => Promise<boolean>;
    loadPreset: (name: string) => Promise<boolean>;
    savePreset: (name: string) => Promise<boolean>;
    saveProfile: (name: string, categories: import('../../api/presets').ProfileSaveCategories) => Promise<boolean>;
    applyProfile: (name: string, substitutions?: { inputDevice?: string; outputDevice?: string }) => Promise<import('../../api/presets').ApplyProfileSummary | null>;
    restoreBackupProfile: () => Promise<import('../../api/presets').ApplyProfileSummary | null>;
    runBundle?: (request: import('../../api/bundles').BundleOperation) => Promise<import('../../api/bundles').BundleResult | null>;
    applyTemplate: (mapping: Record<string, VstPlugin>) => Promise<void | boolean>;
    resetPlugins: () => void;
    recoverSession: (excludePath?: string | null, start?: () => Promise<unknown>) => Promise<void>;
    keepSessionStopped: () => Promise<void>;
    resumeWithoutPlugins: (start: () => Promise<unknown>) => Promise<void>;
    restoreSession: () => Promise<void>;
}

interface ModalLayerProps {
    isAudioRunning?: boolean;
    liveModel?: LiveModesModel;
    ui: UIState;
    audioConfig: AudioConfig;
    handleConfigUpdate: (config: Partial<AudioConfig> & { host: string }, options?: { audioStarted: true }) => void | Promise<void>;
    pluginsApi: PluginsApi;
    onPluginAdded: () => void;
}

export function ModalLayer({ ui, audioConfig, handleConfigUpdate, pluginsApi, onPluginAdded, liveModel, isAudioRunning = false }: ModalLayerProps) {
    const singingModel = useSingingDraft();
    const [singingPreview, setSingingPreview] = useState(false);
    const [returnToTiming, setReturnToTiming] = useState(false);
    const [returnToBundle, setReturnToBundle] = useState(false);
    // lazy画面の読込中も、明示的なガイド↔接続設定の往復だけ接続寿命を引き継ぐ。
    useObsUsage(ui.isOBSGuideOpen || (returnToTiming && ui.isSettingsOpen) || ui.isPresetManagerOpen || (returnToBundle && ui.isSettingsOpen));
    useEffect(() => { if (!ui.isSettingsOpen && !ui.isPresetManagerOpen) setReturnToBundle(false); }, [ui.isSettingsOpen, ui.isPresetManagerOpen]);
    useEffect(() => {
        if (!ui.isOBSGuideOpen && !ui.isSettingsOpen) setReturnToTiming(false);
    }, [ui.isOBSGuideOpen, ui.isSettingsOpen]);
    const handleEngineRestart = async () => {
        pluginsApi.resetPlugins();
        await pluginsApi.restoreSession();
    };

    const handlePluginSelect = async (vstPlugin: VstPlugin) => {
        const success = await pluginsApi.addPlugin(vstPlugin);
        if (success) {
            ui.setIsBrowserOpen(false);
            onPluginAdded();
        }
    };

    return (
        <>
            {ui.isSettingsOpen && (
                <Suspense fallback={null}>
                    <AudioSettingsModal
                        liveModel={liveModel}
                        singingModel={singingModel}
                        onPreviewSinging={() => { setSingingPreview(true); ui.setIsSettingsOpen(false); ui.setIsVoiceCheckOpen(true); }}
                        onSaveSingingProfile={() => { ui.setIsSettingsOpen(false); ui.setIsPresetManagerOpen(true); }}
                        initialTab={ui.settingsTab ?? 'audio'}
                        isOpen={ui.isSettingsOpen}
                        onClose={() => {
                            ui.setIsSettingsOpen(false);
                            if (returnToTiming) ui.setIsOBSGuideOpen(true);
                            if (returnToBundle) ui.setIsPresetManagerOpen(true);
                        }}
                        onConfigChange={handleConfigUpdate}
                        onEngineRestarted={handleEngineRestart}
                        onOpenWizard={() => ui.setIsWizardOpen(true)}
                        onOpenOBSGuide={() => {
                            ui.setIsSettingsOpen(false);
                            ui.setIsOBSGuideOpen(true);
                        }}
                        onOpenTroubleshoot={() => {
                            ui.setIsSettingsOpen(false);
                            ui.setIsTroubleshootOpen(true);
                        }}
                        onOpenVoiceCheck={() => {
                            ui.setIsSettingsOpen(false);
                            ui.setIsVoiceCheckOpen(true);
                        }}
                        onOpenLicense={() => ui.setIsLicenseModalOpen(true)}
                        currentSampleRate={audioConfig.sampleRate}
                        currentBufferSize={audioConfig.bufferSize}
                        currentInputChannels={audioConfig.inputChannels}
                    />
                </Suspense>
            )}
            {ui.isBrowserOpen && (
                <Suspense fallback={null}>
                    <PluginBrowserModal
                        isOpen={ui.isBrowserOpen}
                        onClose={() => ui.setIsBrowserOpen(false)}
                        onPluginSelect={handlePluginSelect}
                        plugins={pluginsApi.availablePlugins}
                        isLoading={pluginsApi.isScanning}
                        error={pluginsApi.error}
                        onScan={pluginsApi.scanPlugins}
                    />
                </Suspense>
            )}
            {ui.isOBSGuideOpen && (
                <Suspense fallback={null}>
                    <OBSGuideModal
                        isOpen={ui.isOBSGuideOpen}
                        initialTimingOpen={returnToTiming}
                        onClose={() => { setReturnToTiming(false); ui.setIsOBSGuideOpen(false); }}
                        onOpenObsSettings={() => {
                            setReturnToTiming(true);
                            ui.setIsOBSGuideOpen(false);
                            ui.openObsSettings();
                        }}
                        onOpenAudioSettings={() => {
                            ui.setIsOBSGuideOpen(false);
                            ui.setIsSettingsOpen(true);
                        }}
                        onOpenTroubleshoot={() => {
                            ui.setIsOBSGuideOpen(false);
                            ui.setIsTroubleshootOpen(true);
                        }}
                        onOpenVoiceCheck={() => {
                            ui.setIsOBSGuideOpen(false);
                            ui.setIsVoiceCheckOpen(true);
                        }}
                    />
                </Suspense>
            )}
            {ui.isDiscordGuideOpen && (
                <Suspense fallback={null}>
                    <DiscordGuideModal
                        isOpen={ui.isDiscordGuideOpen}
                        onClose={() => ui.setIsDiscordGuideOpen(false)}
                        onOpenAudioSettings={() => {
                            ui.setIsDiscordGuideOpen(false);
                            ui.setIsSettingsOpen(true);
                        }}
                        onOpenTroubleshoot={() => {
                            ui.setIsDiscordGuideOpen(false);
                            ui.setIsTroubleshootOpen(true);
                        }}
                        onOpenVoiceCheck={() => {
                            ui.setIsDiscordGuideOpen(false);
                            ui.setIsVoiceCheckOpen(true);
                        }}
                    />
                </Suspense>
            )}
            {ui.isLicenseModalOpen && (
                <Suspense fallback={null}>
                    <LicenseModal
                        isOpen={ui.isLicenseModalOpen}
                        onClose={() => ui.setIsLicenseModalOpen(false)}
                    />
                </Suspense>
            )}
            {ui.isWizardOpen && (
                <Suspense fallback={null}>
                    <SetupWizardModal
                        isOpen={ui.isWizardOpen}
                        onClose={() => {
                            ui.setIsWizardOpen(false);
                        }}
                        onSkip={() => {
                            ui.setIsWizardOpen(false);
                            markWizardDone();
                        }}
                        onApplyConfig={(host, input, output, actualConfig) => {
                            // 起動時の自動調整を含む実値を画面と保存設定へ反映する。
                            const config = { host, input, output, sampleRate: actualConfig.sample_rate, bufferSize: actualConfig.buffer_size };
                            handleConfigUpdate(config);
                            localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
                            markWizardDone();
                        }}
                        onOpenSettings={() => {
                            ui.setIsWizardOpen(false);
                            ui.setIsSettingsOpen(true);
                        }}
                        onOpenTroubleshoot={() => {
                            ui.setIsWizardOpen(false);
                            ui.setIsTroubleshootOpen(true);
                        }}
                    />
                </Suspense>
            )}
            {ui.isPresetManagerOpen && (
                <Suspense fallback={null}>
                    <PresetManagerModal
                        isOpen={ui.isPresetManagerOpen}
                        onClose={() => { setReturnToBundle(false); ui.setIsPresetManagerOpen(false); }}
                        onLoadPreset={pluginsApi.loadPreset}
                        onSaveProfile={pluginsApi.saveProfile}
                        onApplyProfile={pluginsApi.applyProfile}
                        onRestoreBackup={pluginsApi.restoreBackupProfile}
                        onBundleOperation={pluginsApi.runBundle}
                        initialBundleOpen={returnToBundle}
                        onObsSettings={() => { setReturnToTiming(false); setReturnToBundle(true); ui.setIsPresetManagerOpen(false); ui.openObsSettings(); }}
                        onOpenTemplateWizard={() => {
                            ui.setIsPresetManagerOpen(false);
                            ui.setIsTemplateWizardOpen(true);
                        }}
                    />
                </Suspense>
            )}
            {ui.isTemplateWizardOpen && (
                <Suspense fallback={null}>
                    <TemplateWizardModal
                        isOpen={ui.isTemplateWizardOpen}
                        onClose={() => ui.setIsTemplateWizardOpen(false)}
                        availablePlugins={pluginsApi.availablePlugins}
                        onApplyTemplate={pluginsApi.applyTemplate}
                        onScan={pluginsApi.scanPlugins}
                        isScanning={pluginsApi.isScanning}
                        onOpenSoundSettings={() => {
                            ui.setIsTemplateWizardOpen(false);
                            ui.openSoundSettings();
                        }}
                    />
                </Suspense>
            )}
            {ui.isRecoveryModalOpen && (
                <Suspense fallback={null}>
                    <RecoveryModal
                        isOpen={ui.isRecoveryModalOpen}
                        onClose={() => ui.setIsRecoveryModalOpen(false)}
                        error={ui.crashError}
                        onKeepStopped={pluginsApi.keepSessionStopped}
                        onWithoutPlugins={() => pluginsApi.resumeWithoutPlugins(() => audioApi.start(audioConfig.host, audioConfig.input, audioConfig.output, audioConfig.bufferSize || 512, audioConfig.sampleRate || 48000))}
                        onRecover={async (_safeMode, excludePath) => {
                            await pluginsApi.recoverSession(excludePath, () => audioApi.start(audioConfig.host, audioConfig.input, audioConfig.output, audioConfig.bufferSize || 512, audioConfig.sampleRate || 48000));
                        }}
                    />
                </Suspense>
            )}
            {ui.isLargeMeterOpen && (
                <Suspense fallback={null}>
                    <LargeLevelMeter running={isAudioRunning} onClose={() => ui.setIsLargeMeterOpen(false)} />
                </Suspense>
            )}
            {ui.isTroubleshootOpen && (
                <Suspense fallback={null}>
                    <TroubleshootModal
                        isOpen={ui.isTroubleshootOpen}
                        onClose={() => ui.setIsTroubleshootOpen(false)}
                        onOpenSettings={() => {
                            ui.setIsTroubleshootOpen(false);
                            ui.setIsSettingsOpen(true);
                        }}
                        onOpenOBSGuide={() => {
                            ui.setIsTroubleshootOpen(false);
                            ui.setIsOBSGuideOpen(true);
                        }}
                        onOpenDiscordGuide={() => {
                            ui.setIsTroubleshootOpen(false);
                            ui.setIsDiscordGuideOpen(true);
                        }}
                    />
                </Suspense>
            )}
            {ui.isVoiceCheckOpen && (
                <Suspense fallback={null}>
                    <VoiceCheckModal
                        isOpen={ui.isVoiceCheckOpen}
                        singingModel={singingModel}
                        manualCandidate={singingPreview}
                        onSaveSingingProfile={() => { setSingingPreview(false); ui.setIsVoiceCheckOpen(false); ui.setIsPresetManagerOpen(true); }}
                        onClose={() => { ui.setIsVoiceCheckOpen(false); if (singingPreview) { setSingingPreview(false); ui.openSoundSettings(); } }}
                        onOpenSoundSettings={() => {
                            setSingingPreview(false);
                            ui.setIsVoiceCheckOpen(false);
                            ui.openSoundSettings();
                        }}
                        onOpenAudioSettings={() => {
                            setSingingPreview(false);
                            ui.setIsVoiceCheckOpen(false);
                            ui.setIsSettingsOpen(true);
                        }}
                    />
                </Suspense>
            )}
        </>
    );
}

import { Suspense, lazy } from 'react';
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

interface UIState {
    isSettingsOpen: boolean;
    setIsSettingsOpen: (v: boolean) => void;
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
    applyTemplate: (mapping: Record<string, VstPlugin>) => Promise<void | boolean>;
    resetPlugins: () => void;
    recoverSession: (excludePath?: string | null) => Promise<void>;
    restoreSession: () => Promise<void>;
}

interface ModalLayerProps {
    ui: UIState;
    audioConfig: AudioConfig;
    handleConfigUpdate: (config: Partial<AudioConfig> & { host: string }) => void;
    pluginsApi: PluginsApi;
    onPluginAdded: () => void;
}

export function ModalLayer({ ui, audioConfig, handleConfigUpdate, pluginsApi, onPluginAdded }: ModalLayerProps) {
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
                        isOpen={ui.isSettingsOpen}
                        onClose={() => ui.setIsSettingsOpen(false)}
                        onConfigChange={handleConfigUpdate}
                        onEngineRestarted={handleEngineRestart}
                        onOpenWizard={() => ui.setIsWizardOpen(true)}
                        onOpenOBSGuide={() => {
                            ui.setIsSettingsOpen(false);
                            ui.setIsOBSGuideOpen(true);
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
                        onClose={() => ui.setIsOBSGuideOpen(false)}
                        onOpenAudioSettings={() => {
                            ui.setIsOBSGuideOpen(false);
                            ui.setIsSettingsOpen(true);
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
                            localStorage.setItem('vst_host_wizard_done', 'true');
                        }}
                        onApplyConfig={(host, input, output) => {
                            handleConfigUpdate({ host, input, output, sampleRate: 48000, bufferSize: 512 });
                            const config = { host, input, output };
                            localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
                            localStorage.setItem('vst_host_wizard_done', 'true');
                        }}
                        onOpenSettings={() => ui.setIsSettingsOpen(true)}
                    />
                </Suspense>
            )}
            {ui.isPresetManagerOpen && (
                <Suspense fallback={null}>
                    <PresetManagerModal
                        isOpen={ui.isPresetManagerOpen}
                        onClose={() => ui.setIsPresetManagerOpen(false)}
                        onLoadPreset={pluginsApi.loadPreset}
                        onSavePreset={pluginsApi.savePreset}
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
                    />
                </Suspense>
            )}
            {ui.isRecoveryModalOpen && (
                <Suspense fallback={null}>
                    <RecoveryModal
                        isOpen={ui.isRecoveryModalOpen}
                        onClose={() => ui.setIsRecoveryModalOpen(false)}
                        error={ui.crashError}
                        onClear={() => {
                            pluginsApi.resetPlugins();
                            audioApi.start(audioConfig.host, audioConfig.input, audioConfig.output, audioConfig.bufferSize || 512, audioConfig.sampleRate || 48000);
                        }}
                        onRecover={async (_safeMode, excludePath) => {
                            try {
                                await audioApi.start(audioConfig.host, audioConfig.input, audioConfig.output, audioConfig.bufferSize || 512, audioConfig.sampleRate || 48000);
                            } catch (e) {
                                console.error("Recovery Restart Failed", e);
                            }
                            await pluginsApi.recoverSession(excludePath);
                        }}
                    />
                </Suspense>
            )}
            {ui.isLargeMeterOpen && (
                <Suspense fallback={null}>
                    <LargeLevelMeter onClose={() => ui.setIsLargeMeterOpen(false)} />
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
                    />
                </Suspense>
            )}
        </>
    );
}

import { Suspense, lazy } from 'react';
import { useUIState } from '../../hooks/useUIState';
import { useAudioConfig } from '../../hooks/useAudioConfig';
import { usePlugins } from '../../hooks/usePlugins';
import { useTutorial } from '../../contexts/TutorialContext';

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

export function ModalLayer() {
    const ui = useUIState();
    const {
        audioConfig,
        handleConfigUpdate
    } = useAudioConfig(
        () => ui.setIsWizardOpen(true),
        () => ui.setIsSettingsOpen(true)
    );

    const pluginsApi = usePlugins();
    const { currentStep, completeStep } = useTutorial();

    const handleEngineRestart = async () => {
        pluginsApi.resetPlugins();
        await pluginsApi.restoreSession();
    };

    const handlePluginSelect = async (vstPlugin: any) => {
        const success = await pluginsApi.addPlugin(vstPlugin);
        if (success) {
            ui.setIsBrowserOpen(false);
            // Advance tutorial only when plugin is actually added
            if (currentStep === 'click_add_effect') {
                completeStep('click_add_effect');
            }
            // Note: Tutorial step completion is handled in App.tsx side effects or via events if needed.
            // Ideally App.tsx handles the "logic" of tutorial progression, or we move it here?
            // For now, let's keep the tutorial logic simple or expose an event.
            // But wait, `handlePluginSelect` in App.tsx had:
            // if (currentStep === 'click_add_effect') completeStep('click_add_effect');
            // We need to access tutorial context here if we want to preserve that behavior exactly,
            // OR we pass `onPluginAdded` callback to this layer.
            // Let's import useTutorial here to keep it self-contained.
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
                            // Re-using the same default constants as in App.tsx/audioConfig
                            // Ideally these should be constants.
                            import('../../api/audio').then(({ audioApi }) => {
                                audioApi.start(audioConfig.host, audioConfig.input, audioConfig.output, audioConfig.bufferSize || 512, audioConfig.sampleRate || 48000);
                            });
                        }}
                        onRecover={async (_safeMode, excludePath) => {
                            try {
                                // We need to import audioApi dynamically or pass it in?
                                // Importing typically fine in React components.
                                const { audioApi } = await import('../../api/audio');
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
        </>
    );
}

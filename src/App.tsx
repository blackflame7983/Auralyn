import { Suspense, lazy } from 'react';
import { AppShell } from './components/layout/AppShell';
import { PluginList } from './components/features/PluginRack/PluginList';
import { Toaster } from 'sonner';

import { usePlugins } from './hooks/usePlugins';
import { useTheme } from './hooks/useTheme';
import { useAudioConfig } from './hooks/useAudioConfig';
import { useAppEvents } from './hooks/useAppEvents';
import { useUIState } from './hooks/useUIState';
import { audioApi } from './api/audio';

// Lazy load modals for better initial bundle size
// Lazy load modals for better initial bundle size
const AudioSettingsModal = lazy(() => import('./components/features/AudioSettings/AudioSettingsModal').then(m => ({ default: m.AudioSettingsModal })));
const PluginBrowserModal = lazy(() => import('./components/features/PluginBrowser/PluginBrowserModal').then(m => ({ default: m.PluginBrowserModal })));
const OBSGuideModal = lazy(() => import('./components/features/Guide/OBSGuideModal').then(m => ({ default: m.OBSGuideModal })));
const DiscordGuideModal = lazy(() => import('./components/features/Guide/DiscordGuideModal').then(m => ({ default: m.DiscordGuideModal })));
const LicenseModal = lazy(() => import('./components/features/Settings/LicenseModal').then(m => ({ default: m.LicenseModal })));
const SetupWizardModal = lazy(() => import('./components/features/SetupWizard/SetupWizardModal').then(m => ({ default: m.SetupWizardModal })));
const PresetManagerModal = lazy(() => import('./components/features/Presets/PresetManagerModal').then(m => ({ default: m.PresetManagerModal })));
const TemplateWizardModal = lazy(() => import('./components/features/Templates/TemplateWizardModal').then(m => ({ default: m.TemplateWizardModal })));
const RecoveryModal = lazy(() => import('./components/features/Recovery/RecoveryModal').then(m => ({ default: m.RecoveryModal })));
import { TutorialProvider, useTutorial } from './contexts/TutorialContext';
import { TutorialOverlay } from './components/features/Tutorial/TutorialOverlay';

const LargeLevelMeter = lazy(() => import('./components/features/LevelMeter/LargeLevelMeter').then(m => ({ default: m.LargeLevelMeter })));

function AppContent() {
  const { theme } = useTheme();
  const { currentStep, completeStep } = useTutorial();

  // Custom Hooks
  const ui = useUIState();
  const {
    audioConfig,
    handleConfigUpdate,
    isInitializing
  } = useAudioConfig(
    () => ui.setIsWizardOpen(true),
    () => ui.setIsSettingsOpen(true)
  );

  const pluginsApi = usePlugins(); // Destructure below or use directly

  useAppEvents({
    onAddPlugin: pluginsApi.addPlugin,
    onResetPlugins: pluginsApi.resetPlugins,
    onCrash: (err) => {
      // Logic to save crash state to localStorage is now handled here or in useAppEvents?
      // useAppEvents just calls onCrash.
      // App.tsx old logic: saved 'vst_host_detected_crash_plugin'.
      const pending = localStorage.getItem('vst_host_pending_plugin');
      if (pending) {
        localStorage.setItem('vst_host_detected_crash_plugin', pending);
      }
      ui.setCrashError(err);
      ui.setIsRecoveryModalOpen(true);
    },
    onLoadPreset: pluginsApi.loadPreset
  });

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
    }
  };

  // Interaction Handlers
  const handleAddClick = () => {
    ui.setIsBrowserOpen(true);
  };

  return (
    <>
      {isInitializing && (
        <div className="fixed inset-0 z-[9999] bg-background flex flex-col items-center justify-center space-y-6 animate-out fade-out duration-700 fill-mode-forwards">
          <div className="relative">
            <div className="w-20 h-20 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-10 h-10 bg-primary/10 rounded-full animate-pulse" />
            </div>
          </div>
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold tracking-tighter animate-pulse">Auralyn</h2>
            <p className="text-sm text-muted-foreground font-mono">
              音声エンジンを起動しています…
            </p>
          </div>
        </div>
      )}

      <AppShell
        onOpenSettings={() => ui.setIsSettingsOpen(true)}
        onOpenOBSGuide={() => ui.setIsOBSGuideOpen(true)}
        onOpenDiscordGuide={() => ui.setIsDiscordGuideOpen(true)}
        onToggleLargeMeter={() => ui.setIsLargeMeterOpen(prev => !prev)}
        isLargeMeterOpen={ui.isLargeMeterOpen}
        currentHost={audioConfig.host}
        currentSampleRate={audioConfig.sampleRate}
        currentBufferSize={audioConfig.bufferSize}
      >
        <PluginList
          plugins={pluginsApi.plugins}
          onAddClick={handleAddClick}
          onToggle={pluginsApi.togglePlugin}
          onMute={pluginsApi.toggleMute}
          onGainChange={pluginsApi.setPluginGain}
          onRemove={pluginsApi.removePlugin}
          onEdit={pluginsApi.openEditor}
          onReorder={pluginsApi.reorderPlugins}
          onOpenPresets={() => ui.setIsPresetManagerOpen(true)}
          onOpenWizard={() => ui.setIsWizardOpen(true)}
          onOpenTemplates={() => ui.setIsTemplateWizardOpen(true)}
        />

        {!ui.isBrowserOpen && !isInitializing && (
          <TutorialOverlay
            targetId="add-effect-btn"
            step="click_add_effect"
            side="top"
            align="center"
            content={
              <div className="space-y-2">
                <strong className="block text-green-500 font-bold">ステップ 1: エフェクトを追加</strong>
                <p>まずはここをクリックして、最初のエフェクト（VSTプラグイン）を追加してみましょう。</p>
              </div>
            }
          />
        )}
        <TutorialOverlay
          targetId="first-plugin-card"
          step="explain_plugin_card"
          side="bottom"
          align="start"
          content={
            <div className="space-y-2">
              <strong className="block text-green-500 font-bold">ステップ 2: 操作方法</strong>
              <p>エフェクトが追加されました！<br />電源ボタンでON/OFF、スライダーで音量（ゲイン）を調整できます。</p>
            </div>
          }
        />

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
                handleConfigUpdate(host, input, output, 48000, 512);
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
        <Toaster position="top-right" theme={theme === 'light' ? 'light' : 'dark'} richColors />
      </AppShell>
    </>
  );
}

function App() {
  return (
    <TutorialProvider>
      <AppContent />
    </TutorialProvider>
  );
}

export default App;

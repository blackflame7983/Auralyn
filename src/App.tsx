import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { useBeginnerMode } from './hooks/useBeginnerMode';
import { useLiveModes } from './hooks/useLiveModes';
import { LiveModeBar } from './components/features/AudioSettings/LiveModeBar';
import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { PluginList } from './components/features/PluginRack/PluginList';
import { ModalLayer } from './components/layout/ModalLayer';
import { SessionRecoveryNotice } from './components/features/Recovery/SessionRecoveryNotice';
import { Toaster } from 'sonner';

import { usePlugins } from './hooks/usePlugins';
import { useTheme } from './hooks/useTheme';
import { useAudioConfig } from './hooks/useAudioConfig';
import { useAppEvents } from './hooks/useAppEvents';
import { useUIState } from './hooks/useUIState';
import { audioApi } from './api/audio';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';

import { TutorialProvider, useTutorial } from './contexts/TutorialContext';
import { TutorialOverlay } from './components/features/Tutorial/TutorialOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';

function AppContent() {
    const t = useMessages();
  const { theme } = useTheme();
  const { currentStep, completeStep } = useTutorial();

  // Custom Hooks
  const ui = useUIState();
  const [isBeginnerMode, setIsBeginnerMode] = useBeginnerMode();
  const { audioConfig, handleConfigUpdate, isInitializing, isEngineRunning, engineProcessReady } = useAudioConfig(
    () => ui.setIsWizardOpen(true),
    () => ui.setIsSettingsOpen(true)
  );

  const audioReady = !isInitializing && Boolean(audioConfig.host) && isEngineRunning && engineProcessReady === true;
  const tutorialEligible = useRef(false);
  tutorialEligible.current = audioReady && !isBeginnerMode;

  const pluginsApi = usePlugins();
  const liveModel = useLiveModes(pluginsApi.isLoading);

  useAppEvents({
    onAddPlugin: pluginsApi.addPlugin,
    onResetPlugins: pluginsApi.resetPlugins,
    onCrash: (err) => {
      const pending = localStorage.getItem('vst_host_pending_plugin');
      if (pending) {
        localStorage.setItem('vst_host_detected_crash_plugin', pending);
      }
      ui.setCrashError(err);
      ui.setIsRecoveryModalOpen(true);
    },
    onLoadPreset: pluginsApi.loadPreset,
  });

  // Pre-fetch devices in background to speed up setup wizard
  useEffect(() => {
    audioApi.getDevices(true).catch((e) => console.error('Background device scan failed:', e));
  }, []);

  // Close to tray: hide window instead of quitting
  useEffect(() => {
    const setupCloseHandler = async () => {
      const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        await getCurrentWindow().hide();
      });
      return unlisten;
    };
    let unlisten: (() => void) | undefined;
    setupCloseHandler().then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const handlePluginAdded = () => {
    if (tutorialEligible.current && currentStep === 'click_add_effect') {
      completeStep('click_add_effect');
    }
  };

  // Show next-step guidance when tutorial completes
  useEffect(() => {
    if (currentStep === 'complete') {
      // Small delay to let the last overlay disappear
      const timer = setTimeout(() => {
        toast.info(<LocalizedMessage id="guide.copy.424" />, {
          description:
            <LocalizedMessage id="guide.copy.425" />,
          duration: 10000,
          action: {
            label: <LocalizedMessage id="guide.copy.426" />,
            onClick: () => ui.setIsOBSGuideOpen(true),
          },
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [currentStep]);

  const isModalOpen = [
    ui.isSettingsOpen, ui.isBrowserOpen, ui.isOBSGuideOpen, ui.isDiscordGuideOpen,
    ui.isWizardOpen, ui.isTemplateWizardOpen, ui.isLicenseModalOpen, ui.isRecoveryModalOpen,
    ui.isPresetManagerOpen, ui.isTroubleshootOpen, ui.isVoiceCheckOpen,
  ].some(Boolean);

  const pluginRack = (
    <PluginList
      plugins={pluginsApi.plugins}
      audioReady={audioReady}
      onAddClick={() => ui.setIsBrowserOpen(true)}
      onToggle={pluginsApi.togglePlugin}
      onMute={pluginsApi.toggleMute}
      onGainChange={pluginsApi.setPluginGain}
      onRemove={pluginsApi.removePlugin}
      onEdit={pluginsApi.openEditor}
      onReorder={pluginsApi.reorderPlugins}
      onOpenPresets={() => ui.setIsPresetManagerOpen(true)}
      onOpenTemplates={() => ui.setIsTemplateWizardOpen(true)}
    />
  );

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
            <p className="text-sm text-muted-foreground font-mono">{t('app.initializing')}</p>
          </div>
        </div>
      )}

      <AppShell
        isBeginnerMode={isBeginnerMode}
        onDisplayModeChange={setIsBeginnerMode}
        onOpenOBSSettings={ui.openObsSettings}
        onOpenSettings={() => ui.setIsSettingsOpen(true)}
        onOpenSoundSettings={ui.openSoundSettings}
        onOpenOBSGuide={() => ui.setIsOBSGuideOpen(true)}
        onOpenDiscordGuide={() => ui.setIsDiscordGuideOpen(true)}
        onOpenTroubleshoot={() => ui.setIsTroubleshootOpen(true)}
        onOpenVoiceCheck={() => ui.setIsVoiceCheckOpen(true)}
        onOpenWizard={() => ui.setIsWizardOpen(true)}
        onToggleLargeMeter={() => ui.setIsLargeMeterOpen((prev) => !prev)}
        isLargeMeterOpen={ui.isLargeMeterOpen}
        currentHost={audioConfig.host}
        currentSampleRate={audioConfig.sampleRate}
        currentBufferSize={audioConfig.bufferSize}
        currentInput={audioConfig.input}
        currentOutput={audioConfig.output}
        isEngineRunning={isEngineRunning}
        engineProcessReady={engineProcessReady}
      >
        <SessionRecoveryNotice
          status={pluginsApi.sessionRestoreStatus}
          protectedSession={pluginsApi.sessionPersistenceProtected}
          reason={pluginsApi.sessionProtectionReason}
          busy={pluginsApi.isLoading || pluginsApi.isScanning || isInitializing}
          onRetry={pluginsApi.retrySessionRestore}
        />
        <LiveModeBar model={liveModel} refreshKey={isModalOpen} />
        {isBeginnerMode ? (
          <details className="mb-4">
            <summary className="cursor-pointer py-3 text-sm font-semibold">
              {t('app.rack')}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {t('app.rackHint')}
              </span>
            </summary>
            {pluginRack}
          </details>
        ) : (
          pluginRack
        )}

        {audioReady && !isBeginnerMode && !isModalOpen && (
          <>
            {!ui.isBrowserOpen && !isInitializing && (
              <TutorialOverlay
                targetId="add-effect-btn"
                step="click_add_effect"
                side="top"
                align="center"
                content={
                  <div className="space-y-2">
                    <strong className="block text-info font-bold">
                      {t('guide.copy.427')}</strong>
                    <p>
                      {t('guide.copy.428')}</p>
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
                  <strong className="block text-info font-bold">{t('guide.copy.429')}</strong>
                  <p>
                    {t('guide.copy.430')}<br />
                    {t('guide.copy.431')}</p>
                </div>
              }
            />
            <TutorialOverlay
              targetId="first-plugin-card"
              step="try_edit_plugin"
              side="bottom"
              align="start"
              content={
                <div className="space-y-2">
                  <strong className="block text-info font-bold">
                    {t('guide.copy.432')}</strong>
                  <p>
                    {t('guide.copy.433')}<br />
                    {t('guide.copy.434')}</p>
                </div>
              }
            />
            <TutorialOverlay
              targetId="ab-compare-btn"
              step="try_ab_compare"
              side="top"
              align="start"
              content={
                <div className="space-y-2">
                  <strong className="block text-warning font-bold">
                    {t('guide.copy.435')}</strong>
                  <p>
                    {t('guide.copy.436')}</p>
                </div>
              }
            />
          </>
        )}

        <ModalLayer
          isAudioRunning={isEngineRunning}
          liveModel={liveModel}
          ui={ui}
          audioConfig={audioConfig}
          handleConfigUpdate={handleConfigUpdate}
          pluginsApi={pluginsApi}
          onPluginAdded={handlePluginAdded}
        />

        <Toaster position="bottom-right" offset={{ bottom: 'calc(var(--app-footer-height, 4rem) + 16px)', right: 16 }} theme={theme === 'light' ? 'light' : 'dark'} richColors />
      </AppShell>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <TutorialProvider>
        <AppContent />
      </TutorialProvider>
    </ErrorBoundary>
  );
}

export default App;

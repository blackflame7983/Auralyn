import { StreamMixPanel } from '@/components/features/Home/StreamMixPanel';
import { MixingLiveControl } from '@/components/features/Home/MixingLiveControl';
import { readPreparationContext } from '@/lib/preparation';
import { stageModeKey } from '@/lib/stageModeName';
import { useDisplayPurpose } from './hooks/useDisplayPurpose';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { sessionMode } from './lib/temporarySession';
import { REVIEW_KEY } from './api/migration';
import { startHomeAudio } from './lib/startHomeAudio';
import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { useVstPanel } from './hooks/useVstPanel';
import { MdClose } from 'react-icons/md';
import { useLiveModes } from './hooks/useLiveModes';
import { LiveModeBar } from './components/features/AudioSettings/LiveModeBar';
import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { PluginList } from './components/features/PluginRack/PluginList';
import { VstChainItems } from './components/features/Home/VstChainItems';
import { ModalLayer } from './components/layout/ModalLayer';
import { SessionRecoveryNotice } from './components/features/Recovery/SessionRecoveryNotice';
import { Toaster } from 'sonner';

import { usePlugins } from './hooks/usePlugins';
import { usePluginHealthNotices } from './hooks/usePluginHealthNotices';
import { useTheme } from './hooks/useTheme';
import { useAudioConfig } from './hooks/useAudioConfig';
import { useAppEvents } from './hooks/useAppEvents';
import { useUIState } from './hooks/useUIState';
import { audioApi } from './api/audio';
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
  const [displayPurpose] = useDisplayPurpose();
  const [vstPanelOpen, setVstPanelOpen] = useVstPanel();
  const { audioConfig, handleConfigUpdate, isInitializing, isEngineRunning, engineProcessReady } = useAudioConfig(
    () => ui.setIsWizardOpen(true),
    () => ui.setIsSettingsOpen(true)
  );

  const audioReady = !isInitializing && Boolean(audioConfig.host) && isEngineRunning && engineProcessReady === true;
  const tutorialEligible = useRef(false);
  // 初回の使い方案内は VST ラックの操作を指すので、右パネルを開いている間だけ進める。
  tutorialEligible.current = audioReady && vstPanelOpen;

  const pluginsApi = usePlugins();
  // 右パネルを閉じても、停止の toast はここから出す。カードは表示と再開だけ。
  usePluginHealthNotices(pluginsApi.plugins);
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

  // 閉じる→トレイはRustのWindowEventに集約する。JS側からhide権限を要求しない。

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
            <LocalizedMessage id={readPreparationContext().usage === 'obs' ? "guide.copy.425" : "guide.tutorialLocalDone"} />,
          duration: 5000,
          action: readPreparationContext().usage === 'obs' ? {
            label: <LocalizedMessage id="guide.copy.426" />,
            onClick: () => ui.setIsOBSGuideOpen(true),
          } : undefined,
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
      unrestored={pluginsApi.sessionUnrestored}
      headerAction={<>
        <InfoPopover label={t('info.rack')}>{t('app.rackHint')}</InfoPopover>
        <button type="button" onClick={() => setVstPanelOpen(false)} aria-label={t('rack.closePanel')} title={t('rack.closePanel')}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <MdClose aria-hidden="true" className="h-4 w-4" />
        </button>
      </>}
    />
  );

  return (
    <>
      {isInitializing && (
        <div className="fixed inset-0 z-[9999] bg-background flex flex-col items-center justify-center space-y-6">
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
        onStartAudio={sessionMode().reviewOnly || localStorage.getItem(REVIEW_KEY) === 'true' ? undefined : async () => {
          await startHomeAudio(audioConfig, config => handleConfigUpdate(config, { audioStarted: true }));
        }}
        onOpenShortcuts={ui.openShortcuts}
        onOpenOBSSettings={ui.openObsSettings}
        onOpenSettings={() => ui.setIsSettingsOpen(true)}
        onOpenAudioSettingsRetry={ui.openAudioSettingsRetry}
        onOpenSoundSettings={ui.openSoundSettings}
        onOpenAudioTuning={ui.openAudioTuning}
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
        preparationBlocked={isModalOpen || isInitializing}
        currentInput={audioConfig.inputSource?.kind === 'process_loopback' ? audioConfig.inputSource.config.appName : audioConfig.input}
        currentOutput={audioConfig.output}
        liveModeName={t(stageModeKey(liveModel.snapshot))}
        liveControlsWhileUnconfigured={Boolean(liveModel.snapshot?.definitions.singing || liveModel.snapshot?.definitions.talk || liveModel.snapshot?.armed || liveModel.snapshot?.transaction || liveModel.snapshot?.error || liveModel.error)}
        liveControls={displayPurpose === 'voice' && <div className="flex flex-wrap items-center gap-2"><LiveModeBar model={liveModel} refreshKey={isModalOpen} embedded onRegister={ui.openLiveModeSettings} onPrepareSinging={ui.openMixingSettings} /><MixingLiveControl running={audioReady} blocked={isModalOpen || isInitializing} onSettings={ui.openMixingSettings} /></div>}
        streamMixPanel={displayPurpose === 'voice' && <StreamMixPanel running={audioReady} primaryInputId={audioConfig.inputId} disabled={isModalOpen || isInitializing}
          primaryIsVoiceDevice={audioConfig.inputSource?.kind !== 'process_loopback' && (audioConfig.inputSource?.config.purpose ?? 'voice') === 'voice'} onOpenDevices={ui.openDeviceSettings} />}
        vstChain={<VstChainItems plugins={pluginsApi.plugins} onToggle={pluginsApi.togglePlugin} onEdit={pluginsApi.openEditor} />}
        vstUnrestored={pluginsApi.sessionUnrestored}
        vstPanel={pluginRack}
        isEngineRunning={isEngineRunning}
        engineProcessReady={engineProcessReady}
        notices={<>
          {sessionMode().cleanupPending && <p role="alert" className="mb-4 border rounded p-3 text-sm break-all">{t('temporary.cleanupFailed', { path: sessionMode().cleanupPending! })}</p>}
          {sessionMode().temporary && <p role="status" className="mb-4 border rounded p-3 text-sm">{t('temporary.active')} <button type="button" className="underline" onClick={() => ui.setIsPresetManagerOpen(true)}>{t('temporary.manage')}</button></p>}
          <SessionRecoveryNotice
            status={pluginsApi.sessionRestoreStatus}
            protectedSession={pluginsApi.sessionPersistenceProtected}
            reason={pluginsApi.sessionProtectionReason}
            busy={pluginsApi.isLoading || pluginsApi.isScanning || isInitializing}
            onRetry={pluginsApi.retrySessionRestore}
            missingRecovery={pluginsApi.missingRecovery}
            onCheckMissing={pluginsApi.checkMissingPlugins}
            onSaveWithoutMissing={pluginsApi.saveWithoutMissingPlugins}
            unrestored={pluginsApi.sessionUnrestored}
          />
        </>}
      >
        {/* 音楽鑑賞では日常の歌・雑談操作を出さず、保護や復旧が必要な場合だけ操作を残す。 */}
        {displayPurpose === 'music' && <><LiveModeBar model={liveModel} refreshKey={isModalOpen} safetyOnly /><MixingLiveControl running={audioReady} blocked={isModalOpen || isInitializing} onSettings={ui.openMixingSettings} errorsOnly /></>}
        {/* VST ラックは AppShell の右パネルに出す。 */}
        {audioReady && vstPanelOpen && !isModalOpen && (
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
          handleConfigUpdate={async (config, options) => {
            await handleConfigUpdate(config, options);
            // 音声設定からの開始と保存が揃った後だけ、ホームの開始失敗を解除する。
            if (options?.audioStarted) window.dispatchEvent(new Event('audio-settings-started'));
          }}
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

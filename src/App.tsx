import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { PluginList } from './components/features/PluginRack/PluginList';
import { ModalLayer } from './components/layout/ModalLayer';
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
  const { theme } = useTheme();
  const { currentStep, completeStep } = useTutorial();

  // Custom Hooks
  const ui = useUIState();
  const {
    audioConfig,
    handleConfigUpdate,
    isInitializing,
    isEngineRunning
  } = useAudioConfig(
    () => ui.setIsWizardOpen(true),
    () => ui.setIsSettingsOpen(true)
  );

  const pluginsApi = usePlugins();

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
    onLoadPreset: pluginsApi.loadPreset
  });

  // Pre-fetch devices in background to speed up setup wizard
  useEffect(() => {
    audioApi.getDevices(true).catch(e => console.error("Background device scan failed:", e));
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
    setupCloseHandler().then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const handlePluginAdded = () => {
    if (currentStep === 'click_add_effect') {
      completeStep('click_add_effect');
    }
  };

  // Show next-step guidance when tutorial completes
  useEffect(() => {
    if (currentStep === 'complete') {
      // Small delay to let the last overlay disappear
      const timer = setTimeout(() => {
        toast.success('セットアップ完了！', {
          description: '配信ソフトと連携するには、ヘルプメニューの「OBS連携ガイド」または「Discord連携ガイド」をご覧ください。',
          duration: 10000,
          action: {
            label: 'OBSガイドを開く',
            onClick: () => ui.setIsOBSGuideOpen(true),
          },
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [currentStep]);

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
        onOpenTroubleshoot={() => ui.setIsTroubleshootOpen(true)}
        onOpenWizard={() => ui.setIsWizardOpen(true)}
        onToggleLargeMeter={() => ui.setIsLargeMeterOpen(prev => !prev)}
        isLargeMeterOpen={ui.isLargeMeterOpen}
        currentHost={audioConfig.host}
        currentSampleRate={audioConfig.sampleRate}
        currentBufferSize={audioConfig.bufferSize}
        isEngineRunning={isEngineRunning}
      >
        <PluginList
          plugins={pluginsApi.plugins}
          onAddClick={() => ui.setIsBrowserOpen(true)}
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
              <strong className="block text-green-500 font-bold">ステップ 2/4: 操作方法</strong>
              <p>エフェクトが追加されました！<br />電源ボタンでON/OFF、スライダーで音量（ゲイン）を調整できます。</p>
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
              <strong className="block text-blue-500 font-bold">ステップ 3/4: プラグインを編集</strong>
              <p>「編集」ボタンを押すと、プラグイン独自の設定画面が開きます。<br />ここで詳細なパラメータを調整できます。</p>
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
              <strong className="block text-orange-500 font-bold">ステップ 4/4: エフェクト比較を試そう</strong>
              <p>フッターの「比較」ボタン（原音比較）で、エフェクトあり/なしの音を瞬時に切り替えて比較できます。</p>
            </div>
          }
        />

        <ModalLayer
          ui={ui}
          audioConfig={audioConfig}
          handleConfigUpdate={handleConfigUpdate}
          pluginsApi={pluginsApi}
          onPluginAdded={handlePluginAdded}
        />

        <Toaster position="top-right" theme={theme === 'light' ? 'light' : 'dark'} richColors />
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

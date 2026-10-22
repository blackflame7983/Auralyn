import { Modal } from '../../ui/modal';
import { MicrophonePermissionGuide } from './MicrophonePermissionGuide';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { MdClose, MdRefresh, MdSettings, MdWarning, MdLightbulb, MdExtension, MdSave, MdDelete, MdPalette, MdFavorite, MdLanguage } from 'react-icons/md';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { audioApi, BuiltInEffectsPreset, EngineRuntimeStats, EngineTuningConfig, NoiseControlMode } from '../../../api/audio';
import { autostartApi } from '../../../api/autostart';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from "@/components/ui/switch";
import { Label } from '@/components/ui/label';
import { useTheme } from '../../../hooks/useTheme';
import { InputChannelSelector } from './InputChannelSelector';
import { ObsConnectionSettings } from './ObsConnectionSettings';
import { APP_INFO } from '../../../constants/appInfo';
import { MigrationPanel } from './MigrationPanel';
import { ShortcutsPanel } from './ShortcutsPanel';
import { UpdatePreferences } from './UpdatePreferences';
import { REVIEW_KEY } from '@/api/migration';
import { useAudioDeviceSelection } from './useAudioDeviceSelection';

interface AudioSettingsModalProps {
  initialTab?: 'audio' | 'obs' | 'sound';
  isOpen: boolean;
  onClose: () => void;
  onConfigChange: (config: Partial<import('../../../lib/audioPreferences').AudioPreferences> & { host: string }, options?: { audioStarted: true }) => void | Promise<void>;
  onEngineRestarted?: () => Promise<void> | void;
  onOpenWizard?: () => void;
  onOpenOBSGuide?: () => void;
  onOpenTroubleshoot?: () => void;
  onOpenVoiceCheck?: () => void;
  onOpenLicense?: () => void;
  currentSampleRate?: number;
  currentBufferSize?: number;
  currentInputChannels?: [number, number];
}

export const AudioSettingsModal: React.FC<AudioSettingsModalProps> = ({
  initialTab = 'audio',
  isOpen,
  onClose,
  onConfigChange,
  onOpenWizard,
  onEngineRestarted,
  onOpenLicense,
  onOpenOBSGuide,
  onOpenTroubleshoot,
  onOpenVoiceCheck,
  currentSampleRate,
  currentBufferSize,
  currentInputChannels,
}) => {
  const getBeginnerMode = () => localStorage.getItem('vst_host_beginner_mode') !== 'false';
  const { theme, setTheme } = useTheme();
  const [isApplying, setLoading] = useState(false);
  const reviewRequired = localStorage.getItem(REVIEW_KEY) === 'true';
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const importedPlugins = useMemo(() => {
    try { return (JSON.parse(localStorage.getItem('vst_host_session_plugins') ?? '[]') as { name: string; path: string }[]); }
    catch { return []; }
  }, []);
  const [error, setError] = useState<string | null>(null);
  const {
    devices, selectedHost, setSelectedHost, selectedInput, setSelectedInput,
    selectedOutput, setSelectedOutput, selectedBufferSize, setSelectedBufferSize,
    selectedSampleRate, setSelectedSampleRate, fetchDevices, isAsio,
    filteredInputs, filteredOutputs, activeDevice, supportedBufferSizes,
    canChangeBufferSize, loading: devicesLoading,
  } = useAudioDeviceSelection({ isOpen, currentSampleRate, currentBufferSize, onError: setError });
  const loading = isApplying || devicesLoading;

  // Simple/Advanced Mode
  const [isAdvancedMode, setIsAdvancedMode] = useState(() => {
    // Initialize from localStorage
    return localStorage.getItem('vst_host_settings_advanced') === 'true';
  });

  // Tab State
  const [activeTab, setActiveTab] = useState<'audio' | 'sound' | 'obs' | 'appearance' | 'system'>(initialTab);
  const [isBeginnerMode, setIsBeginnerMode] = useState(getBeginnerMode);
  const [isSystemTabEnabled, setIsSystemTabEnabled] = useState(() => {
    if (!getBeginnerMode()) return true;
    return localStorage.getItem('vst_host_system_tab_enabled') === 'true';
  });

  // Persist Advanced Mode selection
  useEffect(() => {
    localStorage.setItem('vst_host_settings_advanced', String(isAdvancedMode));
  }, [isAdvancedMode]);

  useEffect(() => {
    const syncBeginnerMode = (event?: Event) => {
      const next = (event as CustomEvent<boolean> | undefined)?.detail;
      const beginnerMode = typeof next === 'boolean' ? next : getBeginnerMode();
      setIsBeginnerMode(beginnerMode);
      if (!beginnerMode) {
        setIsSystemTabEnabled(true);
      }
    };

    window.addEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
    window.addEventListener('storage', syncBeginnerMode);
    return () => {
      window.removeEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
      window.removeEventListener('storage', syncBeginnerMode);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('vst_host_system_tab_enabled', String(isSystemTabEnabled));
  }, [isSystemTabEnabled]);

  useEffect(() => {
    if (isBeginnerMode && !isSystemTabEnabled && activeTab === 'system') {
      setActiveTab('audio');
    }
  }, [isBeginnerMode, isSystemTabEnabled, activeTab]);

  // OBS State
  // Preset State
  const [presets, setPresets] = useState<Record<string, any>>({});
  const [presetName, setPresetName] = useState('');

  // Autostart State
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartCanChange, setAutostartCanChange] = useState(false);
  const [autostartReason, setAutostartReason] = useState<string | null>(null);
  const [engineTuningConfig, setEngineTuningConfig] = useState<EngineTuningConfig>({
    enableAffinityPinning: false,
    affinityMask: null,
    enableRealtimePriority: false,
    enableTimeCriticalAudioThreads: false,
  });
  const [engineStats, setEngineStats] = useState<EngineRuntimeStats | null>(null);
  const [systemSaving, setSystemSaving] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [noiseMode, setNoiseMode] = useState<NoiseControlMode>('smart');
  const [noiseStrength, setNoiseStrength] = useState(80);
  const [noiseVoiceGuard, setNoiseVoiceGuard] = useState(true);
  const [noiseActionBusy, setNoiseActionBusy] = useState(false);
  const noiseStrengthEditing = useRef(false);
  const [builtInEffectsEnabled, setBuiltInEffectsEnabled] = useState(false);
  const [builtInEffectsPreset, setBuiltInEffectsPreset] = useState<BuiltInEffectsPreset>('broadcast');
  const [builtInEffectsAmount, setBuiltInEffectsAmount] = useState(70);

  useEffect(() => {
    if (!engineStats) return;
    const mode = engineStats.noiseReductionMode as NoiseControlMode;
    if (['low', 'high', 'smart', 'venue'].includes(mode)) {
      setNoiseMode(mode);
    }
    setNoiseVoiceGuard(engineStats.noiseVoiceGuard ?? true);
    setBuiltInEffectsEnabled(!!engineStats.builtInEffectsEnabled);
    if (['broadcast', 'warm', 'bright'].includes(engineStats.builtInEffectsPreset)) {
      setBuiltInEffectsPreset(engineStats.builtInEffectsPreset as BuiltInEffectsPreset);
    }
    if (!noiseStrengthEditing.current && engineStats.noiseControlStrength > 0) {
      setNoiseStrength(Math.round(engineStats.noiseControlStrength * 100));
    }
  }, [engineStats]);

  // プロファイル適用時にノイズ/内蔵 FX のローカル state を同期
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        noiseControl?: { enabled: boolean; mode: string; strength: number; voiceGuard: boolean };
        builtinFx?: { preset: string; enabled: boolean; amount: number };
      } | undefined;
      if (!detail) return;
      if (detail.noiseControl) {
        const nc = detail.noiseControl;
        if (['low', 'high', 'smart', 'venue'].includes(nc.mode)) {
          setNoiseMode(nc.mode as NoiseControlMode);
        }
        setNoiseStrength(Math.round(nc.strength * 100));
        setNoiseVoiceGuard(nc.voiceGuard);
      }
      if (detail.builtinFx) {
        const fx = detail.builtinFx;
        setBuiltInEffectsEnabled(fx.enabled);
        if (['broadcast', 'warm', 'bright'].includes(fx.preset)) {
          setBuiltInEffectsPreset(fx.preset as BuiltInEffectsPreset);
        }
      }
    };
    window.addEventListener('profile-fx-applied', handler);
    return () => window.removeEventListener('profile-fx-applied', handler);
  }, []);

  // Confirm dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
  }>({ isOpen: false, title: '', onConfirm: () => {} });

  const showConfirm = (opts: Omit<typeof confirmDialog, 'isOpen'>) => {
    setConfirmDialog({ ...opts, isOpen: true });
  };

  // Common sample rates
  const sampleRates = [44100, 48000, 96000];

  // Load settings from localStorage on mount/open
  useEffect(() => {
    if (isOpen) {
      autostartApi.getStatus().then(s => {
        setAutostartEnabled(s.enabled);
        setAutostartCanChange(s.canChange);
        setAutostartReason(s.reason ?? null);
      }).catch(() => {
        setAutostartCanChange(false);
        setAutostartReason('自動起動の状態を確認できませんでした。設定画面を開き直してください。');
      });
      audioApi.getEngineTuningConfig()
        .then((config) => setEngineTuningConfig(config))
        .catch((e) => {
          console.error('Failed to load engine tuning config', e);
        });
      audioApi.getEngineRuntimeStats()
        .then((stats) => setEngineStats(stats))
        .catch((e) => {
          console.error('Failed to load engine runtime stats', e);
        });
    }
  }, [isOpen, currentSampleRate, currentBufferSize]);

  const refreshEngineRuntimeStats = async () => {
    setStatsLoading(true);
    try {
      const stats = await audioApi.getEngineRuntimeStats();
      setEngineStats(stats);
    } catch (e) {
      console.error('Failed to refresh engine runtime stats', e);
      toast.error('エンジン統計の取得に失敗しました');
    } finally {
      setStatsLoading(false);
    }
  };

  const applyNoiseControlConfig = async (next?: Partial<{ active: boolean; mode: NoiseControlMode; strength: number; voiceGuard: boolean }>) => {
    const active = next?.active ?? !!engineStats?.noiseReductionEnabled;
    const mode = next?.mode ?? noiseMode;
    const strength = next?.strength ?? noiseStrength;
    const voiceGuard = next?.voiceGuard ?? noiseVoiceGuard;
    setNoiseActionBusy(true);
    try {
      await audioApi.setNoiseControlConfig({
        active,
        mode,
        strength: Math.max(25, Math.min(125, strength)) / 100,
        voiceGuard,
      });
      const stats = await audioApi.getEngineRuntimeStats();
      setEngineStats(stats);
      toast.success(active ? 'ノイズ低減を更新しました' : 'ノイズ低減をOFFにしました');
    } catch (e) {
      console.error('Failed to apply noise control config', e);
      toast.error('ノイズ低減の更新に失敗しました');
    } finally {
      setNoiseActionBusy(false);
    }
  };

  const commitNoiseStrength = (value: string) => {
    if (!noiseStrengthEditing.current) return;
    noiseStrengthEditing.current = false;
    void applyNoiseControlConfig({ strength: Number(value) });
  };

  const handleCancelNoiseLearning = async () => {
    setNoiseActionBusy(true);
    try {
      await audioApi.cancelNoiseLearning();
      await refreshEngineRuntimeStats();
    } catch (error) {
      console.error('Failed to cancel noise learning', error);
      toast.error('ノイズ学習を中止できませんでした。状態を確認して再試行してください');
    } finally {
      setNoiseActionBusy(false);
    }
  };

  const handleStartNoiseLearning = async () => {
    setNoiseActionBusy(true);
    try {
      await audioApi.startNoiseLearning(3000);
      toast.info('3秒間、定常ノイズをプロファイル化しています（この間は話さないでください）');
      window.setTimeout(refreshEngineRuntimeStats, 3500);
    } catch (e) {
      console.error('Failed to start noise learning', e);
      toast.error('ノイズ学習を開始できませんでした');
    } finally {
      setNoiseActionBusy(false);
    }
  };

  const applyBuiltInEffects = async (next?: Partial<{ active: boolean; preset: BuiltInEffectsPreset; amount: number }>) => {
    const active = next?.active ?? builtInEffectsEnabled;
    const preset = next?.preset ?? builtInEffectsPreset;
    const amount = next?.amount ?? builtInEffectsAmount;
    try {
      await audioApi.setBuiltInEffects({
        active,
        preset,
        amount: Math.max(0, Math.min(100, amount)) / 100,
      });
      const stats = await audioApi.getEngineRuntimeStats();
      setEngineStats(stats);
      toast.success(active ? '内蔵ボイスチェーンを更新しました' : '内蔵ボイスチェーンをOFFにしました');
    } catch (e) {
      console.error('Failed to apply built-in effects', e);
      toast.error('内蔵ボイスチェーンの更新に失敗しました');
    }
  };

  const saveEngineTuningConfig = async () => {
    const normalized: EngineTuningConfig = {
      ...engineTuningConfig,
      affinityMask: engineTuningConfig.affinityMask?.trim() || null,
    };

    setSystemSaving(true);
    try {
      await audioApi.setEngineTuningConfig(normalized);
      setEngineTuningConfig(normalized);
      toast.success('システム設定を保存しました（エンジン再起動後に反映）');
    } catch (e) {
      console.error('Failed to save engine tuning config', e);
      toast.error('システム設定の保存に失敗しました');
    } finally {
      setSystemSaving(false);
    }
  };

  const enableSystemTab = () => {
    setIsSystemTabEnabled(true);
    setActiveTab('system');
  };

  const handleDangerousToggle = (
    key: 'enableRealtimePriority' | 'enableTimeCriticalAudioThreads',
    checked: boolean,
    title: string,
    warning: string
  ) => {
    if (!checked) {
      setEngineTuningConfig((prev) => ({ ...prev, [key]: false }));
      return;
    }

    showConfirm({
      title: `${title}を有効化しますか？`,
      description: `${warning}${isBeginnerMode ? ' かんたん表示では無効のままを推奨します。' : ''}`,
      confirmLabel: '有効化する',
      variant: 'destructive',
      onConfirm: () => {
        setEngineTuningConfig((prev) => ({ ...prev, [key]: true }));
      },
    });
  };

  const estimatedLatencyMs = useMemo(
    () => ((selectedBufferSize * 2) / selectedSampleRate) * 1000 + (isAsio ? 0 : 20),
    [selectedBufferSize, selectedSampleRate, isAsio]
  );
  const latencyStatus = useMemo(() => {
    if (estimatedLatencyMs <= 10) return { label: '最高', className: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30' };
    if (estimatedLatencyMs <= 20) return { label: '良好', className: 'text-primary bg-primary/10 border-primary/30' };
    if (estimatedLatencyMs <= 40) return { label: '普通', className: 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/30' };
    return { label: '遅延大', className: 'text-destructive bg-destructive/10 border-destructive/30' };
  }, [estimatedLatencyMs]);

  const handleSave = async () => {
    setLoading(true);
    try {
      // For ASIO, Output must match Input
      const finalOutput = isAsio ? selectedInput : selectedOutput;

      // Find device IDs
      const inputDev = filteredInputs.find(d => d.name === selectedInput);
      const outputDev = filteredOutputs.find(d => d.name === finalOutput);
      const inputId = inputDev?.id;
      const outputId = outputDev?.id;

      const res = await audioApi.start(
        selectedHost,
        selectedInput || undefined,
        finalOutput || undefined,
        selectedBufferSize,
        selectedSampleRate,
        inputId,
        outputId
      );

      // Save to localStorage REMOVED (Handled by App.tsx Listener)
      // We rely on the App to listen for "Started" event to persist actual SampleRate/BufferSize.
      // This prevents overwriting the actual Fallback values with our requested values.

      // Notify parent to update persistence with ALL params
      const inputChannels: [number, number] = isAsio ? (currentInputChannels ?? [0, 1]) : [0, 1];
      await audioApi.setInputChannels(inputChannels[0], inputChannels[1]);
      await onConfigChange({
        inputChannels,
        host: selectedHost,
        input: selectedInput || undefined,
        output: finalOutput || undefined,
        sampleRate: res.sample_rate,
        bufferSize: res.buffer_size,
        inputId,
        outputId
      }, { audioStarted: true });
      // toast.success('オーディオエンジンを起動しました'); // Assuming toast is available
      onClose();
    } catch (err) {
      console.error('Failed to start audio:', err);
      setError('オーディオの開始に失敗しました: ' + err);
    } finally {
      setLoading(false);
    }
  };

  const performRestart = async () => {

    setLoading(true);
    try {
      const finalOutput = isAsio ? selectedInput : selectedOutput;
      const inputDev = filteredInputs.find(d => d.name === selectedInput);
      const outputDev = filteredOutputs.find(d => d.name === finalOutput);
      const inputId = inputDev?.id;
      const outputId = outputDev?.id;

      const res = await audioApi.restart(
        selectedHost,
        selectedInput || undefined,
        finalOutput || undefined,
        selectedBufferSize,
        selectedSampleRate,
        inputId,
        outputId
      );

      const inputChannels: [number, number] = isAsio ? (currentInputChannels ?? [0, 1]) : [0, 1];
      await audioApi.setInputChannels(inputChannels[0], inputChannels[1]);
      await onConfigChange({
        inputChannels,
        host: selectedHost,
        input: selectedInput || undefined,
        output: finalOutput || undefined,
        sampleRate: res.sample_rate,
        bufferSize: res.buffer_size,
        inputId,
        outputId
      }, { audioStarted: true });

      // The restart kills the sidecar process (plugins are lost), so restore them from session.
      // 移行確認完了時はonConfigChangeが復元を開始するため、通常再起動の復元と重ねない。
      if (onEngineRestarted && !reviewRequired) {
        toast.info("プラグインを復元中...");
        await onEngineRestarted();
        toast.success("プラグインを復元しました");
      }
      onClose();
      // Optional: formatting toast success
    } catch (err) {
      console.error('Failed to restart engine:', err);
      setError('エンジンの再起動に失敗しました: ' + err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = () => {
    showConfirm({
      title: 'オーディオエンジンを再起動しますか？',
      description: '再起動すると一時的に音声が途切れます。読み込み済みのプラグインは自動的に復元されます。',
      confirmLabel: '再起動する',
      variant: 'default',
      onConfirm: performRestart,
    });
  };

  // Get Unique Hosts list
  const availableHosts = useMemo(() =>
    Array.from(new Set([...devices.inputs, ...devices.outputs].map(d => d.host))),
    [devices]);


  // Preset Helpers
  useEffect(() => {
    if (isOpen) {
      const saved = localStorage.getItem('vst_host_audio_presets');
      if (saved) {
        try { setPresets(JSON.parse(saved)); } catch { }
      }
    }
  }, [isOpen]);

  const handleSavePreset = () => {
    if (!presetName.trim()) return;
    const newPresets = {
      ...presets,
      [presetName]: {
        host: selectedHost,
        input: selectedInput,
        output: selectedOutput,
        bufferSize: selectedBufferSize,
        sampleRate: selectedSampleRate
      }
    };
    setPresets(newPresets);
    localStorage.setItem('vst_host_audio_presets', JSON.stringify(newPresets));
  };

  const handleLoadPreset = (name: string) => {
    const p = presets[name];
    if (p) {
      setPresetName(name);
      if (p.host) setSelectedHost(p.host);
      if (p.input) setSelectedInput(p.input);
      if (p.output) setSelectedOutput(p.output); // Might trigger useEffect to auto-correct if invalid
      if (p.bufferSize) setSelectedBufferSize(p.bufferSize);
      if (p.sampleRate) setSelectedSampleRate(p.sampleRate);
    }
  };

  const handleDeletePreset = () => {
    if (!presetName || !presets[presetName]) return;
    showConfirm({
      title: `プリセット「${presetName}」を削除しますか？`,
      description: 'この操作は元に戻せません。',
      confirmLabel: '削除する',
      variant: 'destructive',
      onConfirm: () => {
        const newPresets = { ...presets };
        delete newPresets[presetName];
        setPresets(newPresets);
        setPresetName('');
        localStorage.setItem('vst_host_audio_presets', JSON.stringify(newPresets));
      },
    });
  };

  if (!isOpen) return null;

  return (
    <Modal title="設定" onClose={onClose}>
        <div className="modal-overlay-base">
      <div className="modal-surface-base w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="modal-header-base modal-header-muted shrink-0">
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <MdSettings className="w-5 h-5 text-primary" />
            設定
          </h2>
          <button
            onClick={onClose}
            aria-label="設定画面を閉じる"
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
          >
            <MdClose className="w-5 h-5" />
          </button>
        </div>

        <div className="modal-body-base scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-600 scrollbar-track-transparent">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full">
          <TabsList className={`grid h-auto w-full grid-cols-2 ${isBeginnerMode && !isSystemTabEnabled ? 'sm:grid-cols-4' : 'sm:grid-cols-5'} mb-4`}>
            <TabsTrigger value="audio">オーディオ</TabsTrigger>
            <TabsTrigger value="sound">音づくり</TabsTrigger>
            <TabsTrigger value="obs">OBS連携</TabsTrigger>
            <TabsTrigger value="appearance">外観</TabsTrigger>
            {(!isBeginnerMode || isSystemTabEnabled) && <TabsTrigger value="system">システム</TabsTrigger>}
          </TabsList>

          {isBeginnerMode && !isSystemTabEnabled && activeTab === 'appearance' && (
            <div className="mb-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 flex items-center justify-between gap-3">
              <p className="text-xs text-amber-600 dark:text-amber-300">
                かんたん表示では、危険なシステム設定を非表示にしています。
              </p>
              <button
                onClick={enableSystemTab}
                className="shrink-0 px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 text-amber-700 dark:text-amber-200 hover:bg-amber-500/20 transition-colors"
              >
                詳細設定を表示
              </button>
            </div>
          )}

          <TabsContent value="audio" className="space-y-4">
            {reviewRequired && <div className="rounded border border-input bg-muted p-3 text-sm space-y-2">
              <p>設定を移行しました。入力・出力先とVSTを確認してから開始してください。</p>
              {importedPlugins.length > 0 && <ul className="max-h-24 overflow-auto break-all">{importedPlugins.map((p, i) => <li key={i}>{p.name} — {p.path}</li>)}</ul>}
              <label className="flex gap-2"><input type="checkbox" checked={migrationConfirmed} onChange={e => setMigrationConfirmed(e.target.checked)} />移行した入力・出力先・VSTを確認しました</label>
            </div>}
            <MicrophonePermissionGuide expanded={!!error && /アクセス.*拒否|0x80070005|access.*denied/i.test(error)} />

            {loading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-primary"></div>
              </div>
            ) : error ? (
              <div className="space-y-4">
                <div className="text-foreground text-sm text-center py-4 bg-destructive/10 rounded-lg">{error}</div>
                <button onClick={() => setError(null)} className="w-full py-2 bg-primary text-primary-foreground rounded-md">設定に戻って再試行</button>
                <button onClick={onClose} className="w-full py-2 bg-muted text-foreground rounded-md border border-input">閉じる</button>
              </div>
            ) : (
              <div className="space-y-6">


                {/* Host Selection */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-muted-foreground">オーディオドライバ</label>
                    <button
                      onClick={() => fetchDevices(true)}
                      className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
                      title="デバイス一覧を再スキャン"
                    >
                      <MdRefresh className="w-3 h-3" />
                      更新
                    </button>
                  </div>
                  <select
                    aria-label="オーディオドライバ"
                    value={selectedHost}
                    onChange={(e) => setSelectedHost(e.target.value)}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all custom-select"
                  >
                    {!selectedHost && <option value="">ドライバを選択してください</option>}
                    {availableHosts.map((host) => (
                      <option key={host} value={host}>{host}</option>
                    ))}
                  </select>
                </div>

                {/* Input Device */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">
                    {isAsio ? "デバイス" : "マイク入力"}
                  </label>
                  <select
                    aria-label="マイク入力・ASIOデバイス"
                    value={selectedInput}
                    onChange={(e) => {
                      setSelectedInput(e.target.value);
                      if (isAsio) setSelectedOutput(e.target.value);
                    }}
                    disabled={filteredInputs.length === 0}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all custom-select disabled:opacity-50"
                  >
                    {filteredInputs.length === 0 && <option value="">対応デバイスなし</option>}
                    {filteredInputs.map((device, i) => (
                      <option key={`${device.name}-${i}`} value={device.name}>{device.name}</option>
                    ))}
                  </select>
                </div>

                {/* Smart Input Channel Selector (ASIO Only) */}
                {isAsio && (
                  <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                    <InputChannelSelector
                      initialChannels={currentInputChannels}
                      maxChannels={activeDevice?.channels}
                      onChannelMapped={(channels) => {
                        onConfigChange({ host: selectedHost, input: selectedInput, output: selectedOutput, sampleRate: selectedSampleRate, bufferSize: selectedBufferSize, inputChannels: channels });
                      }}
                    />
                  </div>
                )}

                {/* Output Device - Hide for ASIO */}
                {!isAsio && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">出力先</label>
                    <select
                    aria-label="出力先"
                      value={selectedOutput}
                      onChange={(e) => setSelectedOutput(e.target.value)}
                      disabled={filteredOutputs.length === 0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all custom-select disabled:opacity-50"
                    >
                      {filteredOutputs.length === 0 && <option value="">対応デバイスなし</option>}
                      {filteredOutputs.map((device, i) => (
                        <option key={`${device.name}-${i}`} value={device.name}>{device.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {isAsio && (
                  <div className="text-xs text-muted-foreground mt-2 p-2 bg-muted rounded border border-border">
                    <p>ASIOモードでは、選択したデバイスが入出力の両方を担当します。</p>
                  </div>
                )}

                {/* Simple / Advanced Mode Toggle */}
                <div className="flex justify-end items-center mb-2">
                  <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-lg">
                    <button
                      onClick={() => setIsAdvancedMode(false)}
                      className={`text-xs px-3 py-1 rounded transition-all ${!isAdvancedMode ? 'bg-background shadow text-primary font-bold' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      かんたん
                    </button>
                    <button
                      onClick={() => setIsAdvancedMode(true)}
                      className={`text-xs px-3 py-1 rounded transition-all ${isAdvancedMode ? 'bg-background shadow text-primary font-bold' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      詳細設定
                    </button>
                  </div>
                </div>

                {/* Simple Mode UI */}
                {!isAdvancedMode ? (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    {/* Latency Profile */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-muted-foreground">パフォーマンス設定 (遅延)</label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: '高速', sub: '低遅延', value: 128, desc: '楽器演奏向け' },
                          { label: '標準', sub: 'バランス', value: 512, desc: '配信・会話向け' },
                          { label: '安定', sub: '高遅延', value: 1024, desc: 'ノイズ対策' },
                        ].map((profile) => {
                          const disabled = canChangeBufferSize && !supportedBufferSizes.includes(profile.value);
                          return (
                            <button
                              key={profile.value}
                              onClick={() => setSelectedBufferSize(profile.value)}
                              disabled={disabled}
                              className={`
                                        flex flex-col items-center justify-center p-2 rounded-lg border transition-all
                                        ${selectedBufferSize === profile.value
                                  ? 'bg-primary/10 border-primary text-primary'
                                  : 'bg-background border-input text-muted-foreground hover:border-primary/50'
                                }
                                        ${disabled ? 'opacity-30 cursor-not-allowed bg-muted' : ''}
                                    `}
                            >
                              <span className="text-sm font-bold">{profile.label}</span>
                              <span className="text-[10px] opacity-80">{profile.sub}</span>
                            </button>
                          )
                        })}
                      </div>
                      <p className="text-[10px] text-muted-foreground text-center">
                        {selectedBufferSize <= 256 ? '※ PCスペックが必要です。ノイズが出る場合は「標準」にしてください。' :
                          selectedBufferSize >= 1024 ? '※ 遅延が大きくなりますが、動作は最も安定します。' :
                            '※ 一般的な配信やWeb会議に最適な設定です。'}
                      </p>
                    </div>

                    {/* Quality Profile */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-muted-foreground">音質設定</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: '標準 (48kHz)', value: 48000, desc: '配信・動画用' },
                          { label: '音楽 (44.1kHz)', value: 44100, desc: 'CD制作など' },
                        ].map((profile) => (
                          <button
                            key={profile.value}
                            onClick={() => setSelectedSampleRate(profile.value)}
                            className={`
                                        flex flex-col items-center justify-center p-2 rounded-lg border transition-all
                                        ${selectedSampleRate === profile.value
                                ? 'bg-primary/10 border-primary text-primary'
                                : 'bg-background border-input text-muted-foreground hover:border-primary/50'
                              }
                                    `}
                          >
                            <span className="text-sm font-bold">{profile.label}</span>
                            <span className="text-[10px] opacity-80">{profile.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Advanced Mode UI (Buffer Size & Sample Rate) */
                  <div className="grid grid-cols-2 gap-4 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
                    {/* Buffer Size */}
                    {canChangeBufferSize ? (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">バッファサイズ</label>
                        <select
                    aria-label="バッファサイズ"
                          value={selectedBufferSize}
                          onChange={(e) => setSelectedBufferSize(Number(e.target.value))}
                          className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all custom-select"
                        >
                          {supportedBufferSizes.map(size => (
                            <option key={size} value={size}>{size} サンプル</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-2 opacity-50 pointer-events-none">
                        <label className="text-sm font-medium text-muted-foreground">バッファサイズ</label>
                        <div className="w-full bg-muted border border-input rounded-md px-3 py-2 text-sm text-muted-foreground">
                          自動 / 固定
                        </div>
                      </div>
                    )}

                    {/* Sample Rate */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-muted-foreground">サンプルレート</label>
                      <select
                    aria-label="サンプルレート"
                        value={selectedSampleRate}
                        onChange={(e) => setSelectedSampleRate(Number(e.target.value))}
                        className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all custom-select"
                      >
                        {sampleRates.map(rate => (
                          <option key={rate} value={rate}>{(rate / 1000).toFixed(1)} kHz</option>
                        ))}
                      </select>
                      {!isAsio && (
                        <div className="text-[10px] text-orange-400/90 flex items-start gap-1.5 bg-orange-900/10 p-1.5 rounded border border-orange-500/20 mt-2">
                          <MdWarning className="w-3 h-3 mt-0.5 shrink-0" />
                          <span>
                            WASAPI共有モードではWindowsのサウンド設定(既定の形式)と同じ値を指定する必要があります。
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}


                {/* Latency Estimate */}
                <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 flex items-center justify-between mt-4">
                  <span>推定レイテンシ（理論値 + OS概算）</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-foreground">{estimatedLatencyMs.toFixed(1)} ms</span>
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${latencyStatus.className}`}>
                      {latencyStatus.label}
                    </span>
                  </div>
                </div>

                {/* Tips Section (Only in Advanced Mode) */}
                {isAdvancedMode && (
                  <details className="text-xs text-muted-foreground bg-muted/50 rounded border border-border mt-2">
                    <summary className="p-2 cursor-pointer hover:bg-muted/80 transition-colors font-medium flex items-center gap-2">
                      <MdLightbulb className="w-4 h-4 text-primary" />
                      詳細設定のヒント
                    </summary>
                    <div className="p-3 pt-0 space-y-2 border-t border-border/50">
                      <div>
                        <strong className="text-primary">バッファサイズ:</strong>
                        <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
                          <li><span className="text-emerald-400">低め (64-256)</span>: レイテンシが小さい。リアルタイム演奏向き。CPU負荷高め。</li>
                          <li><span className="text-yellow-400">中間 (512)</span>: バランス型。配信に推奨。</li>
                          <li><span className="text-orange-400">高め (1024-2048)</span>: 安定性重視。古いPCに推奨。</li>
                        </ul>
                      </div>
                      <div>
                        <strong className="text-primary">サンプルレート:</strong>
                        <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
                          <li><span className="text-cyan-400">44.1 kHz</span>: CD品質。音楽制作の標準。</li>
                          <li><span className="text-cyan-400">48 kHz</span>: 動画/配信の標準。OBS等と相性◎</li>
                          <li><span className="text-cyan-400">96 kHz</span>: 高サンプルレート（環境によっては変化が分かりにくい）。CPU負荷が高い。</li>
                        </ul>
                      </div>
                    </div>
                  </details>
                )}

                {/* Preset Section */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-3">
                  <p className="text-sm text-muted-foreground">ドライバ・入出力・サンプルレート・バッファサイズだけを保存します。読み込みは選択欄を変更し、「保存して開始」で反映します。VST・ノイズ低減・内蔵FXは含みません。</p>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-muted-foreground">入出力プリセット</label>
                    <div className="flex gap-2">
                      <select
                  aria-label="入出力プリセット"
                        className="bg-background border border-input rounded px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                        value={presets[presetName] ? presetName : ''}
                        onChange={(e) => handleLoadPreset(e.target.value)}
                      >
                        <option value="">-- 保存済み設定 --</option>
                        {Object.keys(presets).map(k => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      className="flex-1 bg-background border border-input rounded px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary placeholder:text-muted-foreground"
                      placeholder="入出力プリセット名を入力"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                    />
                    <button
                      onClick={handleSavePreset}
                      disabled={!presetName}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary disabled:opacity-50 transition-colors"
                      title="保存"
                    >
                      <MdSave size={18} />
                    </button>
                    <button
                      onClick={handleDeletePreset}
                      disabled={!presetName || !presets[presetName]}
                      className="p-1.5 rounded hover:bg-card text-muted-foreground hover:text-red-400 disabled:opacity-50 transition-colors"
                      title="削除"
                    >
                      <MdDelete size={18} />
                    </button>
                  </div>
                </div>

              </div>
            )}
          </TabsContent>

          <TabsContent value="sound" className="space-y-4">
            <p className="text-sm text-muted-foreground">ノイズ低減と内蔵ボイスチェーンは、その場で音声処理に反映します。調整後はボイスチェックで聴き比べてください。</p>
            {onOpenVoiceCheck && <button onClick={onOpenVoiceCheck} className="h-10 px-4 rounded-md border border-input text-sm hover:bg-muted">ボイスチェックで聴く</button>}
            {!engineStats && <p role="status" className="text-sm text-muted-foreground">音声処理の現在の設定を確認できるまで、調整はできません。表示が変わらない場合は設定画面を開き直してください。</p>}
            <fieldset disabled={!engineStats || noiseActionBusy} className="min-w-0 space-y-4">
                {/* Built-in Effects */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">内蔵ボイスチェーン</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        外部VSTの追加は不要です。ローカット、軽いコンプ、リミッターをその場で適用します。プリセットと「かかり具合」を調整し、ボイスチェックで聴いて確認してください。
                      </p>
                    </div>
                    <Switch
                      checked={builtInEffectsEnabled}
                      onCheckedChange={(checked) => {
                        setBuiltInEffectsEnabled(checked);
                        applyBuiltInEffects({ active: checked });
                      }}
                      aria-label="内蔵ボイスチェーン"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ['broadcast', '配信'],
                      ['warm', '低め'],
                      ['bright', '明瞭'],
                    ] as Array<[BuiltInEffectsPreset, string]>).map(([preset, label]) => (
                      <button
                        key={preset}
                        onClick={() => {
                          setBuiltInEffectsPreset(preset);
                          applyBuiltInEffects({ active: true, preset });
                        }}
                        className={`px-3 py-2 rounded-md border text-xs font-bold transition-colors ${
                          builtInEffectsPreset === preset
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-input bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">かかり具合</span>
                      <span className="font-mono text-foreground">{builtInEffectsAmount}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={builtInEffectsAmount}
                      onChange={(e) => setBuiltInEffectsAmount(Number(e.target.value))}
                      onMouseUp={() => applyBuiltInEffects({ amount: builtInEffectsAmount })}
                      onKeyUp={() => applyBuiltInEffects({ amount: builtInEffectsAmount })}
                      className="w-full accent-primary"
                      aria-label="内蔵ボイスチェーンのかかり具合"
                    />
                  </div>
                </div>

                {/* Noise reduction */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">ノイズ低減</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        機械学習ベース（RNNoise 系）で、ファン・空調などの持続ノイズを低減します。変更はその場で音声処理に反映します。
                      </p>
                    </div>
                    <Switch
                      checked={!!engineStats?.noiseReductionEnabled}
                      onCheckedChange={(checked) => applyNoiseControlConfig({ active: checked })}
                      aria-label="ノイズ低減"
                    />
                  </div>

                  <div className="text-xs rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-1.5 text-amber-800 dark:text-amber-200">
                    <p>
                      <span className="font-bold">効きやすい:</span> ファン・空調・電源ハムなどの持続的なノイズ
                    </p>
                    <p>
                      <span className="font-bold">効きにくい:</span> 周囲の会話・BGM・突発音（完全には消えません）
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      効果は耳で確認するのがいちばん確実です。
                      {onOpenVoiceCheck ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onOpenVoiceCheck();
                            }}
                            className="underline underline-offset-2 hover:text-foreground font-medium"
                          >
                            ボイスチェックで加工前後を比較
                          </button>
                        </>
                      ) : (
                        ' マスターバーのボイスチェックで加工前後を比較できます。'
                      )}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {([
                      ['smart', '学習'],
                      ['venue', '会場'],
                      ['low', '弱'],
                      ['high', '強'],
                    ] as Array<[NoiseControlMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        onClick={() => {
                          setNoiseMode(mode);
                          applyNoiseControlConfig({ mode });
                        }}
                        className={`px-3 py-2 rounded-md border text-xs font-bold transition-colors ${
                          noiseMode === mode
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-input bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {noiseMode === 'smart' && (
                      <>学習: 3秒間の定常ノイズをプロファイル化し、抑制量を自動調整します（学習中は話さないでください）。</>
                    )}
                    {noiseMode === 'venue' && (
                      <>会場: 騒がしい環境向け。近接マイク前提で、声があるときは抑制を弱めます。会話やBGMを完全に消すものではありません。</>
                    )}
                    {noiseMode === 'low' && (
                      <>弱: 持続ノイズを軽めに低減します。声の欠けが少なめです。</>
                    )}
                    {noiseMode === 'high' && (
                      <>強: 持続ノイズを強めに低減します。声の欠けやロボ声に注意してください。</>
                    )}
                  </p>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">抑制強度</span>
                      <span className="font-mono text-foreground">{noiseStrength}%</span>
                    </div>
                    <input
                      type="range"
                      min={25}
                      max={125}
                      step={5}
                      value={noiseStrength}
                      onChange={(e) => {
                        noiseStrengthEditing.current = true;
                        setNoiseStrength(Number(e.target.value));
                      }}
                      onPointerUp={(e) => commitNoiseStrength(e.currentTarget.value)}
                      onKeyUp={(e) => commitNoiseStrength(e.currentTarget.value)}
                      onBlur={(e) => commitNoiseStrength(e.currentTarget.value)}
                      className="w-full accent-primary"
                      aria-label="ノイズ低減の抑制強度"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                    <button
                      onClick={handleStartNoiseLearning}
                      disabled={noiseActionBusy}
                      className="px-3 py-2 rounded-md border border-input bg-background text-foreground hover:border-primary/50 disabled:opacity-50 transition-colors"
                    >
                      3秒学習
                    </button>
                    <button
                      onClick={handleCancelNoiseLearning}
                      className="px-3 py-2 rounded-md border border-input bg-background text-muted-foreground hover:text-foreground transition-colors"
                    >
                      学習を中止
                    </button>
                    <div className="px-3 py-2 rounded-md border border-input bg-background text-muted-foreground">
                      {engineStats?.noiseLearningState === 'capturing'
                        ? `学習中 ${Math.round((engineStats.noiseLearningProgress ?? 0) * 100)}%`
                        : engineStats?.noiseLearningState === 'invalid'
                          ? '学習を完了できませんでした。入力を確認して再試行してください'
                        : engineStats?.noiseProfileAvailable
                          ? `学習済み RMS ${Math.round((engineStats.noiseProfileRms ?? 0) * 1000) / 1000}`
                          : '未学習'}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2">
                    <div>
                      <Label className="text-xs font-bold text-foreground">声を守る</Label>
                      <p className="text-[11px] text-muted-foreground mt-0.5">入力の音量を目安に抑制を弱めます。声とノイズを完全に判別する機能ではありません。</p>
                    </div>
                    <Switch
                      checked={noiseVoiceGuard}
                      onCheckedChange={(checked) => {
                        setNoiseVoiceGuard(checked);
                        applyNoiseControlConfig({ voiceGuard: checked });
                      }}
                      aria-label="声を守る"
                    />
                  </div>
                </div>

            </fieldset>
          </TabsContent>

          <TabsContent value="obs" className="space-y-4">
            <ObsConnectionSettings
              showConfirm={showConfirm}
              onClose={onClose}
              onOpenOBSGuide={onOpenOBSGuide}
              onOpenTroubleshoot={onOpenTroubleshoot}
            />
          </TabsContent>

          <TabsContent value="appearance" className="space-y-6">
            <MigrationPanel />
            <ShortcutsPanel />
            <UpdatePreferences />
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2 text-foreground">
                  <MdPalette className="w-4 h-4 text-primary" /> テーマ選択
                </h3>
                <RadioGroup value={theme} onValueChange={(v) => setTheme(v as any)} className="space-y-3">
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-all cursor-pointer" onClick={() => setTheme('light')}>
                    <RadioGroupItem value="light" id="theme-light" />
                    <Label htmlFor="theme-light" className="cursor-pointer flex-1">
                      <span className="font-bold block">ライト</span>
                      <span className="text-xs text-muted-foreground">明るく清潔感のあるデザイン (OS設定に連動)</span>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-all cursor-pointer" onClick={() => setTheme('dark')}>
                    <RadioGroupItem value="dark" id="theme-dark" />
                    <Label htmlFor="theme-dark" className="cursor-pointer flex-1">
                      <span className="font-bold block">ダーク</span>
                      <span className="text-xs text-muted-foreground">目に優しい、クリエイティブ作業向け</span>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 border border-primary/30 bg-primary/5 p-3 rounded-lg hover:bg-primary/10 transition-all cursor-pointer" onClick={() => setTheme('gaming')}>
                    <RadioGroupItem value="gaming" id="theme-gaming" className="text-cyan-400 border-cyan-400" />
                    <Label htmlFor="theme-gaming" className="cursor-pointer flex-1">
                      <span className="font-bold block text-primary">ゲーミング</span>
                      <span className="text-xs text-muted-foreground">没入感を高めるハイコントラスト & グローエフェクト</span>
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-md border border-border">
                <p>※ テーマ設定は自動的に保存され、再起動後も維持されます。</p>
                <p className="mt-1">※ ゲーミングモードでは、パフォーマンスへの影響はありませんが、視覚的な演出が強化されます。</p>
              </div>
            </div>
          </TabsContent>

          {(!isBeginnerMode || isSystemTabEnabled) && (
          <TabsContent value="system" className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">

            {/* App Info Card */}
            {/* App Info Card */}
            <div className="p-6 bg-muted/20 border border-border rounded-xl flex flex-col items-center justify-center space-y-3">
              <img src="/auralyn_icon.png" alt="Auralyn Icon" className="w-16 h-16 rounded-full shadow-sm object-contain" />
              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground">{APP_INFO.NAME}</h3>
                <p className="text-xs text-muted-foreground">バージョン {APP_INFO.VERSION}</p>
              </div>

              <div className="flex gap-4 pt-2">
                <button onClick={() => openUrl('https://www.kuro7983.com/apps/auralyn')} className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1">
                  <MdLanguage className="w-3.5 h-3.5" />
                  公式サイト
                </button>
                {onOpenLicense && (
                  <button onClick={onOpenLicense} className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1">
                    アプリ情報 / ライセンス
                  </button>
                )}
                <button onClick={() => openUrl('https://ofuse.me/o?uid=149216')} className="text-xs text-muted-foreground hover:text-pink-400 transition-colors flex items-center gap-1">
                  <MdFavorite className="w-3 h-3" />
                  開発を支援
                </button>
              </div>
            </div>


            {/* Startup Settings */}
            <div className="p-4 bg-muted/20 border border-border rounded-xl flex items-center justify-between">
              <div>
                <label className="text-sm font-bold text-foreground block">Windows起動時に自動実行</label>
                <div className="text-xs text-muted-foreground mt-0.5">{autostartReason ?? 'ログイン時にアプリを自動的に起動します（前回設定がある場合、音声処理も開始します）。Windows側でも有効になっている必要があります。'}</div>
              </div>
              <div className="flex items-center">
                <Switch
                  aria-label="Windows起動時に自動起動"
                    checked={autostartEnabled}
                  onCheckedChange={async (checked) => {
                    setLoading(true);
                    try {
                      await autostartApi.setEnabled(checked);
                      const s = await autostartApi.getStatus();
                      setAutostartEnabled(s.enabled);
                      setAutostartCanChange(s.canChange);
                      setAutostartReason(s.reason ?? null);
                      if (s.enabled === checked) {
                        toast.success(checked ? "自動起動を有効にしました" : "自動起動を無効にしました");
                      }
                    } catch (e) {
                      console.error(e);
                      toast.error("設定の変更に失敗しました");
                      setAutostartCanChange(false);
                      setAutostartReason('自動起動の変更結果を確認できませんでした。設定画面を開き直してください。');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading || !autostartCanChange}
                />
              </div>
            </div>

            {/* Engine Tuning */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdSettings className="w-4 h-4 text-primary" />
                オーディオエンジン最適化
              </h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">CPUアフィニティ固定</div>
                    <div className="text-xs text-muted-foreground mt-0.5">有効時、エンジンを限定コアで実行します。通常は無効推奨です。</div>
                  </div>
                  <Switch
                    aria-label="CPUアフィニティ固定"
                    checked={engineTuningConfig.enableAffinityPinning}
                    onCheckedChange={(checked) =>
                      setEngineTuningConfig((prev) => ({ ...prev, enableAffinityPinning: checked }))
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">アフィニティマスク（任意）</label>
                  <input
                    aria-label="アフィニティマスク"
                    type="text"
                    value={engineTuningConfig.affinityMask ?? ''}
                    onChange={(e) =>
                      setEngineTuningConfig((prev) => ({ ...prev, affinityMask: e.target.value || null }))
                    }
                    placeholder="例: 0xff または 15"
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    disabled={systemSaving}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">リアルタイム優先度（危険）</div>
                    <div className="text-xs text-muted-foreground mt-0.5">有効化するとOS全体の応答性が低下する場合があります。</div>
                  </div>
                  <Switch
                    aria-label="リアルタイム優先度"
                    checked={engineTuningConfig.enableRealtimePriority}
                    onCheckedChange={(checked) =>
                      handleDangerousToggle(
                        'enableRealtimePriority',
                        checked,
                        'リアルタイム優先度',
                        '誤設定するとマウスやキーボード操作まで重くなる可能性があります。'
                      )
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">時間最優先オーディオスレッド（危険）</div>
                    <div className="text-xs text-muted-foreground mt-0.5">有効化時はプラグインの不具合が露出しやすくなります。</div>
                  </div>
                  <Switch
                    aria-label="時間最優先オーディオスレッド"
                    checked={engineTuningConfig.enableTimeCriticalAudioThreads}
                    onCheckedChange={(checked) =>
                      handleDangerousToggle(
                        'enableTimeCriticalAudioThreads',
                        checked,
                        '時間最優先オーディオスレッド',
                        '一部プラグインが不安定化し、音切れやクラッシュの原因になる場合があります。'
                      )
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border">
                  変更内容は次回の「保存して開始」または「エンジン再起動」実行時に反映されます。
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={saveEngineTuningConfig}
                    disabled={systemSaving}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-all"
                  >
                    {systemSaving ? '保存中...' : 'システム設定を保存'}
                  </button>
                  <button
                    onClick={refreshEngineRuntimeStats}
                    disabled={statsLoading}
                    className="px-3 py-1.5 text-xs border border-input rounded-md text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-50 transition-all flex items-center gap-1"
                  >
                    <MdRefresh className="w-3 h-3" />
                    {statsLoading ? '更新中...' : '統計を更新'}
                  </button>
                </div>

                <div className="grid grid-cols-3 md:grid-cols-9 gap-2 text-xs">
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">読み込み済み</div>
                    <div className="text-foreground font-mono mt-1">{engineStats?.activePluginCount ?? '-'}</div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">有効中</div>
                    <div className="text-foreground font-mono mt-1">{engineStats?.enabledPluginCount ?? '-'}</div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">解放待ち</div>
                    <div className="text-foreground font-mono mt-1">{engineStats?.pendingUnloadCount ?? '-'}</div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">無効化ライブラリ</div>
                    <div className="text-foreground font-mono mt-1">{engineStats?.burnedLibraryCount ?? '-'}</div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">最大ジッター</div>
                    <div className="text-foreground font-mono mt-1">
                      {engineStats ? `${(engineStats.maxJitterUs / 1000).toFixed(2)}ms` : '-'}
                    </div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">グリッチ回数</div>
                    <div className="text-foreground font-mono mt-1">{engineStats?.glitchCount ?? '-'}</div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">NR遅延</div>
                    <div className="text-foreground font-mono mt-1">
                      {engineStats ? `${engineStats.noiseReductionLatencyMs.toFixed(2)}ms` : '-'}
                    </div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">VST+ノイズ遅延</div>
                    <div className="text-foreground font-mono mt-1">
                      {engineStats ? `${engineStats.totalChainLatencyMs.toFixed(2)}ms` : '-'}
                    </div>
                  </div>
                  <div className="p-2 bg-background border border-input rounded">
                    <div className="text-muted-foreground">ノイズ抑制</div>
                    <div className="text-foreground font-mono mt-1">
                      {engineStats
                        ? (engineStats.noiseReductionEnabled
                          ? `${engineStats.noiseReductionMode === 'high' ? '強' : engineStats.noiseReductionMode === 'smart' ? '学習' : engineStats.noiseReductionMode === 'venue' ? '会場' : '弱'}${engineStats.noiseReductionActive ? '（動作中）' : '（待機）'}`
                          : 'OFF')
                        : '-'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Plugin Management */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdExtension className="w-4 h-4 text-primary" />
                プラグイン管理
              </h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">ブラックリストの初期化</div>
                    <div className="text-xs text-muted-foreground mt-0.5">読み込みエラーで除外されたプラグイン設定をリセットします。</div>
                  </div>
                  <button
                    onClick={() => {
                      showConfirm({
                        title: 'ブラックリストを初期化しますか？',
                        description: '次回起動時またはスキャン時にすべてのプラグインが再チェックされます。',
                        confirmLabel: '初期化する',
                        variant: 'destructive',
                        onConfirm: async () => {
                          setLoading(true);
                          try {
                            await audioApi.clearBlacklist();
                            toast.success("ブラックリストをクリアしました");
                          } catch (e) {
                            console.error(e);
                            toast.error("初期化に失敗しました");
                          } finally {
                            setLoading(false);
                          }
                        },
                      });
                    }}
                    className="px-3 py-1.5 text-xs text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/20 rounded-md transition-all whitespace-nowrap"
                  >
                    クリア
                  </button>
                </div>
              </div>
            </div>

            {/* Factory Reset */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdRefresh className="w-4 h-4 text-destructive" />
                データリセット
              </h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">すべての設定を初期化</div>
                    <div className="text-xs text-muted-foreground mt-0.5">オーディオ設定、プリセット、外観設定、チュートリアル状態などすべてを初期状態に戻します。</div>
                  </div>
                  <button
                    onClick={() => {
                      showConfirm({
                        title: 'すべての設定を初期化しますか？',
                        description: 'オーディオ設定、保存したプリセット、外観設定、チュートリアル状態など全てが削除されます。この操作は取り消せません。アプリは自動的にリロードされます。',
                        confirmLabel: '初期化してリロード',
                        variant: 'destructive',
                        onConfirm: async () => {
                          try {
                            await audioApi.stop().catch(() => {});
                            // Clear all vst_host_ prefixed localStorage keys
                            const keysToRemove: string[] = [];
                            for (let i = 0; i < localStorage.length; i++) {
                              const key = localStorage.key(i);
                              if (key && key.startsWith('vst_host_')) {
                                keysToRemove.push(key);
                              }
                            }
                            keysToRemove.forEach(key => localStorage.removeItem(key));
                            // Reload the app
                            window.location.reload();
                          } catch (e) {
                            console.error("Reset failed:", e);
                            toast.error("初期化に失敗しました");
                          }
                        },
                      });
                    }}
                    className="px-3 py-1.5 text-xs text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/20 rounded-md transition-all whitespace-nowrap"
                  >
                    リセット
                  </button>
                </div>
              </div>
            </div>
          </TabsContent>
          )}
        </Tabs>
        </div>
        {activeTab === 'audio' && !loading && !error && (
          <div className="modal-footer-base shrink-0">
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={handleRestart}
                  disabled={loading || (reviewRequired && !migrationConfirmed)}
                  className="flex-1 py-2 bg-muted hover:bg-destructive/10 text-muted-foreground hover:text-destructive border border-input hover:border-destructive/30 rounded-md transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  エンジン再起動
                </button>
                <button
                  onClick={handleSave}
                  disabled={loading || (reviewRequired && !migrationConfirmed)}
                  className="flex-[2] py-2 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-md transition-all shadow-sm active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  保存して開始
                </button>
              </div>

              {onOpenWizard && (
                <button
                  onClick={() => {
                    onClose();
                    onOpenWizard();
                  }}
                  className="w-full py-2 text-xs text-muted-foreground hover:text-primary border border-border hover:border-primary/30 rounded-lg transition-all flex items-center justify-center gap-2"
                >
                  <MdExtension className="w-3 h-3" />
                  セットアップウィザードを再実行
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmLabel={confirmDialog.confirmLabel}
        variant={confirmDialog.variant}
        onConfirm={() => {
          setConfirmDialog(prev => ({ ...prev, isOpen: false }));
          confirmDialog.onConfirm();
        }}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
        </Modal>
  );
};

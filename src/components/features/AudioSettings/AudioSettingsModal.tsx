import { InfoPopover } from '@/components/ui/InfoPopover';
import { PeakProtectionPanel } from './PeakProtectionPanel';
import { NoiseMeasurementPanel } from './NoiseMeasurementPanel';
import { LiveOutputPanel } from './LiveOutputPanel';
import { MonitorTrial } from './MonitorTrial';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSingingDraft, type SingingDraft } from '../../../hooks/useSingingDraft';
import { SingingControls } from './SingingControls';
import { LatencyDetails } from '@/components/layout/LatencyDetails';
import { LiveModeControls } from './LiveModeControls';
import { useLiveModes, type LiveModesModel } from '@/hooks/useLiveModes';
import { Modal } from '../../ui/modal';
import { listen } from '@tauri-apps/api/event';
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
import { DisplayPurposeSelector } from './DisplayPurposeSelector';
import { REVIEW_KEY } from '@/api/migration';
import { useAudioDeviceSelection } from './useAudioDeviceSelection';

interface AudioSettingsModalProps {
  liveModel?: LiveModesModel;
  singingModel?: SingingDraft;
  onPreviewSinging?: () => void;
  onSaveSingingProfile?: () => void;
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
  liveModel: providedLive,
  singingModel: providedSinging, onPreviewSinging, onSaveSingingProfile,
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
    const t = useMessages();
  const localSinging = useSingingDraft();
  const localLive = useLiveModes();
  const singingModel = providedSinging ?? localSinging;
  const getBeginnerMode = () => localStorage.getItem('vst_host_beginner_mode') !== 'false';
  const { theme, setTheme } = useTheme();
  const [isApplying, setLoading] = useState(false);
  const reviewRequired = localStorage.getItem(REVIEW_KEY) === 'true';
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const importedPlugins = useMemo(() => {
    try { return (JSON.parse(localStorage.getItem('vst_host_session_plugins') ?? '[]') as { name: string; path: string }[]); }
    catch { return []; }
  }, []);
  const [error, setError] = useState<SettingsNotice | null>(null);
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
  const [activeTab, setActiveTab] = useState<'audio' | 'sound' | 'obs' | 'appearance' | 'system' | 'shortcuts'>(initialTab);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [isBeginnerMode, setIsBeginnerMode] = useState(getBeginnerMode);
  // Persist Advanced Mode selection
  useEffect(() => {
    localStorage.setItem('vst_host_settings_advanced', String(isAdvancedMode));
  }, [isAdvancedMode]);

  useEffect(() => {
    const syncBeginnerMode = (event?: Event) => {
      const next = (event as CustomEvent<boolean> | undefined)?.detail;
      const beginnerMode = typeof next === 'boolean' ? next : getBeginnerMode();
      setIsBeginnerMode(beginnerMode);
    };

    window.addEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
    window.addEventListener('storage', syncBeginnerMode);
    return () => {
      window.removeEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
      window.removeEventListener('storage', syncBeginnerMode);
    };
  }, []);

  const settingsBody = useRef<HTMLDivElement>(null);
  const soundStart = useRef<HTMLHeadingElement>(null);
  useEffect(() => { settingsBody.current?.scrollTo?.({ top: 0 }); }, [activeTab]);
  useEffect(() => {
    if (isOpen && initialTab === 'sound') {
      soundStart.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [isOpen, initialTab]);

  // OBS State
  // Preset State
  const [presets, setPresets] = useState<Record<string, any>>({});
  const [presetName, setPresetName] = useState('');

  // Autostart State
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartCanChange, setAutostartCanChange] = useState(false);
  const [autostartReason, setAutostartReason] = useState<SettingsNotice | null>(null);
  const [engineTuningConfig, setEngineTuningConfig] = useState<EngineTuningConfig>({
    enableAffinityPinning: false,
    affinityMask: null,
    enableRealtimePriority: false,
    enableTimeCriticalAudioThreads: false,
  });
  const [engineStats, setEngineStats] = useState<EngineRuntimeStats | null>(null);
  const statsGeneration = useRef(0);
  useEffect(() => {
    if (!isOpen) return;
    const invalidate = () => {
      statsGeneration.current++;
      setEngineStats(current => current ? { ...current, latencyMetadata: current.latencyMetadata ? { ...current.latencyMetadata, streamRunning: false } : undefined } : null);
    };
    const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'].map(event => listen(event, invalidate));
    void Promise.all(subscriptions).catch(() => {});
    return () => { statsGeneration.current++; subscriptions.forEach(item => void item.then(stop => stop()).catch(() => {})); };
  }, [isOpen]);
  const [systemSaving, setSystemSaving] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [noiseMode, setNoiseMode] = useState<NoiseControlMode>('smart');
  const [noiseMeasurementOpen, setNoiseMeasurementOpen] = useState(false);
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
    if (Number.isFinite(engineStats.builtInEffectsAmount)) setBuiltInEffectsAmount(Math.round(engineStats.builtInEffectsAmount * 100));
    if (['broadcast', 'warm', 'bright', 'singing'].includes(engineStats.builtInEffectsPreset)) {
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
      // engineStatsの同期effectが古い値で表示を戻さないよう、通知された設定をまとめて統計値へも反映する。
      const patch: Partial<EngineRuntimeStats> = {};
      if (detail.noiseControl) {
        const nc = detail.noiseControl;
        if (['low', 'high', 'smart', 'venue'].includes(nc.mode)) {
          setNoiseMode(nc.mode as NoiseControlMode);
          patch.noiseReductionMode = nc.mode;
        }
        setNoiseStrength(Math.round(nc.strength * 100));
        setNoiseVoiceGuard(nc.voiceGuard);
        Object.assign(patch, {
          noiseReductionEnabled: nc.enabled,
          noiseReductionActive: nc.enabled,
          noiseControlStrength: nc.strength,
          noiseVoiceGuard: nc.voiceGuard,
        });
      }
      if (detail.builtinFx) {
        const fx = detail.builtinFx;
        setBuiltInEffectsEnabled(fx.enabled);
        patch.builtInEffectsEnabled = fx.enabled;
        if (['broadcast', 'warm', 'bright', 'singing'].includes(fx.preset)) {
          setBuiltInEffectsPreset(fx.preset as BuiltInEffectsPreset);
          patch.builtInEffectsPreset = fx.preset;
        }
        if (Number.isFinite(fx.amount)) {
          setBuiltInEffectsAmount(Math.round(fx.amount * 100));
          patch.builtInEffectsAmount = fx.amount;
        }
      }
      setEngineStats(current => current ? { ...current, ...patch } : current);
    };
    window.addEventListener('profile-fx-applied', handler);
    return () => window.removeEventListener('profile-fx-applied', handler);
  }, []);

  // Confirm dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: SettingsNotice;
    description?: SettingsNotice;
    confirmLabel?: SettingsNotice;
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
    const generation = statsGeneration.current;
    if (isOpen) {
      autostartApi.getStatus().then(s => {
        setAutostartEnabled(s.enabled);
        setAutostartCanChange(s.canChange);
        setAutostartReason(s.reason ?? null);
      }).catch(() => {
        setAutostartCanChange(false);
        setAutostartReason(notice('settings.AudioSettingsModal.000'));
      });
      audioApi.getEngineTuningConfig()
        .then((config) => { if (config && typeof config === 'object') setEngineTuningConfig(config); })
        .catch((e) => {
          console.error('Failed to load engine tuning config', e);
        });
      audioApi.getEngineRuntimeStats()
        .then(stats => { if (generation === statsGeneration.current) setEngineStats(stats); })
        .catch((e) => {
          console.error('Failed to load engine runtime stats', e);
        });
    }
  }, [isOpen, currentSampleRate, currentBufferSize]);

  const refreshEngineRuntimeStats = async () => {
    const generation = statsGeneration.current;
    setStatsLoading(true);
    try {
      const stats = await audioApi.getEngineRuntimeStats();
      if (generation === statsGeneration.current) setEngineStats(stats);
    } catch (e) {
      console.error('Failed to refresh engine runtime stats', e);
      toast.error(t('settings.AudioSettingsModal.001'));
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
      const generation = statsGeneration.current;
      const stats = await audioApi.getEngineRuntimeStats();
      if (generation === statsGeneration.current) setEngineStats(stats);
      toast.success(active ? t('settings.AudioSettingsModal.002') : t('settings.AudioSettingsModal.003'));
    } catch (e) {
      console.error('Failed to apply noise control config', e);
      toast.error(t('settings.AudioSettingsModal.004'));
    } finally {
      setNoiseActionBusy(false);
    }
  };

  const commitNoiseStrength = (value: string) => {
    if (!noiseStrengthEditing.current) return;
    noiseStrengthEditing.current = false;
    void applyNoiseControlConfig({ strength: Number(value) });
  };

  const applyBuiltInEffects = async (next?: Partial<{ active: boolean; preset: BuiltInEffectsPreset; amount: number }>) => {
    if (singingModel.snapshot && !next?.preset && next?.amount === undefined) {
      await singingModel.setAppliedActive(next?.active ?? singingModel.snapshot.config.active);
      return;
    }
    const active = next?.active ?? singingModel.snapshot?.config.active ?? builtInEffectsEnabled;
    const preset = next?.preset ?? singingModel.snapshot?.config.preset ?? builtInEffectsPreset;
    const amount = next?.amount ?? (singingModel.snapshot ? singingModel.snapshot.config.amount * 100 : builtInEffectsAmount);
    try {
      await audioApi.setBuiltInEffects({
        active,
        preset,
        amount: Math.max(0, Math.min(100, amount)) / 100,
      });
      const generation = statsGeneration.current;
      const stats = await audioApi.getEngineRuntimeStats();
      if (generation === statsGeneration.current) setEngineStats(stats);
      await singingModel.refresh();
      toast.success(active ? t('settings.AudioSettingsModal.008') : t('settings.AudioSettingsModal.009'));
    } catch (e) {
      console.error('Failed to apply built-in effects', e);
      toast.error(t('settings.AudioSettingsModal.010'));
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
      toast.success(t('settings.AudioSettingsModal.011'));
    } catch (e) {
      console.error('Failed to save engine tuning config', e);
      toast.error(t('settings.AudioSettingsModal.012'));
    } finally {
      setSystemSaving(false);
    }
  };



  const handleDangerousToggle = (
    key: 'enableRealtimePriority' | 'enableTimeCriticalAudioThreads',
    checked: boolean,
    title: SettingsNotice,
    warning: SettingsNotice
  ) => {
    if (!checked) {
      setEngineTuningConfig((prev) => ({ ...prev, [key]: false }));
      return;
    }

    showConfirm({
      title: notice('settings.AudioSettingsModal.013', { arg0: title }),
      description: notice('settings.warning', { warning, hint: isBeginnerMode ? notice('settings.AudioSettingsModal.015') : '' }),
      confirmLabel: notice('settings.AudioSettingsModal.016'),
      variant: 'destructive',
      onConfirm: () => {
        setEngineTuningConfig((prev) => ({ ...prev, [key]: true }));
      },
    });
  };

  const selectedBufferMs = Number.isFinite(selectedBufferSize) && selectedBufferSize > 0 && Number.isFinite(selectedSampleRate) && selectedSampleRate > 0
    ? selectedBufferSize / selectedSampleRate * 1000 : null;

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
      setError(notice('settings.AudioSettingsModal.017', { arg0: String(err) }));
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
        toast.info(t('settings.AudioSettingsModal.018'));
        await onEngineRestarted();
        toast.success(t('settings.AudioSettingsModal.019'));
      }
      onClose();
      // Optional: formatting toast success
    } catch (err) {
      setActiveTab('audio');
      console.error('Failed to restart engine:', err);
      setError(notice('settings.AudioSettingsModal.020', { arg0: String(err) }));
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = () => {
    showConfirm({
      title: notice('settings.AudioSettingsModal.021'),
      description: notice('settings.AudioSettingsModal.022'),
      confirmLabel: notice('settings.AudioSettingsModal.023'),
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
      title: notice('settings.AudioSettingsModal.024', { arg0: presetName }),
      description: notice('settings.AudioSettingsModal.025'),
      confirmLabel: notice('settings.AudioSettingsModal.026'),
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
    <Modal title={t('common.settings')} onClose={onClose} dismissible={!isApplying} onEscapeKeyDown={event => { if (capturingShortcut) event.preventDefault(); }} initialFocusRef={initialTab === 'sound' ? soundStart : undefined}>
        <div className="fixed inset-0 z-[100] flex justify-end bg-background/80 backdrop-blur-sm">
      <div className="h-full w-full max-w-5xl flex flex-col overflow-hidden border-l border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 shrink-0">
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <MdSettings className="w-5 h-5 text-primary" />
            {t('common.settings')}
          </h2>
          <button
            onClick={onClose}
            disabled={isApplying}
            aria-label={t('settings.close')}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
          >
            <MdClose className="w-5 h-5" />
          </button>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} orientation="vertical" className="flex min-h-0 flex-1">
          <TabsList aria-label={t('common.settings')} className="h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none border-r border-border p-2 overflow-y-auto">
            <TabsTrigger className="justify-start" value="audio">{t('settings.audio')}</TabsTrigger>
            <TabsTrigger className="justify-start" value="sound">{t('settings.sound')}</TabsTrigger>
            <TabsTrigger className="justify-start" value="obs">{t('settings.obs')}</TabsTrigger>
            <TabsTrigger className="justify-start" value="appearance">{t('settings.appearance')}</TabsTrigger>
            <TabsTrigger className="justify-start" value="shortcuts">{t('settings.shortcuts')}</TabsTrigger>
            <TabsTrigger className="justify-start" value="system">{t('settings.system')}</TabsTrigger>
          </TabsList>
          <div ref={settingsBody} className="min-w-0 flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent">
          <TabsContent value="audio" className="space-y-4">
            {reviewRequired && <div className="rounded border border-input bg-muted p-3 text-sm space-y-2">
              <p>{t('settings.AudioSettingsModal.029')}</p>
              {importedPlugins.length > 0 && <ul className="max-h-24 overflow-auto break-all">{importedPlugins.map((p, i) => <li key={i}>{p.name} — {p.path}</li>)}</ul>}
              <label className="flex gap-2"><input type="checkbox" checked={migrationConfirmed} onChange={e => setMigrationConfirmed(e.target.checked)} />{t('settings.AudioSettingsModal.030')}</label>
            </div>}
            <MicrophonePermissionGuide expanded={!!error && /アクセス.*拒否|0x80070005|access.*denied/i.test(renderNotice(t, error))} />

            {loading ? (
              <div role="status" className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                {t('common.loading')}
              </div>
            ) : error ? (
              <div className="space-y-4">
                <div className="text-foreground text-sm text-center py-4 bg-destructive/10 rounded-lg">{renderNotice(t, error)}</div>
                <button onClick={() => setError(null)} className="w-full py-2 bg-primary text-primary-foreground rounded-md">{t('settings.AudioSettingsModal.031')}</button>
                <button onClick={onClose} className="w-full py-2 bg-muted text-foreground rounded-md border border-input">{t('common.close')}</button>
              </div>
            ) : (
              <div className="space-y-6">


                {/* Host Selection */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.032')}</label>
                    <button
                      onClick={() => fetchDevices(true)}
                      className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
                      title={t('settings.AudioSettingsModal.033')}
                    >
                      <MdRefresh className="w-3 h-3" />
                      {t('settings.AudioSettingsModal.034')}</button>
                  </div>
                  <select
                    aria-label={t('settings.AudioSettingsModal.035')}
                    value={selectedHost}
                    onChange={(e) => setSelectedHost(e.target.value)}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select"
                  >
                    {!selectedHost && <option value="">{t('settings.AudioSettingsModal.036')}</option>}
                    {availableHosts.map((host) => (
                      <option key={host} value={host}>{host}</option>
                    ))}
                  </select>
                </div>

                {/* Input Device */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">
                    {isAsio ? t('settings.AudioSettingsModal.037') : t('settings.AudioSettingsModal.038')}
                  </label>
                  <select
                    aria-label={t('settings.AudioSettingsModal.039')}
                    value={selectedInput}
                    onChange={(e) => {
                      setSelectedInput(e.target.value);
                      if (isAsio) setSelectedOutput(e.target.value);
                    }}
                    disabled={filteredInputs.length === 0}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select disabled:opacity-50"
                  >
                    {filteredInputs.length === 0 && <option value="">{t('settings.AudioSettingsModal.040')}</option>}
                    {filteredInputs.map((device, i) => (
                      <option key={`${device.name}-${i}`} value={device.name}>{device.name}</option>
                    ))}
                  </select>
                </div>

                {/* Smart Input Channel Selector (ASIO Only) */}
                {isAsio && (
                  <div>
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
                    <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.041')}</label>
                    <select
                    aria-label={t('settings.AudioSettingsModal.042')}
                      value={selectedOutput}
                      onChange={(e) => setSelectedOutput(e.target.value)}
                      disabled={filteredOutputs.length === 0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select disabled:opacity-50"
                    >
                      {filteredOutputs.length === 0 && <option value="">{t('settings.AudioSettingsModal.043')}</option>}
                      {filteredOutputs.map((device, i) => (
                        <option key={`${device.name}-${i}`} value={device.name}>{device.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {isAsio && (
                  <div className="text-xs text-muted-foreground mt-2 p-2 bg-muted rounded border border-border">
                    <p>{t('settings.AudioSettingsModal.044')}</p>
                  </div>
                )}

                {/* Simple / Advanced Mode Toggle */}
                <div className="flex justify-end items-center mb-2">
                  <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-lg">
                    <button
                      onClick={() => setIsAdvancedMode(false)}
                      className={`text-xs px-3 py-1 rounded transition ${!isAdvancedMode ? 'bg-background shadow text-primary font-bold' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {t('settings.AudioSettingsModal.045')}</button>
                    <button
                      onClick={() => setIsAdvancedMode(true)}
                      className={`text-xs px-3 py-1 rounded transition ${isAdvancedMode ? 'bg-background shadow text-primary font-bold' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {t('settings.AudioSettingsModal.046')}</button>
                  </div>
                </div>

                {/* Simple Mode UI */}
                {!isAdvancedMode ? (
                  <div className="space-y-4">
                    {/* Latency Profile */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.047')}</label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: t('settings.AudioSettingsModal.048'), value: 128, desc: t('settings.AudioSettingsModal.050') },
                          { label: t('settings.AudioSettingsModal.051'), value: 512, desc: t('settings.AudioSettingsModal.053') },
                          { label: t('settings.AudioSettingsModal.054'), value: 1024, desc: t('settings.AudioSettingsModal.056') },
                        ].map((profile) => {
                          const disabled = canChangeBufferSize && !supportedBufferSizes.includes(profile.value);
                          return (
                            <button
                              key={profile.value}
                              type="button"
                              aria-pressed={selectedBufferSize === profile.value}
                              onClick={() => setSelectedBufferSize(profile.value)}
                              disabled={disabled}
                              className={`
                                        flex flex-col items-center justify-center p-2 rounded-lg border transition-colors
                                        ${selectedBufferSize === profile.value
                                  ? 'bg-selection/15 border-selection text-selection'
                                  : 'bg-background border-input text-muted-foreground hover:border-primary/50'
                                }
                                        ${disabled ? 'opacity-30 cursor-not-allowed bg-muted' : ''}
                                    `}
                            >
                              <span className="text-sm font-bold">{profile.label}</span>
                              <span className="text-xs">{profile.desc}</span>
                            </button>
                          )
                        })}
                      </div>
                      {/* 3択以外の値（数値で指定した値）でも、現在値が選ばれていないように見せない。 */}
                      {selectedBufferSize > 0 && ![128, 512, 1024].includes(selectedBufferSize) && (
                        <p role="status" className="text-xs text-muted-foreground text-center">{t('settings.bufferCustom', { size: selectedBufferSize })}</p>
                      )}
                      {(selectedBufferSize <= 256 || selectedBufferSize >= 1024) && (
                        selectedBufferSize <= 256 ? <InfoPopover label={t('info.fast')}>{t('settings.AudioSettingsModal.057')}</InfoPopover> : <p className="text-xs text-muted-foreground text-center">{t('settings.AudioSettingsModal.058')}</p>
                      )}
                    </div>

                    {/* Quality Profile */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.060')}</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: t('settings.AudioSettingsModal.061'), value: 48000, desc: t('settings.AudioSettingsModal.062') },
                          { label: t('settings.AudioSettingsModal.063'), value: 44100, desc: t('settings.AudioSettingsModal.064') },
                        ].map((profile) => (
                          <button
                            key={profile.value}
                            onClick={() => setSelectedSampleRate(profile.value)}
                            className={`
                                        flex flex-col items-center justify-center p-2 rounded-lg border transition-colors
                                        ${selectedSampleRate === profile.value
                                ? 'bg-selection/15 border-selection text-selection'
                                : 'bg-background border-input text-muted-foreground hover:border-primary/50'
                              }
                                    `}
                          >
                            <span className="text-sm font-bold">{profile.label}</span>
                            <span className="text-xs">{profile.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Advanced Mode UI (Buffer Size & Sample Rate) */
                  <div className="grid grid-cols-2 gap-4 pt-2">
                    {/* Buffer Size */}
                    {canChangeBufferSize ? (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.065')}</label>
                        <select
                    aria-label={t('settings.AudioSettingsModal.066')}
                          value={selectedBufferSize}
                          onChange={(e) => setSelectedBufferSize(Number(e.target.value))}
                          className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select"
                        >
                          {supportedBufferSizes.map(size => (
                            <option key={size} value={size}>{size} {t('settings.AudioSettingsModal.067')}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-2 opacity-50 pointer-events-none">
                        <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.068')}</label>
                        <div className="w-full bg-muted border border-input rounded-md px-3 py-2 text-sm text-muted-foreground">
                          {t('settings.AudioSettingsModal.069')}</div>
                      </div>
                    )}

                    {/* Sample Rate */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-muted-foreground">{t('master.rate')}</label>
                      <select
                    aria-label={t('master.rate')}
                        value={selectedSampleRate}
                        onChange={(e) => setSelectedSampleRate(Number(e.target.value))}
                        className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select"
                      >
                        {sampleRates.map(rate => (
                          <option key={rate} value={rate}>{(rate / 1000).toFixed(1)} kHz</option>
                        ))}
                      </select>
                      {!isAsio && (
                        <div className="text-xs text-warning/90 flex items-start gap-1.5 bg-warning/10 p-1.5 rounded border border-warning/20 mt-2">
                          <MdWarning className="w-3 h-3 mt-0.5 shrink-0" />
                          <span>
                            {t('settings.AudioSettingsModal.070')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}


                {!isBeginnerMode && <>
                {/* Latency Estimate */}
                <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 flex items-center justify-between mt-4">
                  <span className="flex items-center gap-1">{t('settings.AudioSettingsModal.068')} <InfoPopover label={t('info.buffer')}>{t('settings.AudioSettingsModal.071')}</InfoPopover></span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-foreground">{selectedBufferMs === null ? t('settings.AudioSettingsModal.072') : `${selectedBufferMs.toFixed(2)} ms`}</span>
                  </div>
                </div>

                {/* Tips Section (Only in Advanced Mode) */}
                {isAdvancedMode && (
                  <details className="text-xs text-muted-foreground bg-muted/50 rounded border border-border mt-2">
                    <summary className="p-2 cursor-pointer hover:bg-muted/80 transition-colors font-medium flex items-center gap-2">
                      <MdLightbulb className="w-4 h-4 text-primary" />
                      {t('settings.AudioSettingsModal.073')}</summary>
                    <div className="p-3 pt-0 space-y-2 border-t border-border/50">
                      <div>
                        <strong className="text-primary">{t('settings.AudioSettingsModal.074')}</strong>
                        <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
                          <li><span className="text-success">{t('settings.AudioSettingsModal.075')}</span>{t('settings.AudioSettingsModal.076')}</li>
                          <li><span className="text-warning">{t('settings.AudioSettingsModal.077')}</span>{t('settings.AudioSettingsModal.078')}</li>
                          <li><span className="text-warning">{t('settings.AudioSettingsModal.079')}</span>{t('settings.AudioSettingsModal.080')}</li>
                        </ul>
                      </div>
                      <div>
                        <strong className="text-primary">{t('settings.AudioSettingsModal.081')}</strong>
                        <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
                          <li><span className="text-brand">44.1 kHz</span>{t('settings.AudioSettingsModal.082')}</li>
                          <li><span className="text-brand">48 kHz</span>{t('settings.AudioSettingsModal.083')}</li>
                          <li><span className="text-brand">96 kHz</span>{t('settings.AudioSettingsModal.084')}</li>
                        </ul>
                      </div>
                    </div>
                  </details>
                )}

                </>}
                {/* Preset Section */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1"><label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.086')}</label><InfoPopover label={t('info.preset')}>{t('settings.AudioSettingsModal.085')}</InfoPopover></span>
                    <div className="flex gap-2">
                      <select
                  aria-label={t('settings.AudioSettingsModal.087')}
                        className="bg-background border border-input rounded px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                        value={presets[presetName] ? presetName : ''}
                        onChange={(e) => handleLoadPreset(e.target.value)}
                      >
                        <option value="">{t('settings.AudioSettingsModal.088')}</option>
                        {Object.keys(presets).map(k => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-end gap-2">
                    <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                      {t('settings.AudioSettingsModal.089')}
                      <input
                        type="text"
                        className="bg-background border border-input rounded px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                      />
                    </label>
                    <button
                      onClick={handleSavePreset}
                      disabled={!presetName}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary disabled:opacity-50 transition-colors"
                      title={t('settings.AudioSettingsModal.090')}
                    >
                      <MdSave size={18} />
                    </button>
                    <button
                      onClick={handleDeletePreset}
                      disabled={!presetName || !presets[presetName]}
                      className="p-1.5 rounded hover:bg-card text-muted-foreground hover:text-destructive-text disabled:opacity-50 transition-colors"
                      title={t('settings.AudioSettingsModal.091')}
                    >
                      <MdDelete size={18} />
                    </button>
                  </div>
                </div>

              </div>
            )}
            <details className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.monitor')}</summary>
            <LiveOutputPanel outputs={devices.outputs} disabled={loading} onBusyChange={setLoading} />
            <MonitorTrial devices={devices.outputs} disabled={loading} onBusyChange={setLoading} onApplied={async config => { await onConfigChange(config, { audioStarted: true }); await refreshEngineRuntimeStats(); }} />
            </details>
          </TabsContent>

          <TabsContent value="sound" className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.AudioSettingsModal.092')}</p>
            {!engineStats && <p role="status" className="text-sm text-muted-foreground">{t('settings.AudioSettingsModal.094')}</p>}
            <fieldset disabled={!engineStats || noiseActionBusy} className="min-w-0 space-y-4">
                {/* Noise reduction */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <h3 ref={soundStart} tabIndex={-1} className="text-sm font-bold text-foreground">{t('settings.AudioSettingsModal.105')}</h3>
                      <InfoPopover label={t('info.noise')}>
                    <div className="space-y-1.5">
                      <p>
                        <span className="font-bold">{t('settings.AudioSettingsModal.108')}</span> {t('settings.AudioSettingsModal.109')}</p>
                      <p>
                        <span className="font-bold">{t('settings.AudioSettingsModal.110')}</span> {t('settings.AudioSettingsModal.111')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings.AudioSettingsModal.112')}{onOpenVoiceCheck ? (
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
                              {t('settings.AudioSettingsModal.113')}</button>
                          </>
                        ) : (
                          t('settings.AudioSettingsModal.114')
                        )}
                      </p>
                    </div>
                      </InfoPopover>
                    </div>
                    <Switch
                      checked={!!engineStats?.noiseReductionEnabled}
                      onCheckedChange={(checked) => applyNoiseControlConfig({ active: checked })}
                      aria-label={t('settings.AudioSettingsModal.107')}
                    />
                  </div>

                  <fieldset className="space-y-2"><legend className="text-xs font-medium">{t('structure.noise.standard')}</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        ['low', t('master.nrLow')],
                        ['high', t('master.nrHigh')]
                      ] as Array<[NoiseControlMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={noiseMode === mode}
                        onClick={() => {
                          setNoiseMode(mode);
                          setNoiseMeasurementOpen(mode === 'smart' || mode === 'venue');
                          applyNoiseControlConfig({ mode });
                        }}
                        className={`px-3 py-2 rounded-md border text-xs font-bold transition-colors ${
                          noiseMode === mode
                            ? 'border-selection bg-selection/15 text-selection'
                            : 'border-input bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}
                      </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="space-y-2"><legend className="text-xs font-medium">{t('structure.noise.adaptive')}</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        ['smart', t('master.nrLearn')],
                        ['venue', t('master.nrVenue')]
                      ] as Array<[NoiseControlMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={noiseMode === mode}
                        onClick={() => {
                          setNoiseMode(mode);
                          setNoiseMeasurementOpen(mode === 'smart' || mode === 'venue');
                          applyNoiseControlConfig({ mode });
                        }}
                        className={`px-3 py-2 rounded-md border text-xs font-bold transition-colors ${
                          noiseMode === mode
                            ? 'border-selection bg-selection/15 text-selection'
                            : 'border-input bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}
                      </button>
                      ))}
                    </div>
                  </fieldset>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {noiseMode === 'smart' && (
                      <>{t('settings.AudioSettingsModal.115')}</>
                    )}
                    {noiseMode === 'venue' && (
                      <>{t('settings.AudioSettingsModal.116')}</>
                    )}
                    {noiseMode === 'low' && (
                      <>{t('settings.AudioSettingsModal.117')}</>
                    )}
                    {noiseMode === 'high' && (
                      <>{t('settings.AudioSettingsModal.118')}</>
                    )}
                  </p>

                  {/* かんたん表示の強さは弱／強の2択だけにし、数値の強さは詳細表示で出す。 */}
                  {!isBeginnerMode && <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{t('settings.AudioSettingsModal.119')}</span>
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
                      aria-label={t('settings.AudioSettingsModal.120')}
                    />
                  </div>}

                  <details open={noiseMeasurementOpen} onToggle={event => setNoiseMeasurementOpen(event.currentTarget.open)} className="rounded-md border border-border p-3 text-sm">
                    <summary className="font-semibold">{t('measurement.title')}</summary>
                    {/* 閉じると測定欄を外し、その欄が開始した測定だけを既存の後片付けで取り消す。 */}
                    {noiseMeasurementOpen && <NoiseMeasurementPanel embedded />}
                  </details>

                  <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2">
                    <div>
                      <Label className="text-xs font-bold text-foreground">{t('settings.AudioSettingsModal.127')}</Label>
                      <InfoPopover label={t('info.voiceGuard')}>{t('settings.AudioSettingsModal.128')}</InfoPopover>
                    </div>
                    <Switch
                      checked={noiseVoiceGuard}
                      onCheckedChange={(checked) => {
                        setNoiseVoiceGuard(checked);
                        applyNoiseControlConfig({ voiceGuard: checked });
                      }}
                      aria-label={t('settings.AudioSettingsModal.129')}
                    />
                  </div>
                </div>

                {/* Built-in Effects */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">{t('settings.AudioSettingsModal.095')}</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('settings.AudioSettingsModal.096')}</p>
                    </div>
                    <Switch
                      disabled={!singingModel.snapshot || singingModel.busy}
                      checked={singingModel.snapshot?.config.active ?? builtInEffectsEnabled}
                      onCheckedChange={(checked) => {
                        applyBuiltInEffects({ active: checked });
                      }}
                      aria-label={t('settings.AudioSettingsModal.097')}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ['broadcast', t('settings.AudioSettingsModal.098')],
                      ['warm', t('settings.AudioSettingsModal.099')],
                      ['bright', t('settings.AudioSettingsModal.100')],
                    ] as Array<[BuiltInEffectsPreset, string]>).map(([preset, label]) => (
                      <button
                        key={preset}
                        disabled={!singingModel.snapshot || singingModel.busy}
                        onClick={() => {
                          applyBuiltInEffects({ active: true, preset });
                        }}
                        className={`px-3 py-2 rounded-md border text-xs font-bold transition-colors ${
                          (singingModel.snapshot?.config.preset ?? builtInEffectsPreset) === preset
                            ? 'border-selection bg-selection/15 text-selection'
                            : 'border-input bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}</button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {singingModel.snapshot?.config.preset === 'singing' && <p className="text-xs">{t('settings.AudioSettingsModal.102')}</p>}
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{t('settings.AudioSettingsModal.103')}</span>
                      <span className="font-mono text-foreground">{builtInEffectsAmount}%</span>
                    </div>
                    <input
                      type="range"
                      disabled={singingModel.snapshot?.config.preset === 'singing' || !singingModel.snapshot || singingModel.busy}
                      min={0}
                      max={100}
                      step={5}
                      value={builtInEffectsAmount}
                      onChange={(e) => setBuiltInEffectsAmount(Number(e.target.value))}
                      onMouseUp={() => applyBuiltInEffects({ amount: builtInEffectsAmount })}
                      onKeyUp={() => applyBuiltInEffects({ amount: builtInEffectsAmount })}
                      className="w-full accent-primary"
                      aria-label={t('settings.AudioSettingsModal.104')}
                    />
                  </div>
                </div>

            </fieldset>
            {onOpenVoiceCheck && <button onClick={onOpenVoiceCheck} className="h-10 px-4 rounded-md border border-input text-sm hover:bg-muted">{t('settings.AudioSettingsModal.093')}</button>}
            <LiveModeControls model={providedLive ?? localLive} />
            <details className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.singing')}</summary>
              <SingingControls showHeading={false} model={singingModel} onPreview={onPreviewSinging} onSaveProfile={onSaveSingingProfile} />
            </details>
            {/* 出力の安全装置は上級設定。かんたん表示では閉じた欄に置く。 */}
            {isBeginnerMode ? <details className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('peak.title')}</summary>
              <PeakProtectionPanel />
            </details> : <PeakProtectionPanel />}
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
            <LanguageSelector />
            <DisplayPurposeSelector />
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2 text-foreground">
                  <MdPalette className="w-4 h-4 text-primary" /> {t('settings.AudioSettingsModal.130')}</h3>
                <RadioGroup value={theme} onValueChange={(v) => setTheme(v as any)} className="space-y-3">
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('light')}>
                    <RadioGroupItem value="light" id="theme-light" />
                    <Label htmlFor="theme-light" className="cursor-pointer flex-1">
                      <span className="font-bold block">{t('header.light')}</span>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('dark')}>
                    <RadioGroupItem value="dark" id="theme-dark" />
                    <Label htmlFor="theme-dark" className="cursor-pointer flex-1">
                      <span className="font-bold block">{t('header.dark')}</span>
                      <span className="text-xs text-muted-foreground">{t('settings.AudioSettingsModal.132')}</span>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('gaming')}>
                    <RadioGroupItem value="gaming" id="theme-gaming" className="text-brand border-brand" />
                    <Label htmlFor="theme-gaming" className="cursor-pointer flex-1">
                      <span className="font-bold block">{t('header.gaming')}</span>
                      <span className="text-xs text-muted-foreground">{t('settings.AudioSettingsModal.133')}</span>
                    </Label>
                  </div>
                </RadioGroup>
              </div>

            </div>
            {/* App Info Card */}
            {/* App Info Card */}
            <div className="p-6 bg-muted/20 border border-border rounded-xl flex flex-col items-center justify-center space-y-3">
              <img src="/auralyn_icon.png" alt="Auralyn Icon" className="w-16 h-16 rounded-full shadow-sm object-contain" />
              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground">{APP_INFO.NAME}</h3>
                <p className="text-xs text-muted-foreground">{t('settings.AudioSettingsModal.138')}{APP_INFO.VERSION}</p>
              </div>

              <div className="flex gap-4 pt-2">
                <button onClick={() => openUrl('https://www.kuro7983.com/apps/auralyn')} className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1">
                  <MdLanguage className="w-3.5 h-3.5" />
                  {t('settings.AudioSettingsModal.139')}</button>
                {onOpenLicense && (
                  <button onClick={onOpenLicense} className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1">
                    {t('settings.AudioSettingsModal.140')}</button>
                )}
                <button onClick={() => openUrl('https://ofuse.me/o?uid=149216')} className="text-xs text-muted-foreground hover:text-brand-secondary transition-colors flex items-center gap-1">
                  <MdFavorite className="w-3 h-3" />
                  {t('settings.AudioSettingsModal.141')}</button>
              </div>
            </div>


          </TabsContent>

          <TabsContent value="shortcuts" className="space-y-4">
            <ShortcutsPanel onCaptureChange={setCapturingShortcut} />
          </TabsContent>
          <TabsContent value="system" className="space-y-4">
            {onOpenWizard && <button type="button" disabled={loading} onClick={() => { onClose(); onOpenWizard(); }} className="rounded-md border border-border px-3 py-2 text-sm">{t('settings.AudioSettingsModal.198')}</button>}

            {/* Startup Settings */}
            <div className="p-4 bg-muted/20 border border-border rounded-xl flex items-center justify-between">
              <div>
                <label className="text-sm font-bold text-foreground block">{t('settings.AudioSettingsModal.142')}</label>
                <div className="text-xs text-muted-foreground mt-0.5">{autostartReason ? renderNotice(t, autostartReason) : t('settings.AudioSettingsModal.143')}</div>
              </div>
              <div className="flex items-center">
                <Switch
                  aria-label={t('settings.AudioSettingsModal.144')}
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
                        toast.success(checked ? t('settings.AudioSettingsModal.145') : t('settings.AudioSettingsModal.146'));
                      }
                    } catch (e) {
                      console.error(e);
                      toast.error(t('settings.AudioSettingsModal.147'));
                      setAutostartCanChange(false);
                      setAutostartReason(notice('settings.AudioSettingsModal.148'));
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading || !autostartCanChange}
                />
              </div>
            </div>

            <UpdatePreferences />
            <section className="space-y-2">
              <h3 className="font-semibold">{t('structure.restart')}</h3>
                <button
                  onClick={handleRestart}
                  disabled={loading || (reviewRequired && !migrationConfirmed)}
                  className="px-3 py-2 bg-muted hover:bg-destructive/10 text-muted-foreground hover:text-destructive-text border border-input hover:border-destructive/30 rounded-md transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('settings.AudioSettingsModal.196')}</button>
            </section>
            <details className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.optimization')}</summary>
            {/* Engine Tuning */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdSettings className="w-4 h-4 text-primary" />
                {t('settings.AudioSettingsModal.149')}</h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.150')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.151')}</div>
                  </div>
                  <Switch
                    aria-label={t('settings.AudioSettingsModal.152')}
                    checked={engineTuningConfig.enableAffinityPinning}
                    onCheckedChange={(checked) =>
                      setEngineTuningConfig((prev) => ({ ...prev, enableAffinityPinning: checked }))
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('settings.AudioSettingsModal.153')}</label>
                  <input
                    aria-label={t('settings.AudioSettingsModal.154')}
                    type="text"
                    value={engineTuningConfig.affinityMask ?? ''}
                    onChange={(e) =>
                      setEngineTuningConfig((prev) => ({ ...prev, affinityMask: e.target.value || null }))
                    }
                    placeholder={t('settings.AudioSettingsModal.155')}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    disabled={systemSaving}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.156')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.157')}</div>
                  </div>
                  <Switch
                    aria-label={t('settings.AudioSettingsModal.158')}
                    checked={engineTuningConfig.enableRealtimePriority}
                    onCheckedChange={(checked) =>
                      handleDangerousToggle(
                        'enableRealtimePriority',
                        checked,
                        notice('settings.AudioSettingsModal.159'),
                        notice('settings.AudioSettingsModal.160')
                      )
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.161')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.162')}</div>
                  </div>
                  <Switch
                    aria-label={t('settings.AudioSettingsModal.163')}
                    checked={engineTuningConfig.enableTimeCriticalAudioThreads}
                    onCheckedChange={(checked) =>
                      handleDangerousToggle(
                        'enableTimeCriticalAudioThreads',
                        checked,
                        notice('settings.AudioSettingsModal.164'),
                        notice('settings.AudioSettingsModal.165')
                      )
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border">
                  {t('settings.AudioSettingsModal.166')}</div>

                <div className="flex gap-2">
                  <button
                    onClick={saveEngineTuningConfig}
                    disabled={systemSaving}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition"
                  >
                    {systemSaving ? t('settings.AudioSettingsModal.167') : t('settings.AudioSettingsModal.168')}
                  </button>

                </div>


              </div>
            </div>

            </details>
            <details className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.diagnostics')}</summary>
              <button
                    onClick={refreshEngineRuntimeStats}
                    disabled={statsLoading}
                    className="px-3 py-1.5 text-xs border border-input rounded-md text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-50 transition flex items-center gap-1"
                  >
                    <MdRefresh className="w-3 h-3" />
                    {statsLoading ? t('settings.AudioSettingsModal.169') : t('settings.AudioSettingsModal.170')}
                  </button>
<table className="w-full text-sm">
                <caption className="sr-only">{t('structure.statistics')}</caption>
                <tbody>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.171')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.activePluginCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.172')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.enabledPluginCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.173')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.pendingUnloadCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.174')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.burnedLibraryCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.175')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats ? `${(engineStats.maxJitterUs / 1000).toFixed(2)}ms` : '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.176')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.glitchCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.177')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats
                        ? (engineStats.noiseReductionEnabled
                          ? t('settings.AudioSettingsModal.178', { arg0: engineStats.noiseReductionMode === 'high' ? t('master.nrHigh') : engineStats.noiseReductionMode === 'smart' ? t('master.nrLearn') : engineStats.noiseReductionMode === 'venue' ? t('master.nrVenue') : t('master.nrLow') })
                          : 'OFF')
                        : '-'}</td>
                </tr>
                </tbody>
                </table>
            <LatencyDetails stats={engineStats} />
            </details>
            <details className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.migration')}</summary>
              <MigrationPanel />
            </details>
            {/* Plugin Management */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdExtension className="w-4 h-4 text-primary" />
                {t('settings.AudioSettingsModal.179')}</h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.180')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.181')}</div>
                  </div>
                  <button
                    onClick={() => {
                      showConfirm({
                        title: notice('settings.AudioSettingsModal.182'),
                        description: notice('settings.AudioSettingsModal.183'),
                        confirmLabel: notice('settings.AudioSettingsModal.184'),
                        variant: 'destructive',
                        onConfirm: async () => {
                          setLoading(true);
                          try {
                            await audioApi.clearBlacklist();
                            toast.success(t('settings.AudioSettingsModal.185'));
                          } catch (e) {
                            console.error(e);
                            toast.error(t('settings.AudioSettingsModal.186'));
                          } finally {
                            setLoading(false);
                          }
                        },
                      });
                    }}
                    className="px-3 py-1.5 text-xs text-destructive-text bg-destructive/10 hover:bg-destructive/20 border border-destructive/20 rounded-md transition-colors whitespace-nowrap"
                  >
                    {t('settings.AudioSettingsModal.187')}</button>
                </div>
              </div>
            </div>

            {/* Factory Reset */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdRefresh className="w-4 h-4 text-destructive-text" />
                {t('settings.AudioSettingsModal.188')}</h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.189')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.190')}</div>
                  </div>
                  <button
                    onClick={() => {
                      showConfirm({
                        title: notice('settings.AudioSettingsModal.191'),
                        description: notice('settings.AudioSettingsModal.192'),
                        confirmLabel: notice('settings.AudioSettingsModal.193'),
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
                            toast.error(t('settings.AudioSettingsModal.194'));
                          }
                        },
                      });
                    }}
                    className="px-3 py-1.5 text-xs text-destructive-text bg-destructive/10 hover:bg-destructive/20 border border-destructive/20 rounded-md transition-colors whitespace-nowrap"
                  >
                    {t('settings.AudioSettingsModal.195')}</button>
                </div>
              </div>
            </div>
          </TabsContent>
          </div>
        </Tabs>
        {activeTab === 'audio' && !loading && !error && (
          <div className="shrink-0 border-t border-border bg-muted/20 px-4 py-2 flex items-center justify-end gap-3">
            {/* 稼働中の保存は再起動になり、音が途切れることを押す前に示す。 */}
            {engineStats?.latencyMetadata?.streamRunning === true && <span id="settings-save-restart" className="text-xs text-muted-foreground">{t('settings.saveRestartHint')}</span>}
            <button onClick={handleSave} disabled={loading || (reviewRequired && !migrationConfirmed)}
              aria-describedby={engineStats?.latencyMetadata?.streamRunning === true ? 'settings-save-restart' : undefined}
              className="rounded-md bg-primary px-5 py-2 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {t(engineStats?.latencyMetadata?.streamRunning === true ? 'settings.saveRestart' : 'settings.AudioSettingsModal.197')}
            </button>
          </div>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={renderNotice(t, confirmDialog.title)}
        description={renderNotice(t, confirmDialog.description)}
        confirmLabel={confirmDialog.confirmLabel ? renderNotice(t, confirmDialog.confirmLabel) : undefined}
        cancelLabel={t('common.cancel')}
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

import { ProcessInputPanel } from './ProcessInputPanel';
import { deviceInput, readInputSource, type InputSourceRequest } from '@/lib/inputSource';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { SaveScopeSummary } from '../Presets/SaveScopeSummary';
import { SoundSettings, useSoundSettings } from './SoundSettings';
import { SystemSettings, useSystemSettings } from './SystemSettings';
import { LiveOutputPanel } from './LiveOutputPanel';
import { Button } from '@/components/ui/button';
import { openStreamMixPanel, saveStreamMixPanel, useStreamMixPanel } from '@/lib/streamMixPanel';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { MonitorTrial } from './MonitorTrial';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSingingDraft, type SingingDraft } from '../../../hooks/useSingingDraft';
import { useLiveModes, type LiveModesModel } from '@/hooks/useLiveModes';
import { Modal } from '../../ui/modal';
import { MicrophonePermissionGuide } from './MicrophonePermissionGuide';
import React, { useEffect, useId, useState, useMemo, useRef } from 'react';
import { MdClose, MdSettings, MdRefresh, MdWarning, MdLightbulb, MdSave, MdDelete, MdPalette, MdMic, MdGraphicEq, MdCast, MdKeyboard, MdTune } from 'react-icons/md';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { useTheme } from '../../../hooks/useTheme';
import { InputChannelSelector } from './InputChannelSelector';
import { OutputChannelSelector } from './OutputChannelSelector';
import { readOutputRouting } from '@/lib/audioChannelRouting';
import { ObsConnectionSettings } from './ObsConnectionSettings';
import { ShortcutsPanel } from './ShortcutsPanel';
import { AuroraDisplaySwitch, DisplayPurposeSelector, NumericDetailsSwitch } from './DisplayPurposeSelector';
import { REVIEW_KEY } from '@/api/migration';
import { readAudioPreferences, savedAudioPreferences, type AudioPreferences } from '@/lib/audioPreferences';
import { audioApi } from '@/api/audio';
import { displayAudioHost } from '@/lib/audioDevices';
import { segmentButtonClass } from '@/components/ui/segment';
import { audioDeviceKey, useAudioDeviceSelection } from './useAudioDeviceSelection';
import { ConnectionApplyError, ConnectionStartError, useAudioConnectionController } from './useAudioConnectionController';
import { formatSampleRate, sampleRateOptions } from './sampleRateOptions';
import { useRuntimeStats } from '@/hooks/useRuntimeStats';

interface AudioSettingsModalProps {
  liveModel?: LiveModesModel;
  singingModel?: SingingDraft;
  onPreviewSinging?: () => void;
  onSaveSingingProfile?: () => void;
  initialTab?: 'audio' | 'obs' | 'sound';
  initialSection?: 'liveModes' | 'singing' | 'audioTuning' | 'liveOutput' | 'primaryInput';
  isAudioRunning?: boolean;
  allowConnectionRetry?: boolean;
  currentConfig?: AudioPreferences;
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
  initialTab = 'audio', initialSection,
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
  currentConfig,
  isAudioRunning,
  allowConnectionRetry = false,
}) => {
    const t = useMessages();
  const inputId = useId();
  const pcInput = localStorage.getItem('vst_host_setup_goal') === 'music';
  const localSinging = useSingingDraft();
  const localLive = useLiveModes();
  const singingModel = providedSinging ?? localSinging;
  const getBeginnerMode = () => localStorage.getItem('vst_host_beginner_mode') !== 'false';
  const { theme, setTheme } = useTheme();
  const [isApplying, setLoading] = useState(false);
  const [connectionRetry, setConnectionRetry] = useState(false);
  // システム再起動の途中失敗は、接続画面からの再試行でもVST復元まで引き継ぐ。
  const retryRestart = useRef(false);
  const reviewRequired = localStorage.getItem(REVIEW_KEY) === 'true';
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const importedPlugins = useMemo(() => {
    try { return (JSON.parse(localStorage.getItem('vst_host_session_plugins') ?? '[]') as { name: string; path: string }[]); }
    catch { return []; }
  }, []);
  const [error, setError] = useState<SettingsNotice | null>(null);
  const {
    devices, selectedHost, setSelectedHost, selectedInput, setSelectedInput, selectedInputKey, setSelectedInputKey, selectedInputDevice,
    selectedOutput, setSelectedOutput, selectedOutputKey, setSelectedOutputKey, selectedOutputDevice: selectedOutputFromSelection, selectedBufferSize, setSelectedBufferSize,
    selectedSampleRate, setSelectedSampleRate, fetchDevices, isAsio,
    filteredInputs, filteredOutputs, supportedBufferSizes,
    canChangeBufferSize, loading: devicesLoading,
  } = useAudioDeviceSelection({ isOpen, currentSampleRate, currentBufferSize, currentConfig: currentConfig?.host ? currentConfig : undefined, onError: setError });
  const asioOutputs = filteredOutputs.filter(device => device.name === selectedInputDevice?.name);
  const selectedOutputDevice = isAsio
    ? asioOutputs.find(device => !!selectedInputDevice?.id && device.id === selectedInputDevice.id) ?? (asioOutputs.length === 1 ? asioOutputs[0] : undefined)
    : selectedOutputFromSelection;
  const storedConfig = currentConfig?.host ? currentConfig : readAudioPreferences();
  const [inputSource, setInputSource] = useState<InputSourceRequest>(() => ({ source: storedConfig?.inputSource ?? deviceInput() }));
  useEffect(() => { if (isOpen) setInputSource({ source: (currentConfig ?? readAudioPreferences())?.inputSource ?? deviceInput() }); }, [isOpen]);
  const [needsDeviceChoice, setNeedsDeviceChoice] = useState(false);
  useEffect(() => { if (isOpen) setNeedsDeviceChoice(false); }, [isOpen]);
  const processInput = inputSource.source.kind === 'process_loopback';
  const inputReady = processInput ? !isAsio && !!inputSource.candidateId && !!readInputSource(inputSource.source) : !needsDeviceChoice && !!selectedInputDevice;
  const connection = useAudioConnectionController({ isOpen, host: selectedHost, input: processInput ? undefined : selectedInputDevice, inputSource,
    output: selectedOutputDevice, sampleRate: selectedSampleRate, bufferSize: selectedBufferSize, isAsio,
    currentChannels: currentInputChannels ?? storedConfig?.inputChannels,
    currentOutputRouting: storedConfig?.outputRouting ?? (storedConfig ? { mode: 'legacy' } : undefined), onConfigChange });
  const loading = isApplying || devicesLoading;
  type ConnectionField = 'source' | 'host' | 'input' | 'output' | 'buffer' | 'rate' | 'channels' | 'routing';
  const [editedFields, setEditedFields] = useState<ReadonlySet<ConnectionField>>(new Set());
  const editConnection = (...fields: ConnectionField[]) => setEditedFields(previous => new Set([...previous, ...fields]));
  useEffect(() => { if (isOpen) setEditedFields(new Set()); }, [isOpen]);
  const savedConnection = useMemo(() => {
    const saved = currentConfig?.host ? currentConfig : readAudioPreferences();
    return saved?.host ? { ...saved, sampleRate: currentSampleRate ?? saved.sampleRate,
      bufferSize: currentBufferSize ?? saved.bufferSize } : null;
  }, [isOpen, currentConfig, currentSampleRate, currentBufferSize]);
  const changedFields = !savedConnection ? [] : [
    editedFields.has('source') && JSON.stringify(inputSource.source) !== JSON.stringify(savedConnection.inputSource ?? deviceInput()) && t('processInput.changed'),
    editedFields.has('source') && processInput && inputSource.candidateId && t('processInput.appChanged'),
    editedFields.has('host') && selectedHost.toLowerCase() !== savedConnection.host.toLowerCase() && t('settings.AudioSettingsModal.032'),
    editedFields.has('input') && !processInput && (selectedInput !== (savedConnection.input ?? '') || (savedConnection.inputId && selectedInputDevice?.id !== savedConnection.inputId)) && t('settings.AudioSettingsModal.038'),
    editedFields.has('output') && ((isAsio ? selectedInput : selectedOutput) !== (savedConnection.output ?? '') || (savedConnection.outputId && selectedOutputDevice?.id !== savedConnection.outputId)) && t('settings.AudioSettingsModal.041'),
    editedFields.has('buffer') && selectedBufferSize !== (savedConnection.bufferSize ?? 512) && t('settings.AudioSettingsModal.047'),
    editedFields.has('rate') && selectedSampleRate !== (savedConnection.sampleRate ?? 48000) && t('settings.AudioSettingsModal.060'),
    editedFields.has('channels') && (isAsio && connection.channels.some((channel, index) => channel !== (savedConnection.inputChannels ?? currentInputChannels ?? [0, 1])[index])) && t('settings.InputChannelSelector.205'),
    editedFields.has('routing') && (isAsio && JSON.stringify(connection.outputRouting) !== JSON.stringify(savedConnection.outputRouting ?? { mode: 'legacy' })) && t('settings.routing.title'),
  ].filter((value): value is string => typeof value === 'string');
  const hasConnectionChanges = !savedConnection || changedFields.length > 0;
  const [savedRestoreAvailable, setSavedRestoreAvailable] = useState(false);
  const needsSavedRestore = isOpen && !savedConnection;
  useEffect(() => {
    let active = true;
    setSavedRestoreAvailable(false);
    if (needsSavedRestore) void audioApi.getSavedAudioConfig().then(saved => {
      if (active) setSavedRestoreAvailable(!!saved && !!savedAudioPreferences(saved));
    }).catch(() => { /* 不在・読取不能を復帰可能として案内しない。 */ });
    return () => { active = false; };
  }, [needsSavedRestore]);
  const [restoreNotice, setRestoreNotice] = useState('');
  const restoreSavedConnection = async () => {
    if (isApplying) return;
    setLoading(true); setRestoreNotice('');
    try {
      const saved = await audioApi.getSavedAudioConfig();
      if (!saved) { setRestoreNotice(t('settings.connection.noSaved')); return; }
      const restored = savedAudioPreferences(saved);
      if (!restored) throw new Error('Invalid saved connection');
      const source = restored.inputSource ?? deviceInput();
      restored.inputSource = source;
      restored.outputRouting ??= { mode: 'legacy' };
      // 保存済み選択の復帰だけを通知する。音声開始済みの通知やStartは送らない。
      await onConfigChange(restored);
      setInputSource({ source }); setNeedsDeviceChoice(false);
      setSelectedSampleRate(restored.sampleRate!); setSelectedBufferSize(restored.bufferSize!);
      connection.setRoutingForDevice(`${saved.host}\u0000${saved.input_id ?? saved.input ?? ''}`, {
        inputChannels: restored.inputChannels, outputRouting: restored.outputRouting! });
      await fetchDevices(false);
      setEditedFields(new Set());
      setRestoreNotice(t('settings.connection.restored'));
    } catch { setRestoreNotice(t('settings.connection.restoreFailed')); }
    finally { setLoading(false); }
  };

  // Simple/Advanced Mode
  const [isAdvancedMode, setIsAdvancedMode] = useState(() => {
    // Initialize from localStorage
    return localStorage.getItem('vst_host_settings_advanced') === 'true';
  });
  useEffect(() => {
    if (isOpen && ![128, 512, 1024].includes(selectedBufferSize)) setIsAdvancedMode(true);
  }, [isOpen, selectedBufferSize]);
  const tuningDetails = useRef<HTMLDetailsElement>(null);
  const streamMixShown = useStreamMixPanel();
  // パネルはホームが歌・雑談の表示のときだけ出る。音楽鑑賞では押しても何も出ないため、理由を示して止める。
  const [displayPurpose] = useDisplayPurpose();
  const streamMixAvailable = displayPurpose === 'voice';
  const hostSelect = useRef<HTMLSelectElement>(null);
  // 「アプリの音声」を選べない理由から、畳まれた音質調整を開いて接続方式の選択へ移す（#290）。
  const chooseConnection = () => {
    setTuningOpen(true);
    requestAnimationFrame(() => {
      hostSelect.current?.scrollIntoView?.({ block: 'center' });
      hostSelect.current?.focus({ preventScroll: true });
    });
  };
  const [tuningOpen, setTuningOpen] = useState(initialSection === 'audioTuning' || !getBeginnerMode()
    || localStorage.getItem('vst_host_settings_advanced') === 'true');

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
  const [loadOutput, setLoadOutput] = useState(false);
  const outputFocusPending = useRef(false);
  useEffect(() => {
    if (!loading && outputFocusPending.current) {
      const control = settingsBody.current?.querySelector<HTMLElement>('#live-output-settings select');
      if (control) { outputFocusPending.current = false; control.scrollIntoView?.({ block: 'center' }); control.focus(); }
    }
  }, [loading, loadOutput]);
  // 配信ミックスのパネルから来たときは、出力先・入力元の区画を開いて操作できる所へ移す（#299）。
  const deviceTargetShown = useRef(false);
  useEffect(() => {
    if (!isOpen) { deviceTargetShown.current = false; return; }
    if ((initialSection !== 'liveOutput' && initialSection !== 'primaryInput') || deviceTargetShown.current || loading || error || activeTab !== 'audio') return;
    const frame = requestAnimationFrame(() => {
      const el = settingsBody.current?.querySelector<HTMLElement>(initialSection === 'liveOutput' ? '#live-output-settings' : '#primary-input-settings');
      if (!el) return;
      deviceTargetShown.current = true;
      // 出力一覧は開いたときに読み込む。読み込み後に出力先の選択へ移る。
      if (el instanceof HTMLDetailsElement) { el.open = true; outputFocusPending.current = true; setLoadOutput(true); }
      el.scrollIntoView?.({ block: 'start' });
      (el.querySelector<HTMLElement>('summary, select') ?? el).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, initialSection, loading, error, activeTab]);
  const soundStart = useRef<HTMLHeadingElement>(null);
  useEffect(() => { settingsBody.current?.scrollTo?.({ top: 0 }); }, [activeTab]);
  useEffect(() => {
    if (isOpen && initialTab === 'sound') {
      const frame = requestAnimationFrame(() => {
        const target = initialSection ? settingsBody.current?.querySelector<HTMLDetailsElement>(initialSection === 'liveModes' ? '#live-mode-settings' : '#singing-settings') : soundStart.current;
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView?.({ block: 'start' });
        if (initialSection) (initialSection === 'liveModes' ? target?.querySelector<HTMLElement>('h3') : target?.querySelector<HTMLElement>('summary') ?? target)?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [isOpen, initialTab, initialSection]);

  // OBS State
  // Preset State
  const [presets, setPresets] = useState<Record<string, any>>({});
  const [presetName, setPresetName] = useState('');

  // Autostart State
  const engineStats = useRuntimeStats(isOpen);
  const streamRunning = isAudioRunning ?? engineStats?.latencyMetadata?.streamRunning === true;
  // 停止中は「開始」が必要。稼働中の変更なし保存だけを抑止する。
  const canSaveConnection = !streamRunning || hasConnectionChanges || reviewRequired || allowConnectionRetry || connectionRetry;
  useEffect(() => {
    if (!isBeginnerMode || (engineStats?.glitchCount ?? 0) > 0 || initialSection === 'audioTuning') setTuningOpen(true);
  }, [isBeginnerMode, engineStats?.glitchCount, initialSection]);
  useEffect(() => {
    if (!isOpen || initialSection !== 'audioTuning' || loading || error || activeTab !== 'audio') return;
    setTuningOpen(true);
    const frame = requestAnimationFrame(() => {
      tuningDetails.current?.scrollIntoView?.({ block: 'start' });
      tuningDetails.current?.querySelector<HTMLElement>('[data-tuning-control]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, initialSection, loading, error, activeTab]);

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

  const sound = useSoundSettings(engineStats, singingModel, initialSection === 'liveOutput' || initialSection === 'primaryInput' ? undefined : initialSection);
  const system = useSystemSettings({ isOpen, currentSampleRate, currentBufferSize, isBeginnerMode, showConfirm });

  const sampleRates = sampleRateOptions(selectedInputDevice, selectedOutputDevice, isAsio, selectedSampleRate, currentSampleRate);

  const selectedBufferMs = Number.isFinite(selectedBufferSize) && selectedBufferSize > 0 && Number.isFinite(selectedSampleRate) && selectedSampleRate > 0
    ? selectedBufferSize / selectedSampleRate * 1000 : null;

  // 開始できなかった理由に、直前の接続へ戻したかと次にやることを添える（#289）。
  const startFailureNotice = (err: unknown, fallback: 'settings.AudioSettingsModal.017' | 'settings.AudioSettingsModal.020') =>
    err instanceof ConnectionApplyError ? notice(err.stage === 'channels' ? 'settings.connectionChannelsIncomplete' : 'settings.connectionSaveIncomplete', { arg0: err.message })
      : err instanceof ConnectionStartError && err.rollback !== 'none' ? notice(err.rollback === 'restored' ? 'settings.startRolledBack' : err.rollback === 'kept' ? 'settings.startKept' : 'settings.startRollbackFailed', { arg0: err.message })
      : notice(fallback, { arg0: err instanceof ConnectionStartError ? err.raw : String(err) });

  const handleSave = async () => {
    if (!canSaveConnection || isApplying) return;
    if (retryRestart.current) { await performRestart(); return; }
    setLoading(true);
    try {
      await connection.apply(false);
      setConnectionRetry(false);
      // toast.success('オーディオエンジンを起動しました'); // Assuming toast is available
      onClose();
    } catch (err) {
      if (err instanceof ConnectionApplyError) setConnectionRetry(true);
      console.error('Failed to start audio:', err);
      setError(startFailureNotice(err, 'settings.AudioSettingsModal.017'));
    } finally {
      setLoading(false);
    }
  };

  const performRestart = async () => {
    retryRestart.current = true;
    setLoading(true);
    try {
      await connection.apply(true);

      // The restart kills the sidecar process (plugins are lost), so restore them from session.
      // 移行確認完了時はonConfigChangeが復元を開始するため、通常再起動の復元と重ねない。
      if (onEngineRestarted && !reviewRequired) {
        toast.info(t('settings.AudioSettingsModal.018'));
        await onEngineRestarted();
        toast.success(t('settings.AudioSettingsModal.019'));
      }
      retryRestart.current = false;
      setConnectionRetry(false);
      onClose();
      // Optional: formatting toast success
    } catch (err) {
      setConnectionRetry(true);
      setActiveTab('audio');
      console.error('Failed to restart engine:', err);
      // 再起動はプラグインを失うため、直前の接続へ戻せたときも通常の再起動と同じく復元する（#289）。
      if (err instanceof ConnectionStartError && err.rollback === 'restored' && onEngineRestarted && !reviewRequired) {
        try { await onEngineRestarted(); } catch (restoreError) { console.error('Failed to restore plugins after rollback:', restoreError); }
      }
      setError(startFailureNotice(err, 'settings.AudioSettingsModal.020'));
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
        inputSource: inputSource.source,
        input: processInput ? undefined : selectedInput,
        output: selectedOutput,
        bufferSize: selectedBufferSize,
        sampleRate: selectedSampleRate,
        inputId: processInput ? undefined : selectedInputDevice?.id,
        outputId: selectedOutputDevice?.id,
        inputChannels: connection.channels,
        outputRouting: connection.outputRouting,
      }
    };
    setPresets(newPresets);
    localStorage.setItem('vst_host_audio_presets', JSON.stringify(newPresets));
  };

  const handleLoadPreset = (name: string) => {
    const p = presets[name];
    if (p) {
      const source = p.inputSource === undefined ? deviceInput() : readInputSource(p.inputSource);
      if (!source) { setError(t('processInput.presetUnsupported')); return; }
      editConnection('source', 'host', 'input', 'output', 'buffer', 'rate', 'channels', 'routing');
      setInputSource({ source });
      setNeedsDeviceChoice(!p.inputId && !p.input && source.kind === 'device');
      setPresetName(name);
      if (p.host) setSelectedHost(p.host);
      if (p.inputId) setSelectedInputKey(`id:${p.inputId}`);
      else if (p.input) setSelectedInput(p.input, p.host ?? selectedHost);
      if (p.outputId) setSelectedOutputKey(`id:${p.outputId}`);
      else if (p.output) setSelectedOutput(p.output, p.host ?? selectedHost);
      if (p.bufferSize) setSelectedBufferSize(p.bufferSize);
      if (p.sampleRate) setSelectedSampleRate(p.sampleRate);
      const matches = devices.inputs.filter(device => device.host.toLowerCase() === (p.host ?? selectedHost).toLowerCase()
        && (p.inputId ? device.id === p.inputId : device.name === p.input));
      if (matches.length === 1) {
        const device = matches[0];
        connection.setRoutingForDevice(`${device.host}\u0000${device.id ?? device.name}`, {
          inputChannels: p.inputChannels,
          outputRouting: readOutputRouting(p.outputRouting) ?? { mode: 'legacy' },
        });
      }
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
        <div className="fixed inset-0 z-[100] flex justify-end bg-background/90 gaming:bg-background/80 gaming:backdrop-blur-sm">
      <div className="settings-surface h-full w-full max-w-5xl flex flex-col overflow-hidden border-l border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 shrink-0">
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <MdSettings className="w-5 h-5 text-primary" />
            {t('common.settings')}
          </h2>
          <button
            onClick={onClose}
            disabled={isApplying}
            aria-label={t('settings.close')}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary focus:not-focus-visible:outline-none text-ui-support"
          >
            <MdClose className="w-5 h-5" />
          </button>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} orientation="vertical" className="flex min-h-0 flex-1">
          <TabsList aria-label={t('common.settings')} className="h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none border-r border-border p-2 overflow-y-auto">
            <TabsTrigger className="justify-start gap-2 text-ui-control" value="audio"><MdMic aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.audio')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2 text-ui-control" value="sound"><MdGraphicEq aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.sound')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2 text-ui-control" value="obs"><MdCast aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.obs')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2 text-ui-control" value="appearance"><MdPalette aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.appearance')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2 text-ui-control" value="shortcuts"><MdKeyboard aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.shortcuts')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2 text-ui-control" value="system"><MdTune aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.system')}</TabsTrigger>
          </TabsList>
          <div ref={settingsBody} className={`min-w-0 flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent ${activeTab === 'shortcuts' ? 'pb-0' : ''}`}>
          <TabsContent value="audio" className="space-y-4">
            {reviewRequired && <div className="rounded border border-input bg-muted p-3 text-sm space-y-2">
              <p>{t('settings.AudioSettingsModal.029')}</p>
              {importedPlugins.length > 0 && <ul className="max-h-24 overflow-auto break-all">{importedPlugins.map((p, i) => <li key={i}>{p.name} — {p.path}</li>)}</ul>}
              <label className="flex gap-2 text-ui-control"><input type="checkbox" checked={migrationConfirmed} onChange={e => setMigrationConfirmed(e.target.checked)} />{t('settings.AudioSettingsModal.030')}</label>
            </div>}
            {!!error && <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(renderNotice(t, error))} />}

            {loading ? (
              <div role="status" className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                {t('common.loading')}
              </div>
            ) : error ? (
              <div className="space-y-4">
                <div className="text-foreground text-sm text-center py-4 bg-destructive/10 rounded-lg">{renderNotice(t, error)}</div>
                <button onClick={() => setError(null)} className="w-full py-2 bg-primary text-primary-foreground rounded-md text-ui-control">{t('settings.AudioSettingsModal.031')}</button>
                <button onClick={onClose} className="w-full py-2 bg-muted text-foreground rounded-md border border-input text-ui-control">{t('common.close')}</button>
              </div>
            ) : (
              <div className="space-y-6">
                <div id="primary-input-settings" tabIndex={-1}><ProcessInputPanel value={inputSource} onChange={next => {
                  editConnection('source');
                  if (processInput && next.source.kind === 'device') setNeedsDeviceChoice(true);
                  setInputSource(next);
                }} disabled={isApplying} isAsio={isAsio} status={engineStats?.processInput} onChooseConnection={chooseConnection} /></div>
                {/* Input Device */}
                {!processInput && <fieldset className="space-y-3 rounded-xl border border-border p-3">
                  <legend className="px-1 text-ui-heading font-semibold">
                    <label htmlFor={inputId}>{t(isAsio ? 'settings.AudioSettingsModal.037' : pcInput ? 'wizard.pcAudio' : 'settings.AudioSettingsModal.038')}</label>
                  </legend>
                  <select
                    id={inputId}
                    value={needsDeviceChoice ? '' : selectedInputKey}
                    onChange={(e) => { editConnection('input'); setSelectedInputKey(e.target.value); setNeedsDeviceChoice(!e.target.value); }}
                    disabled={filteredInputs.length === 0}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-foreground focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary transition custom-select disabled:opacity-50 text-ui-control"
                  >
                    {(needsDeviceChoice || !selectedInputKey) && <option value="">{t(filteredInputs.length ? 'settings.selectDevice' : 'settings.AudioSettingsModal.040')}</option>}
                    {filteredInputs.map((device, i) => (
                      <option key={`${audioDeviceKey(device)}-${i}`} value={audioDeviceKey(device)} disabled={!device.id && filteredInputs.filter(item => item.name === device.name).length > 1}>{device.name}{filteredInputs.filter(item => item.name === device.name).length > 1 && device.id ? ` (${device.id})` : ''}</option>
                    ))}
                  </select>
                  {isAsio && <p className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.044')}</p>}
                  <MicrophonePermissionGuide />
                </fieldset>

                }
                {/* Smart Input Channel Selector (ASIO Only) */}
                {isAsio && (
                  <div>
                    <InputChannelSelector
                      key={connection.deviceKey}
                      initialChannels={connection.channels}
                      maxChannels={selectedInputDevice?.channels ?? 0}
                      monitorEnabled={connection.monitorInput}
                      onChannelMapped={channels => { editConnection('channels'); connection.setChannels(channels); }}
                    />
                    <OutputChannelSelector value={connection.outputRouting} maxChannels={selectedOutputDevice?.channels ?? 0}
                      disabled={isApplying} onChange={routing => { editConnection('routing'); connection.setOutputRouting(routing); }} />
                  </div>
                )}

                {/* Output Device - Hide for ASIO */}
                {!isAsio && (
                  <fieldset className="space-y-3 rounded-xl border border-border p-3">
                    <legend className="px-1 text-ui-heading font-semibold">{t('settings.AudioSettingsModal.041')}</legend>
                    <select
                    aria-label={t('settings.AudioSettingsModal.042')}
                      value={selectedOutputKey}
                      onChange={(e) => { editConnection('output'); setSelectedOutputKey(e.target.value); }}
                      disabled={filteredOutputs.length === 0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2 text-foreground focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary transition custom-select disabled:opacity-50 text-ui-control"
                    >
                      {!selectedOutputKey && <option value="">{t(filteredOutputs.length ? 'settings.selectDevice' : 'settings.AudioSettingsModal.043')}</option>}
                      {filteredOutputs.map((device, i) => (
                        <option key={`${audioDeviceKey(device)}-${i}`} value={audioDeviceKey(device)} disabled={!device.id && filteredOutputs.filter(item => item.name === device.name).length > 1}>{device.name}{filteredOutputs.filter(item => item.name === device.name).length > 1 && device.id ? ` (${device.id})` : ''}</option>
                      ))}
                    </select>
                  </fieldset>
                )}

                {processInput && <p className="text-ui-support text-muted-foreground">{t('processInput.outputHelp')}</p>}

                {!savedConnection && savedRestoreAvailable && <div className="space-y-1">
                  <button type="button" onClick={() => void restoreSavedConnection()} disabled={isApplying} className="rounded text-ui-support text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">{t('settings.connection.restoreSaved')}</button>
                  <p className="text-ui-support text-muted-foreground">{t('settings.connection.restoreHint')}</p>
                </div>}
                {restoreNotice && <p role="status" className="text-ui-support text-muted-foreground">{restoreNotice}</p>}

              </div>
            )}
            <details id="live-output-settings" onToggle={e => { if (e.currentTarget.open) setLoadOutput(true); }} className="rounded-xl border border-border p-4 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('liveOutput.title')}</summary>
              <LiveOutputPanel autoLoad={loadOutput} outputs={devices.outputs} inputName={inputSource.source.kind === 'process_loopback' ? inputSource.source.config.appName : selectedInputDevice?.name} monitorName={selectedOutputDevice?.name} disabled={loading} onBusyChange={setLoading} />
            </details>
            {/* 配信中に触る配信ミックスはホームのパネルへ移し、ここは機器と接続だけにする（#299）。 */}
            <section aria-labelledby="stream-mix-settings-heading" className="space-y-2 rounded-xl border border-border p-4">
              <h3 id="stream-mix-settings-heading" className="text-ui-heading font-semibold">{t('streamMix.title')}</h3>
              <p className="text-ui-support text-muted-foreground">{t('streamMix.settingsHint')}</p>
              {!streamMixAvailable && <p id="stream-mix-voice-only" className="text-ui-support text-muted-foreground">{t('streamMix.voiceOnly')}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-ui-control"><input type="checkbox" checked={streamMixShown} disabled={!streamMixAvailable} aria-describedby={streamMixAvailable ? undefined : 'stream-mix-voice-only'} onChange={event => saveStreamMixPanel(event.target.checked)} />{t('streamMix.show')}</label>
                <Button type="button" variant="outline" size="sm" disabled={!streamMixAvailable} aria-describedby={streamMixAvailable ? undefined : 'stream-mix-voice-only'} onClick={() => { openStreamMixPanel(); onClose(); }}>{t('streamMix.openHome')}</Button>
              </div>
            </section>

            {!loading && !error && <div className="space-y-6">
                <details ref={tuningDetails} open={tuningOpen} onToggle={event => setTuningOpen(event.currentTarget.open)} className="rounded-xl border border-border p-3 space-y-3">
                  <summary className="cursor-pointer font-semibold text-sm">
                    {t('settings.audioTuning.title')}
                    {/* 現在の接続方式を見出しに出し、ASIOを探す人にもWASAPIの人にも自分の設定だと分かるようにする。サンプル数は中の詳細に置く。 */}
                    <span className="ml-2 text-ui-support font-normal text-muted-foreground">{displayAudioHost(selectedHost)} · {t([128, 512, 1024].includes(selectedBufferSize)
                      ? selectedBufferSize === 128 ? 'settings.AudioSettingsModal.048' : selectedBufferSize === 512 ? 'settings.AudioSettingsModal.051' : 'settings.AudioSettingsModal.054'
                      : 'settings.bufferCustomShort')} · {selectedSampleRate / 1000} kHz</span>
                  </summary>
                {/* Host Selection */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="font-medium text-muted-foreground text-ui-control">{t('settings.AudioSettingsModal.032')}</label>
                    <button
                      onClick={() => fetchDevices(true)}
                      className="link-button min-h-6 min-w-6 rounded-md border border-input px-2 py-1 text-primary hover:bg-muted flex items-center gap-1 transition-colors text-ui-support"
                      title={t('settings.AudioSettingsModal.033')}
                    >
                      <MdRefresh className="w-3 h-3" />
                      {t('settings.AudioSettingsModal.034')}</button>
                  </div>
                  <select
                    ref={hostSelect}
                    aria-label={t('settings.AudioSettingsModal.035')}
                    value={selectedHost}
                    onChange={(e) => { editConnection('host'); setSelectedHost(e.target.value); }}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-foreground focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary transition custom-select text-ui-control"
                  >
                    {!selectedHost && <option value="">{t('settings.AudioSettingsModal.036')}</option>}
                    {availableHosts.map((host) => (
                      <option key={host} value={host}>{displayAudioHost(host)}</option>
                    ))}
                  </select>
                  <p className="text-ui-support text-muted-foreground">{t(isAsio ? 'settings.connection.asioHint' : 'settings.connection.wasapiHint')}</p>
                </div>

                {/* 切替は対象の見出しと同じ行に置く。 */}
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <h3 className="text-ui-heading font-semibold">{t('settings.AudioSettingsModal.047')}</h3>
                  <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-lg">
                    <button
                      type="button" data-tuning-control aria-pressed={!isAdvancedMode}
                      onClick={() => setIsAdvancedMode(false)}
                      className={`${segmentButtonClass(!isAdvancedMode)} text-ui-control`}
                    >
                      {t('settings.AudioSettingsModal.045')}</button>
                    <button
                      type="button" aria-pressed={isAdvancedMode}
                      onClick={() => setIsAdvancedMode(true)}
                      className={`${segmentButtonClass(isAdvancedMode)} text-ui-control`}
                    >
                      {t('settings.AudioSettingsModal.046')}</button>
                  </div>
                </div>

                {/* Simple Mode UI */}
                {!isAdvancedMode ? (
                  <div className="space-y-4">
                    {/* Latency Profile */}
                    <div className="space-y-2">
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
                              onClick={() => { editConnection('buffer'); setSelectedBufferSize(profile.value); }}
                              disabled={disabled}
                              className={`${`
                                        flex flex-col items-center justify-center p-2 rounded-lg border transition-colors
                                        ${selectedBufferSize === profile.value
                                  ? 'bg-selection/15 border-selection text-selection'
                                  : 'bg-background border-input text-muted-foreground hover:border-primary/50'
                                }
                                        ${disabled ? 'opacity-30 cursor-not-allowed bg-muted' : ''}
                                    `} text-ui-control`}
                            >
                              <span className="text-sm font-bold">{profile.label}</span>
                              <span className="text-ui-support">{profile.desc}</span>
                            </button>
                          )
                        })}
                      </div>
                      {/* 3択以外の値（数値で指定した値）でも、現在値が選ばれていないように見せない。 */}
                      {selectedBufferSize > 0 && ![128, 512, 1024].includes(selectedBufferSize) && (
                        <p role="status" className="text-ui-support text-muted-foreground text-center">{t('settings.bufferCustom', { size: selectedBufferSize })}</p>
                      )}
                      {(selectedBufferSize <= 256 || selectedBufferSize >= 1024) && (
                        selectedBufferSize <= 256 ? <InfoPopover label={t('info.fast')}>{t('settings.AudioSettingsModal.057')}</InfoPopover> : <p className="text-ui-support text-muted-foreground text-center">{t('settings.AudioSettingsModal.058')}</p>
                      )}
                    </div>

                    {/* Quality Profile */}
                    <div className="space-y-2">
                      <label className="font-medium text-muted-foreground text-ui-control">{t('settings.AudioSettingsModal.060')}</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: t('settings.AudioSettingsModal.061'), value: 48000, desc: t('settings.AudioSettingsModal.062') },
                          { label: t('settings.AudioSettingsModal.063'), value: 44100, desc: t('settings.AudioSettingsModal.064') },
                        ].map((profile) => (
                          <button
                            type="button" aria-pressed={selectedSampleRate === profile.value}
                            key={profile.value}
                            onClick={() => { editConnection('rate'); setSelectedSampleRate(profile.value); }}
                            className={`${`
                                        flex flex-col items-center justify-center p-2 rounded-lg border transition-colors
                                        ${selectedSampleRate === profile.value
                                ? 'bg-selection/15 border-selection text-selection'
                                : 'bg-background border-input text-muted-foreground hover:border-primary/50'
                              }
                                    `} text-ui-control`}
                          >
                            <span className="text-sm font-bold">{profile.label}</span>
                            <span className="text-ui-support">{profile.desc}</span>
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
                        <label className="font-medium text-muted-foreground text-ui-control">{t('settings.AudioSettingsModal.065')}</label>
                        <select
                    aria-label={t('settings.AudioSettingsModal.066')}
                          value={selectedBufferSize}
                          onChange={(e) => { editConnection('buffer'); setSelectedBufferSize(Number(e.target.value)); }}
                          className="w-full bg-background border border-input rounded-md px-3 py-2 text-foreground focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary transition custom-select text-ui-control"
                        >
                          {supportedBufferSizes.map(size => (
                            <option key={size} value={size}>{size} {t('settings.AudioSettingsModal.067')}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-2 opacity-50 pointer-events-none">
                        <label className="font-medium text-muted-foreground text-ui-control">{t('settings.AudioSettingsModal.068')}</label>
                        <div className="w-full bg-muted border border-input rounded-md px-3 py-2 text-sm text-muted-foreground">
                          {t('settings.AudioSettingsModal.069')}</div>
                      </div>
                    )}

                    {/* Sample Rate */}
                    <div className="space-y-2">
                      <label className="font-medium text-muted-foreground text-ui-control">{t('master.rate')}</label>
                      <select
                    aria-label={t('master.rate')}
                        value={selectedSampleRate}
                        onChange={(e) => { editConnection('rate'); setSelectedSampleRate(Number(e.target.value)); }}
                        className="w-full bg-background border border-input rounded-md px-3 py-2 text-foreground focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary transition custom-select text-ui-control"
                      >
                        {sampleRates.options.map(({ rate, supported }) => (
                          <option key={rate} value={rate} disabled={!supported}>{formatSampleRate(rate)} kHz{!supported ? ` ${t('settings.rateUnsupported')}` : ''}</option>
                        ))}
                      </select>
                      {(sampleRates.inputUnknown || sampleRates.outputUnknown) && <p className="text-ui-support text-muted-foreground">
                        {t(sampleRates.inputUnknown && sampleRates.outputUnknown ? 'settings.rateUnknownBoth' : sampleRates.inputUnknown ? 'settings.rateUnknownInput' : 'settings.rateUnknownOutput')}
                      </p>}
                      {!sampleRates.options.find(option => option.rate === selectedSampleRate)?.supported && <p className="text-ui-support text-warning">{t('settings.rateSelectedUnsupported')}</p>}
                      {!isAsio && (
                        <div className="text-ui-support text-warning flex items-start gap-1.5 bg-warning/10 p-1.5 rounded border border-warning/20 mt-2">
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
                <div className="text-ui-support text-muted-foreground bg-muted/50 rounded p-2 flex items-center justify-between mt-4">
                  <span className="flex items-center gap-1">{t('settings.AudioSettingsModal.068')} <InfoPopover label={t('info.buffer')}>{t('settings.AudioSettingsModal.071')}</InfoPopover></span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-foreground">{selectedBufferMs === null ? t('settings.AudioSettingsModal.072') : `${selectedBufferMs.toFixed(2)} ms`}</span>
                  </div>
                </div>

                {/* Tips Section (Only in Advanced Mode) */}
                {isAdvancedMode && (
                  <details className="text-ui-support text-muted-foreground bg-muted/50 rounded border border-border mt-2">
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
                </details>
                {/* Preset Section */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-3">
                  <SaveScopeSummary kind="io" />
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1"><label className="font-medium text-muted-foreground text-ui-control">{t('settings.AudioSettingsModal.086')}</label><InfoPopover label={t('info.preset')}>{t('settings.AudioSettingsModal.085')}</InfoPopover></span>
                    <div className="flex gap-2">
                      <select
                  aria-label={t('settings.AudioSettingsModal.087')}
                        className="bg-background border border-input rounded px-2 py-1 text-foreground focus:outline-hidden focus:border-primary text-ui-control"
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
                    <label className="flex flex-1 flex-col gap-1 text-muted-foreground text-ui-control">
                      {t('settings.AudioSettingsModal.089')}
                      <input
                        type="text"
                        className="bg-background border border-input rounded px-3 py-1.5 text-sm text-foreground focus:outline-hidden focus:border-primary"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                      />
                    </label>
                    <button
                      onClick={handleSavePreset}
                      disabled={!presetName}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary disabled:opacity-50 transition-colors text-ui-control"
                      title={t('settings.AudioSettingsModal.090')}
                    >
                      <MdSave size={18} />
                    </button>
                    <button
                      onClick={handleDeletePreset}
                      disabled={!presetName || !presets[presetName]}
                      className="p-1.5 rounded hover:bg-card text-muted-foreground hover:text-destructive-text disabled:opacity-50 transition-colors text-ui-control"
                      title={t('settings.AudioSettingsModal.091')}
                    >
                      <MdDelete size={18} />
                    </button>
                  </div>
                </div>

              </div>}
            <details className="rounded-xl border border-border p-4 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.monitor')}</summary>
              <MonitorTrial devices={devices.outputs} disabled={loading} onBusyChange={setLoading} onApplied={async config => { await onConfigChange(config, { audioStarted: true }); await system.refreshEngineRuntimeStats(); }} />
            </details>
          </TabsContent>

          <SoundSettings model={sound} engineStats={engineStats} singingModel={singingModel} liveModel={providedLive ?? localLive}
            isBeginnerMode={isBeginnerMode} settingsBody={settingsBody} soundStart={soundStart}
            onClose={onClose} onOpenVoiceCheck={onOpenVoiceCheck} onPreviewSinging={onPreviewSinging} onSaveSingingProfile={onSaveSingingProfile} onOpenMixing={() => { openStreamMixPanel(); onClose(); }} />
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
            <NumericDetailsSwitch />
            <AuroraDisplaySwitch />
            <div className="space-y-4">
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-foreground text-ui-heading font-semibold">
                  {t('settings.AudioSettingsModal.130')}</h3>
                <RadioGroup value={theme} onValueChange={(v) => setTheme(v as any)} className="grid auto-rows-fr gap-3">
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('light')}>
                    <RadioGroupItem value="light" id="theme-light" />
                    <Label htmlFor="theme-light" className="cursor-pointer flex-1 text-ui-control">
                      <span className="font-bold block">{t('header.light')}</span>
                      <span className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.131')}</span>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('dark')}>
                    <RadioGroupItem value="dark" id="theme-dark" />
                    <Label htmlFor="theme-dark" className="cursor-pointer flex-1 text-ui-control">
                      <span className="font-bold block">{t('header.dark')}</span>
                      <span className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.132')}</span>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('gaming')}>
                    <RadioGroupItem value="gaming" id="theme-gaming" className="text-brand border-brand" />
                    <Label htmlFor="theme-gaming" className="cursor-pointer flex-1 text-ui-control">
                      <span className="font-bold block">{t('header.gaming')}</span>
                      <span className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.133')}</span>
                    </Label>
                  </div>
                </RadioGroup>
              </div>

            </div>



          </TabsContent>

          <TabsContent value="shortcuts" className="space-y-4">
            <ShortcutsPanel onCaptureChange={setCapturingShortcut} />
          </TabsContent>
          <SystemSettings model={system} engineStats={engineStats} loading={loading} setLoading={setLoading} showConfirm={showConfirm}
            onClose={onClose} onOpenWizard={onOpenWizard} onOpenLicense={onOpenLicense} handleRestart={handleRestart}
            canRestart={inputReady && !!selectedOutputDevice && (!reviewRequired || migrationConfirmed)} knownStopped={connection.knownStopped} />
          </div>
        </Tabs>
        {activeTab === 'audio' && !loading && !error && (
          <div className="shrink-0 border-t border-border bg-muted/20 px-4 py-2 flex items-center justify-end gap-3">
            {/* 稼働中の保存は再起動になり、音が途切れることを押す前に示す。 */}
            <div className="min-w-0 space-y-1 text-ui-support text-muted-foreground" id="settings-connection-changes">
              <p>{allowConnectionRetry || connectionRetry ? t('settings.connection.retry') : !savedConnection
                ? inputReady && selectedOutputDevice ? t('settings.connection.firstStart', { host: displayAudioHost(selectedHost), input: processInput ? inputSource.source.kind === 'process_loopback' ? inputSource.source.config.appName : '' : selectedInput, output: selectedOutputDevice.name }) : t('settings.connection.firstStartHint')
                : changedFields.length ? t('settings.connection.changes', { fields: changedFields.join('、') }) : t('settings.connection.unchanged')}</p>
              {streamRunning && <p id="settings-save-restart">{t('settings.saveRestartHint')}</p>}
            </div>
            <Button onClick={handleSave} disabled={loading || !inputReady || !selectedOutputDevice || !canSaveConnection || (reviewRequired && !migrationConfirmed)}
              aria-describedby={`settings-connection-changes${streamRunning ? ' settings-save-restart' : ''}`}
              className="px-5 font-bold text-ui-control">
              {t(streamRunning ? 'settings.saveRestart' : 'settings.AudioSettingsModal.197')}
            </Button>
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

import { ProcessInputPanel } from './ProcessInputPanel';
import { deviceInput, readInputSource, type InputSourceRequest } from '@/lib/inputSource';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { SoundSettings, useSoundSettings } from './SoundSettings';
import { SystemSettings, useSystemSettings } from './SystemSettings';
import { LiveOutputPanel } from './LiveOutputPanel';
import { MixingPanel } from './MixingPanel';
import { MonitorTrial } from './MonitorTrial';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSingingDraft, type SingingDraft } from '../../../hooks/useSingingDraft';
import { useLiveModes, type LiveModesModel } from '@/hooks/useLiveModes';
import { Modal } from '../../ui/modal';
import { MicrophonePermissionGuide } from './MicrophonePermissionGuide';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { MdClose, MdSettings, MdRefresh, MdWarning, MdLightbulb, MdSave, MdDelete, MdPalette, MdFavorite, MdLanguage, MdMic, MdGraphicEq, MdCast, MdKeyboard, MdTune } from 'react-icons/md';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { useTheme } from '../../../hooks/useTheme';
import { InputChannelSelector } from './InputChannelSelector';
import { OutputChannelSelector } from './OutputChannelSelector';
import { readOutputRouting } from '@/lib/audioChannelRouting';
import { ObsConnectionSettings } from './ObsConnectionSettings';
import { APP_INFO } from '../../../constants/appInfo';
import { ShortcutsPanel } from './ShortcutsPanel';
import { AuroraDisplaySwitch, DisplayPurposeSelector, NumericDetailsSwitch } from './DisplayPurposeSelector';
import { REVIEW_KEY } from '@/api/migration';
import { readAudioPreferences, type AudioPreferences } from '@/lib/audioPreferences';
import { segmentButtonClass } from '@/components/ui/segment';
import { audioDeviceKey, useAudioDeviceSelection } from './useAudioDeviceSelection';
import { ConnectionApplyError, useAudioConnectionController } from './useAudioConnectionController';
import { formatSampleRate, sampleRateOptions } from './sampleRateOptions';
import { useRuntimeStats } from '@/hooks/useRuntimeStats';

interface AudioSettingsModalProps {
  liveModel?: LiveModesModel;
  singingModel?: SingingDraft;
  onPreviewSinging?: () => void;
  onSaveSingingProfile?: () => void;
  initialTab?: 'audio' | 'obs' | 'sound';
  initialSection?: 'liveModes' | 'singing' | 'audioTuning';
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
  } = useAudioDeviceSelection({ isOpen, currentSampleRate, currentBufferSize, onError: setError });
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
  const savedConnection = useMemo(() => {
    const saved = currentConfig ?? readAudioPreferences();
    return saved ? { ...saved, sampleRate: currentSampleRate ?? saved.sampleRate,
      bufferSize: currentBufferSize ?? saved.bufferSize } : null;
  }, [isOpen, currentConfig, currentSampleRate, currentBufferSize]);
  const changedFields = !savedConnection ? [t('settings.connection.new')] : [
    JSON.stringify(inputSource.source) !== JSON.stringify(savedConnection.inputSource ?? deviceInput()) && '入力元・用途',
    processInput && inputSource.candidateId && 'アプリの選択',
    selectedHost.toLowerCase() !== savedConnection.host.toLowerCase() && t('settings.AudioSettingsModal.032'),
    !processInput && (selectedInput !== (savedConnection.input ?? '') || (savedConnection.inputId && selectedInputDevice?.id !== savedConnection.inputId)) && t('settings.AudioSettingsModal.038'),
    ((isAsio ? selectedInput : selectedOutput) !== (savedConnection.output ?? '') || (savedConnection.outputId && selectedOutputDevice?.id !== savedConnection.outputId)) && t('settings.AudioSettingsModal.041'),
    selectedBufferSize !== (savedConnection.bufferSize ?? 512) && t('settings.AudioSettingsModal.047'),
    selectedSampleRate !== (savedConnection.sampleRate ?? 48000) && t('settings.AudioSettingsModal.060'),
    (isAsio && connection.channels.some((channel, index) => channel !== (savedConnection.inputChannels ?? currentInputChannels ?? [0, 1])[index])) && t('settings.InputChannelSelector.205'),
    (isAsio && JSON.stringify(connection.outputRouting) !== JSON.stringify(savedConnection.outputRouting ?? { mode: 'legacy' })) && t('settings.routing.title'),
  ].filter((value): value is string => typeof value === 'string');
  const hasConnectionChanges = changedFields.length > 0;

  // Simple/Advanced Mode
  const [isAdvancedMode, setIsAdvancedMode] = useState(() => {
    // Initialize from localStorage
    return localStorage.getItem('vst_host_settings_advanced') === 'true';
  });
  useEffect(() => {
    if (isOpen && ![128, 512, 1024].includes(selectedBufferSize)) setIsAdvancedMode(true);
  }, [isOpen, selectedBufferSize]);
  const tuningDetails = useRef<HTMLDetailsElement>(null);
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
  const soundStart = useRef<HTMLHeadingElement>(null);
  useEffect(() => { settingsBody.current?.scrollTo?.({ top: 0 }); }, [activeTab]);
  useEffect(() => {
    if (isOpen && initialTab === 'sound') {
      const frame = requestAnimationFrame(() => {
        const target = initialSection ? settingsBody.current?.querySelector<HTMLDetailsElement>(initialSection === 'liveModes' ? '#live-mode-settings' : '#singing-settings') : soundStart.current;
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView?.({ block: 'start' });
        if (initialSection) target?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
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

  const sound = useSoundSettings(engineStats, singingModel, initialSection);
  const system = useSystemSettings({ isOpen, currentSampleRate, currentBufferSize, isBeginnerMode, showConfirm });

  const sampleRates = sampleRateOptions(selectedInputDevice, selectedOutputDevice, isAsio, selectedSampleRate, currentSampleRate);

  const selectedBufferMs = Number.isFinite(selectedBufferSize) && selectedBufferSize > 0 && Number.isFinite(selectedSampleRate) && selectedSampleRate > 0
    ? selectedBufferSize / selectedSampleRate * 1000 : null;

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
      setError(err instanceof ConnectionApplyError ? notice(err.stage === 'channels' ? 'settings.connectionChannelsIncomplete' : 'settings.connectionSaveIncomplete', { arg0: err.message }) : notice('settings.AudioSettingsModal.017', { arg0: String(err) }));
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
      setError(err instanceof ConnectionApplyError ? notice(err.stage === 'channels' ? 'settings.connectionChannelsIncomplete' : 'settings.connectionSaveIncomplete', { arg0: err.message }) : notice('settings.AudioSettingsModal.020', { arg0: String(err) }));
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
      if (!source) { setError('このプリセットの入力形式に対応していません。音声設定で選び直してください。'); return; }
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
        <div className="fixed inset-0 z-[100] flex justify-end bg-background/80 backdrop-blur-sm">
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
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary focus:not-focus-visible:outline-none"
          >
            <MdClose className="w-5 h-5" />
          </button>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} orientation="vertical" className="flex min-h-0 flex-1">
          <TabsList aria-label={t('common.settings')} className="h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none border-r border-border p-2 overflow-y-auto">
            <TabsTrigger className="justify-start gap-2" value="audio"><MdMic aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.audio')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2" value="sound"><MdGraphicEq aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.sound')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2" value="obs"><MdCast aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.obs')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2" value="appearance"><MdPalette aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.appearance')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2" value="shortcuts"><MdKeyboard aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.shortcuts')}</TabsTrigger>
            <TabsTrigger className="justify-start gap-2" value="system"><MdTune aria-hidden="true" className="h-4 w-4 shrink-0" />{t('settings.system')}</TabsTrigger>
          </TabsList>
          <div ref={settingsBody} className="min-w-0 flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent">
          <TabsContent value="audio" className="space-y-4">
            {reviewRequired && <div className="rounded border border-input bg-muted p-3 text-sm space-y-2">
              <p>{t('settings.AudioSettingsModal.029')}</p>
              {importedPlugins.length > 0 && <ul className="max-h-24 overflow-auto break-all">{importedPlugins.map((p, i) => <li key={i}>{p.name} — {p.path}</li>)}</ul>}
              <label className="flex gap-2"><input type="checkbox" checked={migrationConfirmed} onChange={e => setMigrationConfirmed(e.target.checked)} />{t('settings.AudioSettingsModal.030')}</label>
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
                      className="link-button min-h-6 min-w-6 rounded-md border border-input px-2 py-1 text-xs text-primary hover:bg-muted flex items-center gap-1 transition-colors"
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
                  <p className="text-xs text-muted-foreground">{t(isAsio ? 'settings.connection.asioHint' : 'settings.connection.wasapiHint')}</p>
                </div>

                <ProcessInputPanel value={inputSource} onChange={next => {
                  if (processInput && next.source.kind === 'device') setNeedsDeviceChoice(true);
                  setInputSource(next);
                }} disabled={isApplying} isAsio={isAsio} status={engineStats?.processInput} />
                {/* Input Device */}
                {!processInput && <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">
                    {isAsio ? t('settings.AudioSettingsModal.037') : t('settings.AudioSettingsModal.038')}
                  </label>
                  <select
                    aria-label={t('settings.AudioSettingsModal.039')}
                    value={needsDeviceChoice ? '' : selectedInputKey}
                    onChange={(e) => { setSelectedInputKey(e.target.value); setNeedsDeviceChoice(!e.target.value); }}
                    disabled={filteredInputs.length === 0}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select disabled:opacity-50"
                  >
                    {(needsDeviceChoice || !selectedInputKey) && <option value="">{t(filteredInputs.length ? 'settings.selectDevice' : 'settings.AudioSettingsModal.040')}</option>}
                    {filteredInputs.map((device, i) => (
                      <option key={`${audioDeviceKey(device)}-${i}`} value={audioDeviceKey(device)} disabled={!device.id && filteredInputs.filter(item => item.name === device.name).length > 1}>{device.name}{filteredInputs.filter(item => item.name === device.name).length > 1 && device.id ? ` (${device.id})` : ''}</option>
                    ))}
                  </select>
                </div>

                }
                {/* Smart Input Channel Selector (ASIO Only) */}
                {isAsio && (
                  <div>
                    <InputChannelSelector
                      key={connection.deviceKey}
                      initialChannels={connection.channels}
                      maxChannels={selectedInputDevice?.channels ?? 0}
                      monitorEnabled={connection.monitorInput}
                      onChannelMapped={connection.setChannels}
                    />
                    <OutputChannelSelector value={connection.outputRouting} maxChannels={selectedOutputDevice?.channels ?? 0}
                      disabled={isApplying} onChange={connection.setOutputRouting} />
                  </div>
                )}

                {/* Output Device - Hide for ASIO */}
                {!isAsio && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">{t('settings.AudioSettingsModal.041')}</label>
                    <select
                    aria-label={t('settings.AudioSettingsModal.042')}
                      value={selectedOutputKey}
                      onChange={(e) => setSelectedOutputKey(e.target.value)}
                      disabled={filteredOutputs.length === 0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition custom-select disabled:opacity-50"
                    >
                      {!selectedOutputKey && <option value="">{t(filteredOutputs.length ? 'settings.selectDevice' : 'settings.AudioSettingsModal.043')}</option>}
                      {filteredOutputs.map((device, i) => (
                        <option key={`${audioDeviceKey(device)}-${i}`} value={audioDeviceKey(device)} disabled={!device.id && filteredOutputs.filter(item => item.name === device.name).length > 1}>{device.name}{filteredOutputs.filter(item => item.name === device.name).length > 1 && device.id ? ` (${device.id})` : ''}</option>
                      ))}
                    </select>
                  </div>
                )}

                {processInput && <p className="text-xs text-muted-foreground">加工後の音を返す出力先です。原音の再生先とは別の機器を選んでください。</p>}
                {isAsio && (
                  <div className="text-xs text-muted-foreground mt-2 p-2 bg-muted rounded border border-border">
                    <p>{t('settings.AudioSettingsModal.044')}</p>
                  </div>
                )}

                <details ref={tuningDetails} open={tuningOpen} onToggle={event => setTuningOpen(event.currentTarget.open)} className="rounded-xl border border-border p-3 space-y-3">
                  <summary className="cursor-pointer font-semibold text-sm">
                    {t('settings.audioTuning.title')}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{t([128, 512, 1024].includes(selectedBufferSize)
                      ? selectedBufferSize === 128 ? 'settings.AudioSettingsModal.048' : selectedBufferSize === 512 ? 'settings.AudioSettingsModal.051' : 'settings.AudioSettingsModal.054'
                      : 'settings.bufferCustom', { size: selectedBufferSize })} · {selectedSampleRate / 1000} kHz</span>
                  </summary>
                {/* 切替は対象の見出しと同じ行に置く。 */}
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <h3 className="text-sm font-medium">{t('settings.AudioSettingsModal.047')}</h3>
                  <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-lg">
                    <button
                      type="button" data-tuning-control aria-pressed={!isAdvancedMode}
                      onClick={() => setIsAdvancedMode(false)}
                      className={segmentButtonClass(!isAdvancedMode)}
                    >
                      {t('settings.AudioSettingsModal.045')}</button>
                    <button
                      type="button" aria-pressed={isAdvancedMode}
                      onClick={() => setIsAdvancedMode(true)}
                      className={segmentButtonClass(isAdvancedMode)}
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
                            type="button" aria-pressed={selectedSampleRate === profile.value}
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
                        {sampleRates.options.map(({ rate, supported }) => (
                          <option key={rate} value={rate} disabled={!supported}>{formatSampleRate(rate)} kHz{!supported ? ` ${t('settings.rateUnsupported')}` : ''}</option>
                        ))}
                      </select>
                      {(sampleRates.inputUnknown || sampleRates.outputUnknown) && <p className="text-xs text-muted-foreground">
                        {t(sampleRates.inputUnknown && sampleRates.outputUnknown ? 'settings.rateUnknownBoth' : sampleRates.inputUnknown ? 'settings.rateUnknownInput' : 'settings.rateUnknownOutput')}
                      </p>}
                      {!sampleRates.options.find(option => option.rate === selectedSampleRate)?.supported && <p className="text-xs text-warning">{t('settings.rateSelectedUnsupported')}</p>}
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
                </details>
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
            <MixingPanel inputs={devices.inputs} primaryInputId={selectedInputDevice?.id} primaryIsVoiceDevice={inputSource.source.kind === 'device' && inputSource.source.config.purpose === 'voice'} disabled={loading} onBusyChange={setLoading} />
            <MonitorTrial devices={devices.outputs} disabled={loading} onBusyChange={setLoading} onApplied={async config => { await onConfigChange(config, { audioStarted: true }); await system.refreshEngineRuntimeStats(); }} />
            </details>
            {!error && <MicrophonePermissionGuide />}
          </TabsContent>

          <SoundSettings model={sound} engineStats={engineStats} singingModel={singingModel} liveModel={providedLive ?? localLive}
            isBeginnerMode={isBeginnerMode} settingsBody={settingsBody} soundStart={soundStart}
            onClose={onClose} onOpenVoiceCheck={onOpenVoiceCheck} onPreviewSinging={onPreviewSinging} onSaveSingingProfile={onSaveSingingProfile} />
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
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2 text-foreground">
                  <MdPalette className="w-4 h-4 text-primary" /> {t('settings.AudioSettingsModal.130')}</h3>
                <RadioGroup value={theme} onValueChange={(v) => setTheme(v as any)} className="grid auto-rows-fr gap-3">
                  <div className="flex items-center space-x-2 border border-border p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setTheme('light')}>
                    <RadioGroupItem value="light" id="theme-light" />
                    <Label htmlFor="theme-light" className="cursor-pointer flex-1">
                      <span className="font-bold block">{t('header.light')}</span>
                      <span className="text-xs text-muted-foreground">{t('settings.AudioSettingsModal.131')}</span>
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
          <SystemSettings model={system} engineStats={engineStats} loading={loading} setLoading={setLoading} showConfirm={showConfirm}
            onClose={onClose} onOpenWizard={onOpenWizard} handleRestart={handleRestart}
            canRestart={inputReady && !!selectedOutputDevice && (!reviewRequired || migrationConfirmed)} knownStopped={connection.knownStopped} />
          </div>
        </Tabs>
        {activeTab === 'audio' && !loading && !error && (
          <div className="shrink-0 border-t border-border bg-muted/20 px-4 py-2 flex items-center justify-end gap-3">
            {/* 稼働中の保存は再起動になり、音が途切れることを押す前に示す。 */}
            <div className="min-w-0 space-y-1 text-xs text-muted-foreground" id="settings-connection-changes">
              <p>{allowConnectionRetry || connectionRetry ? t('settings.connection.retry') : hasConnectionChanges ? t('settings.connection.changes', { fields: changedFields.join('、') }) : t('settings.connection.unchanged')}</p>
              {streamRunning && <p id="settings-save-restart">{t('settings.saveRestartHint')}</p>}
            </div>
            <button onClick={handleSave} disabled={loading || !inputReady || !selectedOutputDevice || !canSaveConnection || (reviewRequired && !migrationConfirmed)}
              aria-describedby={`settings-connection-changes${streamRunning ? ' settings-save-restart' : ''}`}
              className="rounded-md bg-primary px-5 py-2 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {t(streamRunning ? 'settings.saveRestart' : 'settings.AudioSettingsModal.197')}
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

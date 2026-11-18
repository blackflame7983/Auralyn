import { ThemeSwatch } from './ThemeSwatch';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ProcessInputPanel } from './ProcessInputPanel';
import { deviceInput, readInputSource, withInputPurpose, type InputSourceRequest } from '@/lib/inputSource';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { SaveScopeSummary } from '../Presets/SaveScopeSummary';
import { connectionDeviceKey, resolveAudioDevice } from '@/lib/audioDevices';
import { SoundSettings, useSoundSettings } from './SoundSettings';
import { singingDraftIsDirty, SingingGuideHelp } from './SingingControls';
import { SystemSettings, useSystemSettings } from './SystemSettings';
import { LiveOutputPanel } from './LiveOutputPanel';
import { Button } from '@/components/ui/button';
import { UserDocLink } from '@/components/ui/UserDocLink';
import { openStreamMixPanel, saveStreamMixPanel, useStreamMixPanel } from '@/lib/streamMixPanel';
import { useDisplayPurpose, type DisplayPurpose } from '@/hooks/useDisplayPurpose';
import { MonitorTrial, monitorTrialInUse } from './MonitorTrial';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSingingDraft, type SingingDraft } from '../../../hooks/useSingingDraft';
import { useLiveModes, type LiveModesModel } from '@/hooks/useLiveModes';
import { PagePortal } from '@/components/layout/pageSlot';
import { PageHeading } from '@/components/layout/PageHeading';
import { allowNextLeave, requestLeave } from '@/components/layout/pageLeave';
import { requestOpenRack } from '@/components/layout/openRackBridge';
import type { SoundPlace } from '@/hooks/useUIState';
import { MicrophonePermissionGuide } from './MicrophonePermissionGuide';
import React, { useCallback, useId, useState, useMemo, useRef } from 'react';
import { MdRefresh, MdWarning, MdLightbulb, MdSave, MdDelete } from 'react-icons/md';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { useTheme } from '../../../hooks/useTheme';
import { InputChannelSelector } from './InputChannelSelector';
import { OutputChannelSelector } from './OutputChannelSelector';
import { channelRoutingFor, readOutputRouting, type ChannelRouting } from '@/lib/audioChannelRouting';
import { ObsConnectionSettings } from './ObsConnectionSettings';
import { ShortcutsPanel } from './ShortcutsPanel';
import { MeasuredSaveBar, SaveBarScope } from './saveBarInset';
import { NumericDetailsSwitch } from './DisplayPurposeSelector';
import { UsageSwitch } from './UsageSwitch';
import { REVIEW_KEY } from '@/api/migration';
import { readAudioPreferences, savedAudioPreferences, UNSET_BUFFER_SIZE, UNSET_SAMPLE_RATE, type AudioPreferences } from '@/lib/audioPreferences';
import { usageRouting, type UsageDeviceRecord } from '@/lib/usageDevices';
import { commitDisplaySwitch, commitUsageSwitch, currentUsage, rememberAppliedUsage, rollbackUsageSwitch, snapshotUsageStorage, type LeavingUsage, type UsageSetupGoal } from '@/lib/usageSwitch';
import type { SessionRestoreOutcome } from '@/lib/rackRestoreOutcome';
import { resumableInputSource } from '@/lib/processInputRestore';
import { audioApi } from '@/api/audio';
import { displayAudioHost } from '@/lib/audioDevices';
import { cableReceiverName } from '@/lib/audioRouting';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { audioDeviceKey, useAudioDeviceSelection } from './useAudioDeviceSelection';
import { ConnectionApplyError, ConnectionStartError, runningConnection, useAudioConnectionController } from './useAudioConnectionController';
import { formatSampleRate, sampleRateOptions } from './sampleRateOptions';
import { useRuntimeStats } from '@/hooks/useRuntimeStats';
import { useWhenTrue } from '@/hooks/useWhenTrue';
import { useFocusRequest } from '@/hooks/useFocusRequest';
import { useSavedConnection, useSavedRestoreAvailable } from './useSavedConnection';
import { useLiveOutputInUse } from './useLiveOutputInUse';
import { useAdvancedModePreference, useBeginnerModeSync, useSettingsLeaveGuard } from './useSettingsPreferences';
import { useActiveSettingsTab, useSoundPlace, type SettingsSection, type SettingsTab } from './useSettingsNavigation';
import { useDeviceTargetFocus, useSettingsPageFocus, useSettingsScroller, useTuningSection } from './useSettingsPageFocus';
import { useAudioPresets } from './useAudioPresets';

interface PendingUsage {
  target: DisplayPurpose;
  leaving: LeavingUsage;
  /** 切り替える前に音声が動いていたか。元へ戻すとき、動いていたときだけ再起動する。 */
  running: boolean;
  /** 切り替える前の保存値を、元の文字列のまま書き戻す。 */
  rewind: () => boolean;
}

interface AudioSettingsModalProps {
  liveModel?: LiveModesModel;
  singingModel?: SingingDraft;
  onPreviewSinging?: () => void;
  onSaveSingingProfile?: () => void;
  initialTab?: SettingsTab;
  /** 移動の依頼ごとに増える番号。同じ移動先を続けて頼まれても切り替える。 */
  tabRequest?: number;
  /** 区分の切替を、未保存の確認を通す親の入口へ渡す。無いときはこの画面の中で切り替える。 */
  onRequestTab?: (tab: SettingsTab) => void;
  initialSection?: SettingsSection;
  /** 音づくりの小区分。親が持つとき、ページを離れても下書きの確認を同じ規則で出す。 */
  soundPlace?: SoundPlace;
  soundFocusNonce?: number;
  /** ホームの「周囲の音を測る」から開くたびに増える。 */
  measurementNonce?: number;
  onSoundPlace?: (place: SoundPlace, focus?: boolean) => void;
  isAudioRunning?: boolean;
  allowConnectionRetry?: boolean;
  currentConfig?: AudioPreferences;
  isOpen: boolean;
  onClose: () => void;
  onConfigChange: (config: Partial<import('../../../lib/audioPreferences').AudioPreferences> & { host: string }, options?: { audioStarted: true }) => void | Promise<void>;
  /** 再起動で失われた VST を保存した構成から戻し、結果を返す。completed 以外は、戻せていないものとして扱う。 */
  onEngineRestarted?: () => Promise<SessionRestoreOutcome>;
  onOpenWizard?: (goal?: UsageSetupGoal) => void;
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
  initialTab = 'audio', tabRequest = 0, onRequestTab, initialSection, soundPlace: soundPlaceProp, soundFocusNonce = 0, measurementNonce = 0, onSoundPlace,
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
  const outputId = useId();
  const presetSummaryId = useId();
  const localSinging = useSingingDraft();
  const localLive = useLiveModes();
  const singingModel = providedSinging ?? localSinging;
  const { theme, setTheme } = useTheme();
  const [isApplying, setLoading] = useState(false);
  // 使い道の切り替えの応答を待つ間。画面は残したまま、画面を離れる操作だけを止める。
  const [usageSwitching, setUsageSwitching] = useState(false);
  // アプリの音声の記録へ切り替えた下書き。接続を保存するまで、表示も離れる使い道の記録も確定しない。
  // 表示の確定に失敗したときに元へ戻せるよう、切り替える前の音声の状態と保存値を持つ。
  const [pendingUsage, setPendingUsage] = useState<PendingUsage | null>(null);
  useWhenTrue(isOpen, () => setPendingUsage(null));
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
  const [startStateUnknown, setStartStateUnknown] = useState(false);
  useWhenTrue(!isOpen || !error, () => setStartStateUnknown(false));
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
  useWhenTrue(isOpen, () => setInputSource({ source: (currentConfig ?? readAudioPreferences())?.inputSource ?? deviceInput() }));
  const [needsDeviceChoice, setNeedsDeviceChoice] = useState(false);
  const [appFocus, setAppFocus] = useState(0);
  useWhenTrue(isOpen, () => setNeedsDeviceChoice(false));
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
  useWhenTrue(isOpen, () => setEditedFields(new Set()));
  const savedConnection = useSavedConnection({ isOpen, currentConfig, currentSampleRate, currentBufferSize });
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
  const savedRestoreAvailable = useSavedRestoreAvailable(isOpen && !savedConnection);
  const [restoreNotice, setRestoreNotice] = useState('');
  const restoreSavedConnection = async () => {
    if (isApplying) return;
    setError(null);
    setLoading(true); setRestoreNotice('');
    try {
      const saved = await audioApi.getSavedAudioConfig();
      if (!saved) { setRestoreNotice(t('settings.connection.noSaved')); return; }
      const restored = savedAudioPreferences(saved);
      if (!restored) throw new Error('Invalid saved connection');
      const source = restored.inputSource ?? deviceInput();
      const outputRouting = restored.outputRouting ?? { mode: 'legacy' as const };
      restored.inputSource = source;
      restored.outputRouting = outputRouting;
      // 保存済み選択の復帰だけを通知する。音声開始済みの通知やStartは送らない。
      await onConfigChange(restored);
      setInputSource({ source }); setNeedsDeviceChoice(false);
      if (restored.sampleRate !== undefined) setSelectedSampleRate(restored.sampleRate);
      if (restored.bufferSize !== undefined) setSelectedBufferSize(restored.bufferSize);
      const listed = await fetchDevices(false);
      const restoredInput = listed && resolveAudioDevice(listed.inputs, saved.host, saved.input, saved.input_id);
      if (restoredInput) connection.setRoutingForDevice(connectionDeviceKey(saved.host, restoredInput), {
        inputChannels: restored.inputChannels, outputRouting });
      setEditedFields(new Set());
      setRestoreNotice(t('settings.connection.restored'));
    } catch { setRestoreNotice(t('settings.connection.restoreFailed')); }
    finally { setLoading(false); }
  };

  // Simple/Advanced Mode
  const [isAdvancedMode, setIsAdvancedMode] = useAdvancedModePreference(isOpen, selectedBufferSize);
  const streamMixShown = useStreamMixPanel();
  // パネルはホームが歌・雑談の表示のときだけ出る。音楽鑑賞では押しても何も出ないため、理由を示して止める。
  const [savedDisplay] = useDisplayPurpose();
  const displayPurpose = pendingUsage?.target ?? savedDisplay;
  const streamMixAvailable = displayPurpose === 'voice';
  const liveOutputActive = useLiveOutputInUse(displayPurpose);
  const monitorActive = displayPurpose === 'music' && monitorTrialInUse();
  const mixActive = displayPurpose === 'music' && streamMixShown;
  const streamingActive = liveOutputActive || monitorActive || mixActive;

  // Tab State
  const [activeTab, setActiveTab] = useActiveSettingsTab(initialTab, tabRequest);
  const [shortcutsDirty, setShortcutsDirty] = useState(false);
  const [peakPending, setPeakPending] = useState({ peak: false, broadcast: false });
  const protectionPending = peakPending.peak || peakPending.broadcast;
  const onPeakPending = useCallback((source: 'peak' | 'broadcast', pending: boolean) => {
    setPeakPending(current => current[source] === pending ? current : { ...current, [source]: pending });
  }, []);
  useSettingsLeaveGuard({ isApplying: isApplying || usageSwitching, activeTab, hasConnectionChanges, shortcutsDirty, protectionPending });
  const isBeginnerMode = useBeginnerModeSync();

  const { settingsBody, scrollerEl, saveSlot, bindScroller, bindSlot } = useSettingsScroller();
  const { loadOutput, setLoadOutput } = useDeviceTargetFocus({ isOpen, initialSection, loading, hasError: !!error, activeTab, tabRequest, settingsBody });
  const { soundPlace, chooseSoundPlace, focusNonce } = useSoundPlace({ initialSection, tabRequest, soundPlaceProp, soundFocusNonce, onSoundPlace });
  const headingRef = useSettingsPageFocus({ isOpen, initialSection, activeTab, tabRequest, soundPlace, focusNonce, settingsBody });

  // Autostart State
  const engineStats = useRuntimeStats(isOpen);
  const streamRunning = isAudioRunning ?? engineStats?.latencyMetadata?.streamRunning === true;
  // 停止中は「開始」が必要。稼働中の変更なし保存だけを抑止する。
  const canSaveConnection = !streamRunning || hasConnectionChanges || reviewRequired || allowConnectionRetry || connectionRetry;
  // 途切れる注意は、音声が動いていて接続の変更があるときだけ出す（#588）。
  const showSaveRestartHint = streamRunning && hasConnectionChanges;
  // 切り替えを伴わない保存では、記録を残せなくても接続の保存は済んでいる。機器の記憶だけが残らない。
  // 保留した切り替えの保存は、表示の確定がまとめて残し、残せなければ切り替え全体を元へ戻す。
  const rememberSavedUsage = () => {
    if (pendingUsage) return;
    try { rememberAppliedUsage(readAudioPreferences()); } catch { /* 接続の保存は済んでいる。 */ }
  };
  // 保存した接続・使い道の記録のどちらからでも、接続の欄の選択へ映せる形。
  interface ConnectionSelection {
    host: string; input?: string; inputId?: string; output?: string; outputId?: string;
    sampleRate: number; bufferSize: number; routing: ChannelRouting;
  }
  const selectionOfRecord = (record: UsageDeviceRecord): ConnectionSelection => ({ ...record, routing: usageRouting(record) });
  const selectionOfSaved = (saved: AudioPreferences): ConnectionSelection => ({
    ...saved, sampleRate: saved.sampleRate ?? UNSET_SAMPLE_RATE, bufferSize: saved.bufferSize ?? UNSET_BUFFER_SIZE, routing: channelRoutingFor(saved) });
  // 選んだ機器を、接続の欄の選択へ映す。決定済みなら変更なし、下書きなら未保存の変更として扱う。
  const showConnectionSelection = (selection: ConnectionSelection, draft: boolean) => {
    setSelectedHost(selection.host);
    setSelectedSampleRate(selection.sampleRate);
    setSelectedBufferSize(selection.bufferSize);
    setSelectedInputKey(selection.inputId ? `id:${selection.inputId}` : selection.input ?? '');
    setSelectedOutputKey(selection.outputId ? `id:${selection.outputId}` : selection.output ?? '');
    const inputDevice = resolveAudioDevice(devices.inputs, selection.host, selection.input, selection.inputId);
    if (selection.host.toLowerCase() === 'asio' && inputDevice) connection.setRoutingForDevice(connectionDeviceKey(selection.host, inputDevice), selection.routing);
    if (draft) editConnection('host', 'output', 'buffer', 'rate'); else setEditedFields(new Set());
  };
  // 再起動で失われた VST を戻す。移行の確認が済んでいない間は切り替えを止めているため、確認を飛ばして復元することはない。
  const restoreVst = async () => {
    if (onEngineRestarted && await onEngineRestarted() !== 'completed') throw new Error(t('purpose.vstIncomplete'));
  };
  // アプリの音声は、いま起動しているアプリの候補を引き直さないと再開できない。見つからなければ、戻せなかったと伝える。
  const restoreSourceRequest = async (config: AudioPreferences): Promise<InputSourceRequest | undefined> => {
    const source = config.inputSource;
    if (!source) return undefined;
    const request = await resumableInputSource(source);
    if (!request) throw new Error(t('purpose.appNotRunning', { app: source.kind === 'process_loopback' ? source.config.appName : '' }));
    return request;
  };
  // 元の接続へ戻す。engine が true のときは元の接続で再起動し、VST も戻す。画面の保持値も元へそろえる。
  const restoreUsageConnection = async (config: AudioPreferences, engine: boolean) => {
    try {
      if (engine) {
        const source = await restoreSourceRequest(config);
        await audioApi.restart(config.host, config.input, config.output, config.bufferSize, config.sampleRate, config.inputId, config.outputId,
          undefined, channelRoutingFor(config), source);
      }
    } finally {
      await onConfigChange({ ...config, outputRouting: config.outputRouting ?? { mode: 'legacy' } });
    }
    if (engine) await restoreVst();
  };
  const applyUsage = async (record: UsageDeviceRecord) => {
    const target = displayPurpose === 'voice' ? 'music' : 'voice';
    if (record.inputSource.kind === 'process_loopback') {
      // アプリの音声は、起動中のアプリを選び直さないと始められない。音も保存値も変えず、表示と入力の用途を下書きにして選択へ案内する。
      setPendingUsage({ target, leaving: currentUsage(), running: streamRunning, rewind: snapshotUsageStorage() });
      setInputSource({ source: withInputPurpose(record.inputSource, target) });
      setNeedsDeviceChoice(false);
      editConnection('source');
      showConnectionSelection(selectionOfRecord(record), true);
      return;
    }
    const applied = await commitUsageSwitch({
      target, record, running: streamRunning,
      restart: async next => {
        const result = await audioApi.restart(next.host, next.input, next.output, next.bufferSize, next.sampleRate,
          next.inputId, next.outputId, undefined, usageRouting(next), { source: next.inputSource });
        return { sampleRate: result.sample_rate, bufferSize: result.buffer_size, routing: result.routing };
      },
      save: async (config, options) => {
        await onConfigChange(config, options);
        if (options?.audioStarted) await restoreVst();
      },
      restore: restoreUsageConnection,
      engineIntact: async () => !!(await runningConnection()),
    });
    setInputSource({ source: applied.inputSource });
    setNeedsDeviceChoice(false);
    showConnectionSelection(selectionOfRecord(applied), false);
  };
  // 失敗の通知は上のほうに出る。保存の操作でページが下へ送られていても、結果が見える所へ焦点を移す。
  const [errorFocus, setErrorFocus] = useState(0);
  // 使い道の切り替えの失敗。接続の適用の失敗（error）とは別に持ち、元へ戻したあとの操作だけを出す。
  const [usageFailure, setUsageFailure] = useState<{ message: SettingsNotice; restored: boolean } | null>(null);
  useWhenTrue(isOpen, () => setUsageFailure(null));
  const errorPanel = useRef<HTMLDivElement>(null);
  useFocusRequest(isApplying ? 0 : errorFocus, async () => {}, errorPanel);
  // 表示の確定に失敗したら、切り替え全体の失敗として、通常の切り替えと同じ巻き戻しで元へ戻す。
  // 接続の下書きも捨て、画面の選択を切り替え前の保存済みの接続へそろえる。
  const rollBackPendingUsage = async (pending: PendingUsage, cause: unknown) => {
    let { failed, reason } = await rollbackUsageSwitch({ previous: pending.leaving.preferences, rewind: pending.rewind,
      running: pending.running, restarted: true, saveStarted: true, restore: restoreUsageConnection });
    // 動いていなかった音声は、保存のときに新しい接続で動き出している。切り替える前のとおり止める。
    if (!pending.running) {
      try { await audioApi.stop(); } catch (stopCause) {
        failed = [...failed, 'audio'];
        reason ||= stopCause instanceof Error ? stopCause.message : String(stopCause);
      }
    }
    setPendingUsage(null);
    discardConnectionDraft(pending.leaving);
    setConnectionRetry(false);
    setErrorFocus(request => request + 1);
    const reasons = [cause instanceof Error ? cause.message : String(cause), reason].filter(Boolean)
      .map(text => text.replace(/[\s。.]+$/, '')).join(t('wizard.rewindSeparator'));
    const notRestored = (['audio', 'saved'] as const).filter(target => failed.includes(target))
      .map(target => t(`wizard.rewind.${target}`)).join(t('wizard.rewindSeparator'));
    setUsageFailure({ restored: !notRestored, message: notRestored
      ? notice('purpose.commitRestoreFailed', { targets: notRestored, reason: reasons })
      : notice('purpose.commitFailed', { reason: reasons }) });
  };
  // 接続の下書き（入力元・機器・経路・変更の印）を捨てて、切り替え前の保存済みの接続を画面へ映す。
  // 使い道ごとの記録とは照らさない。表示と入力の用途が違う既存の状態でも、保存したとおりの機器へ戻す。
  const discardConnectionDraft = (leaving: LeavingUsage) => {
    const previous = leaving.preferences;
    setInputSource({ source: previous?.inputSource ?? deviceInput() });
    setNeedsDeviceChoice(false);
    if (previous?.host) showConnectionSelection(selectionOfSaved(previous), false); else setEditedFields(new Set());
  };
  // 接続を保存できたら、保留していた表示の切り替えと、保存した接続・離れる使い道の記録を確定する。
  const commitPendingUsage = async (): Promise<boolean> => {
    if (!pendingUsage) return true;
    try {
      commitDisplaySwitch(pendingUsage.leaving, pendingUsage.target, readAudioPreferences());
      setPendingUsage(null);
      return true;
    } catch (cause) {
      await rollBackPendingUsage(pendingUsage, cause);
      return false;
    }
  };
  const liveModel = providedLive ?? localLive;
  // 保存のボタンと同じ条件で、切り替えも止める。移行の確認を飛ばして確認済みにしない。
  // 動いている音声の再起動は、移行の確認を完了する通知を起こし、通知が始める VST の復元は結果を待てない。確認は先に通常の保存で終えてもらう。
  const usageBlockedReason = pendingUsage ? t('purpose.blockedPending')
    : reviewRequired && streamRunning ? t('purpose.blockedReviewRunning')
    : reviewRequired && !migrationConfirmed ? t('purpose.blockedReview') : devicesLoading ? t('purpose.blockedLoading') : undefined;
  const { tuningOpen, setTuningOpen, tuningDetails, hostSelect, chooseConnection } = useTuningSection({
    isOpen, initialSection, loading, hasError: !!error, activeTab, tabRequest, isBeginnerMode, glitchCount: engineStats?.glitchCount });

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

  const sound = useSoundSettings(engineStats, singingModel);
  const system = useSystemSettings({ isOpen, currentSampleRate, currentBufferSize, isBeginnerMode, showConfirm });

  const sampleRates = sampleRateOptions(selectedInputDevice, selectedOutputDevice, isAsio, selectedSampleRate, currentSampleRate);

  const selectedBufferMs = Number.isFinite(selectedBufferSize) && selectedBufferSize > 0 && Number.isFinite(selectedSampleRate) && selectedSampleRate > 0
    ? selectedBufferSize / selectedSampleRate * 1000 : null;

  // 開始できなかった理由に、直前の接続へ戻したかと次にやることを添える（#289）。
  const showStartFailure = (err: unknown, fallback: 'settings.AudioSettingsModal.017' | 'settings.AudioSettingsModal.020') => {
    // 状態不明でも開始自体の失敗理由を残し、再開始しなかったことは別の段落で伝える。
    setStartStateUnknown(err instanceof ConnectionStartError && err.rollback === 'unknown');
    setError(err instanceof ConnectionApplyError ? notice(err.stage === 'channels' ? 'settings.connectionChannelsIncomplete' : 'settings.connectionSaveIncomplete', { arg0: err.message })
      : err instanceof ConnectionStartError && err.rollback !== 'none' && err.rollback !== 'unknown' ? notice(err.rollback === 'restored' ? 'settings.startRolledBack' : err.rollback === 'kept' ? 'settings.startKept' : 'settings.startRollbackFailed', { arg0: err.message })
      : notice(fallback, { arg0: err instanceof ConnectionStartError ? err.raw : String(err) }));
  };

  const handleSave = async () => {
    if (!canSaveConnection || isApplying) return;
    if (retryRestart.current) { await performRestart(); return; }
    setError(null);
    setUsageFailure(null);
    // 保存のあいだ入力の欄が作り直される。切り替えのあとの焦点の依頼を残すと、保存の結果より先に選択欄へ戻る。
    setAppFocus(0);
    setLoading(true);
    try {
      await connection.apply(false);
      rememberSavedUsage();
      setConnectionRetry(false);
      // toast.success('オーディオエンジンを起動しました'); // Assuming toast is available
      if (await commitPendingUsage()) onClose();
    } catch (err) {
      if (err instanceof ConnectionApplyError) setConnectionRetry(true);
      console.error('Failed to start audio:', err);
      showStartFailure(err, 'settings.AudioSettingsModal.017');
    } finally {
      setLoading(false);
    }
  };

  const performRestart = async () => {
    retryRestart.current = true;
    setError(null);
    setUsageFailure(null);
    setAppFocus(0);
    setLoading(true);
    try {
      await connection.apply(true);
      rememberSavedUsage();

      // The restart kills the sidecar process (plugins are lost), so restore them from session.
      // 移行確認完了時はonConfigChangeが復元を開始するため、通常再起動の復元と重ねない。
      if (onEngineRestarted && !reviewRequired) {
        toast.info(t('settings.AudioSettingsModal.018'));
        await onEngineRestarted();
        toast.success(t('settings.AudioSettingsModal.019'));
      }
      retryRestart.current = false;
      setConnectionRetry(false);
      if (await commitPendingUsage()) onClose();
      // Optional: formatting toast success
    } catch (err) {
      setConnectionRetry(true);
      allowNextLeave();
      if (onRequestTab) onRequestTab('audio');
      else setActiveTab('audio');
      console.error('Failed to restart engine:', err);
      // 再起動はプラグインを失うため、直前の接続へ戻せたときも通常の再起動と同じく復元する（#289）。
      if (err instanceof ConnectionStartError && err.rollback === 'restored' && onEngineRestarted && !reviewRequired) {
        try { await onEngineRestarted(); } catch (restoreError) { console.error('Failed to restore plugins after rollback:', restoreError); }
      }
      showStartFailure(err, 'settings.AudioSettingsModal.020');
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
      onConfirm: () => { void performRestart(); },
    });
  };

  // Get Unique Hosts list
  const availableHosts = useMemo(() =>
    Array.from(new Set([...devices.inputs, ...devices.outputs].map(d => d.host))),
    [devices]);


  // Preset Helpers
  const { presets, presetName, setPresetName, savePreset, deletePreset } = useAudioPresets(isOpen);

  const handleSavePreset = () => {
    savePreset({
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
    });
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
        connection.setRoutingForDevice(connectionDeviceKey(device.host, device), {
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
      onConfirm: () => deletePreset(presetName),
    });
  };

  if (!isOpen) return null;
  const pageKind = activeTab === 'audio' ? 'connect' : activeTab === 'sound' ? 'sound' : 'settings';
  const pageTitle = t(pageKind === 'connect' ? 'rail.connect' : pageKind === 'sound' ? 'rail.sound' : 'rail.settings');
  // 音楽鑑賞の出力先は手元で聴く側なので、受け側の名前は配信・通話のときだけ案内する。
  const receiverName = displayPurpose === 'voice' ? cableReceiverName(selectedOutputDevice?.name) : null;
  const musicSound = activeTab === 'sound' && displayPurpose === 'music';
  const singingDirty = singingDraftIsDirty(singingModel.snapshot, singingModel.draft);
  const showSingingBar = activeTab === 'sound' && soundPlace === 'singing' && !musicSound;
  const soundLead = musicSound ? t('sound.musicLead')
    : soundPlace === 'liveModes' ? t('sound.lead.liveModes')
    : soundPlace === 'singing' ? t('sound.lead.singing')
    : soundPlace === 'peak' ? t('settings.apply.protectionDraft')
    : t('settings.apply.soundImmediate');
  const pageLead = activeTab === 'audio' ? t('settings.page.connectLead')
    : activeTab === 'sound' ? soundLead
    : activeTab === 'appearance' ? t('settings.apply.appearanceImmediate')
    : activeTab === 'shortcuts' ? t('settings.apply.shortcutsDraft')
    : activeTab === 'obs' ? t('settings.page.obsLead')
    : undefined;
  const leavePage = () => requestLeave(onClose);
  const chooseTab = (tab: typeof activeTab) => {
    // システムの再起動は接続の未保存を適用するので、捨てる確認には通さない（6.3）。
    if (tab === 'system' && activeTab === 'audio') {
      if (onRequestTab) onRequestTab(tab);
      else setActiveTab(tab);
      return;
    }
    if (onRequestTab) onRequestTab(tab);
    else requestLeave(() => setActiveTab(tab));
  };
  const liveOutputSettings = <details id="live-output-settings" onToggle={e => { if (e.currentTarget.open) setLoadOutput(true); }} className="rounded-card border border-border p-4 space-y-3">
    <summary className="cursor-pointer text-ui-heading font-semibold">{t('liveOutput.title')}</summary>
    <LiveOutputPanel autoLoad={loadOutput} outputs={devices.outputs} inputName={inputSource.source.kind === 'process_loopback' ? inputSource.source.config.appName : selectedInputDevice?.name} monitorName={selectedOutputDevice?.name} disabled={loading} onBusyChange={setLoading} />
  </details>;
  // 配信中に触る配信ミックスはホームのパネルへ移し、ここは機器と接続だけにする（#299）。
  const streamMixSettings = <section aria-labelledby="stream-mix-settings-heading" className="space-y-2 rounded-card border border-border p-4">
    <h3 id="stream-mix-settings-heading" className="text-ui-heading font-semibold">{t('streamMix.title')}</h3>
    <p className="text-ui-support text-muted-foreground">{t('streamMix.settingsHint')}</p>
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-ui-control"><Checkbox checked={streamMixShown} disabled={!streamMixAvailable} aria-describedby={streamMixAvailable ? undefined : 'stream-mix-voice-only'} onChange={event => saveStreamMixPanel(event.target.checked)} />{t('streamMix.show')}</label>
      <Button type="button" variant="outline" size="sm" disabled={!streamMixAvailable} aria-describedby={streamMixAvailable ? undefined : 'stream-mix-voice-only'} onClick={() => requestLeave(() => { openStreamMixPanel(); onClose(); })}>{t('streamMix.openHome')}</Button>
    </div>
    <p className="text-ui-support text-muted-foreground">{t('streamMix.instant')}</p>
  </section>;
  const monitorSettings = <details className="rounded-card border border-border p-4 space-y-3">
    <summary className="cursor-pointer text-ui-heading font-semibold">{t('structure.monitor')}</summary>
    <MonitorTrial devices={devices.outputs} disabled={loading} onBusyChange={setLoading} onApplied={async config => { await onConfigChange(config, { audioStarted: true }); await system.refreshEngineRuntimeStats(); }} />
  </details>;

  return (
    <PagePortal>
      <div data-settings-page={pageKind} className="settings-page flex h-full min-h-0 flex-col overflow-hidden">
        <PageHeading title={pageTitle} lead={pageLead} headingRef={headingRef} leadId={activeTab === 'sound' && !musicSound ? 'sound-section-heading' : undefined} actions={<>
          {activeTab === 'sound' && soundPlace === 'singing' && !musicSound && <SingingGuideHelp />}
          {musicSound && <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => requestOpenRack()}>{t('sound.openVst')}</Button>}
        </>} />
        <SaveBarScope scroller={scrollerEl} slot={saveSlot}>
        <Tabs value={activeTab} onValueChange={value => chooseTab(value as typeof activeTab)} className="flex min-h-0 flex-1 flex-col">
          {/* レールが移動を持つときは、設定のページでだけ4区分を出す。単体で開いたときは、この画面の中で切り替える。 */}
          <TabsList hidden={!!onRequestTab && pageKind !== 'settings'} aria-label={t('rail.settings')} className="h-auto w-full shrink-0 justify-start gap-1 overflow-x-auto">
            {!onRequestTab && <TabsTrigger className="text-ui-control" value="audio" disabled={isApplying}>{t('settings.audio')}</TabsTrigger>}
            {!onRequestTab && <TabsTrigger className="text-ui-control" value="sound" disabled={isApplying}>{t('settings.sound')}</TabsTrigger>}
            <TabsTrigger className="text-ui-control" value="appearance" disabled={isApplying} title={isApplying ? t('settings.leave.blocked') : undefined}>{t('settings.appearance')}</TabsTrigger>
            <TabsTrigger className="text-ui-control" value="shortcuts" disabled={isApplying} title={isApplying ? t('settings.leave.blocked') : undefined}>{t('settings.shortcuts')}</TabsTrigger>
            <TabsTrigger className="text-ui-control" value="obs" disabled={isApplying} title={isApplying ? t('settings.leave.blocked') : undefined}>{t('settings.obs')}</TabsTrigger>
            <TabsTrigger className="text-ui-control" value="system" disabled={isApplying} title={isApplying ? t('settings.leave.blocked') : undefined}>{t('settings.system')}</TabsTrigger>
          </TabsList>
          <div ref={bindScroller} className="min-w-0 flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent">
          <TabsContent value="audio" className="space-y-4">
            {reviewRequired && <div className="rounded-control border border-input bg-muted p-3 text-ui-support space-y-2">
              <p>{t('settings.AudioSettingsModal.029')}</p>
              {importedPlugins.length > 0 && <ul className="max-h-24 overflow-auto break-all">{importedPlugins.map((p, i) => <li key={i}>{p.name} — {p.path}</li>)}</ul>}
              <label className="flex gap-2 text-ui-control"><Checkbox checked={migrationConfirmed} onChange={e => setMigrationConfirmed(e.target.checked)} />{t('settings.AudioSettingsModal.030')}</label>
            </div>}
            {!!error && <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(renderNotice(t, error))} />}

            {isApplying ? (
              <div role="status" className="flex flex-col items-center gap-2 py-8 text-ui-support text-muted-foreground">
                <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                {t('common.loading')}
              </div>
            ) : (
              <div className="space-y-6">
              <UsageSwitch display={displayPurpose} inputPurpose={inputSource.source.config.purpose} running={streamRunning}
                locked={liveModel.snapshot?.armed === true} blockedReason={usageBlockedReason} onApply={applyUsage} onBusyChange={setUsageSwitching} onApplied={() => setAppFocus(request => request + 1)} onOpenSetup={goal => onOpenWizard?.(goal)} />
              {usageFailure && <div className="space-y-4">
                <div ref={errorPanel} tabIndex={-1} role="alert" className="space-y-2 text-foreground text-ui-support text-center py-4 bg-destructive/10 rounded-card outline-hidden">
                  <p className="text-balance [word-break:auto-phrase]">{renderNotice(t, usageFailure.message)}</p>
                </div>
                {!usageFailure.restored && <Button onClick={() => requestLeave(onClose)} variant="outline" className="h-auto min-h-10 whitespace-normal w-full">{t('settings.returnHome')}</Button>}
              </div>}
              {error && <div className="space-y-4">
                <div role="alert" className="space-y-2 text-foreground text-ui-support text-center py-4 bg-destructive/10 rounded-card">
                  <p>{renderNotice(t, error)}</p>
                  {startStateUnknown && <p>{t('settings.startUnknown')}</p>}
                </div>
                <Button onClick={() => setError(null)} variant="default" className="h-auto min-h-10 whitespace-normal w-full">{t('settings.AudioSettingsModal.031')}</Button>
                <Button onClick={() => requestLeave(onClose)} variant="outline" className="h-auto min-h-10 whitespace-normal w-full">{t('settings.returnHome')}</Button>
              </div>}
                <div id="primary-input-settings" tabIndex={-1} className="space-y-6">
                <ProcessInputPanel value={inputSource} displayPurpose={displayPurpose} focusRequest={appFocus} showKind={displayPurpose === 'music' || processInput} onChange={next => {
                  editConnection('source');
                  if (processInput && next.source.kind === 'device') setNeedsDeviceChoice(true);
                  setInputSource(next);
                }} disabled={isApplying} isAsio={isAsio} status={engineStats?.processInput} onChooseConnection={chooseConnection} />
                {/* 入力と出力は、ページの幅に余裕があるときだけ横に並べる。間の項目は1行のまま。DOM の順は変えない。 */}
                <div className="page-pair">
                {/* Input Device */}
                {!processInput && <fieldset className="page-pair-input page-section rounded-card border border-border p-3">
                  <legend className="text-ui-heading font-semibold">
                    <label htmlFor={inputId}>{t(isAsio ? 'settings.AudioSettingsModal.037' : displayPurpose === 'music' ? 'music.source' : 'settings.AudioSettingsModal.038')}</label>
                  </legend>
                  <Field id={inputId} label={null} description={isAsio ? t('settings.AudioSettingsModal.044') : undefined}><Select
                    id={inputId}
                    className="max-w-full"
                    title={selectedInput || undefined}
                    value={needsDeviceChoice ? '' : selectedInputKey}
                    onChange={(e) => { editConnection('input'); setSelectedInputKey(e.target.value); setNeedsDeviceChoice(!e.target.value); }}
                    disabled={devicesLoading || filteredInputs.length === 0}
                  >
                    {devicesLoading && <option value={needsDeviceChoice ? '' : selectedInputKey}>{t('common.loading')}</option>}
                    {!devicesLoading && filteredInputs.length === 0 && <option value="">{t('settings.AudioSettingsModal.040')}</option>}
                    {!devicesLoading && filteredInputs.length > 0 && (needsDeviceChoice || !selectedInputKey) && <option value="">{t('settings.selectDevice')}</option>}
                    {!devicesLoading && !!selectedInputKey && !needsDeviceChoice && !filteredInputs.some(device => audioDeviceKey(device) === selectedInputKey) && <option value={selectedInputKey}>{t('settings.deviceMissing', { name: selectedInput || selectedInputKey })}</option>}
                    {filteredInputs.map((device, i) => (
                      <option key={`${audioDeviceKey(device)}-${i}`} value={audioDeviceKey(device)} disabled={!device.id && filteredInputs.filter(item => item.name === device.name).length > 1}>{device.name}{filteredInputs.filter(item => item.name === device.name).length > 1 && device.id ? ` (${device.id})` : ''}</option>
                    ))}
                  </Select></Field>
                  {!error && displayPurpose !== 'music' && <MicrophonePermissionGuide />}
                </fieldset>

                }
                {/* Smart Input Channel Selector (ASIO Only) */}
                {isAsio && (
                  <div className="page-pair-span">
                    <InputChannelSelector
                      key={connection.deviceKey}
                      initialChannels={connection.channels}
                      maxChannels={selectedInputDevice?.channels ?? 0}
                      monitorEnabled={connection.monitorInput}
                      onChannelMapped={channels => { editConnection('channels'); connection.setChannels(channels); }}
                    />
                  </div>
                )}

                {/* Output Device - Hide for ASIO */}
                {!isAsio && (
                  <fieldset className="page-pair-output page-section rounded-card border border-border p-3">
                    <legend className="text-ui-heading font-semibold"><label htmlFor={outputId}>{t('settings.AudioSettingsModal.041')}</label></legend>
                    <Field id={outputId} label={null} description={receiverName ? t('settings.connection.receiverHint', { name: receiverName }) : undefined}><Select
                      className="max-w-full"
                      title={selectedOutput || undefined}
                      value={selectedOutputKey}
                      onChange={(e) => { editConnection('output'); setSelectedOutputKey(e.target.value); }}
                      disabled={devicesLoading || filteredOutputs.length === 0}
                    >
                      {devicesLoading && <option value={selectedOutputKey}>{t('common.loading')}</option>}
                      {!devicesLoading && filteredOutputs.length === 0 && <option value="">{t('settings.AudioSettingsModal.043')}</option>}
                      {!devicesLoading && filteredOutputs.length > 0 && !selectedOutputKey && <option value="">{t('settings.selectDevice')}</option>}
                      {!devicesLoading && !!selectedOutputKey && !filteredOutputs.some(device => audioDeviceKey(device) === selectedOutputKey) && <option value={selectedOutputKey}>{t('settings.deviceMissing', { name: selectedOutput || selectedOutputKey })}</option>}
                      {filteredOutputs.map((device, i) => (
                        <option key={`${audioDeviceKey(device)}-${i}`} value={audioDeviceKey(device)} disabled={!device.id && filteredOutputs.filter(item => item.name === device.name).length > 1}>{device.name}{filteredOutputs.filter(item => item.name === device.name).length > 1 && device.id ? ` (${device.id})` : ''}</option>
                      ))}
                    </Select></Field>
                  </fieldset>
                )}
                {isAsio && <div className="page-pair-output"><OutputChannelSelector value={connection.outputRouting} maxChannels={selectedOutputDevice?.channels ?? 0}
                  disabled={isApplying} onChange={routing => { editConnection('routing'); connection.setOutputRouting(routing); }} /></div>}
                </div>
                </div>

                {processInput && <p className="break-words text-ui-support text-muted-foreground">{t('processInput.outputHelp')}</p>}

                {!savedConnection && savedRestoreAvailable && <div className="space-y-1">
                  <Button type="button" onClick={() => void restoreSavedConnection()} disabled={isApplying} variant="link" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.connection.restoreSaved')}</Button>
                  <p className="text-ui-support text-muted-foreground">{t('settings.connection.restoreHint')}</p>
                </div>}
                {restoreNotice && <p role="status" className="text-ui-support text-muted-foreground">{restoreNotice}</p>}

              </div>
            )}
            {displayPurpose === 'music' && <p id="stream-mix-voice-only" className="text-ui-support text-muted-foreground">{t('streamMix.voiceOnly')}</p>}
            {displayPurpose === 'music' && streamingActive && <details className="rounded-card border border-border p-4">
              <summary className="cursor-pointer text-ui-heading font-semibold">{t('settings.streamingInUse')}</summary>
              <div className="mt-3 space-y-3">
                {liveOutputActive && liveOutputSettings}
                {mixActive && streamMixSettings}
                {monitorActive && monitorSettings}
              </div>
            </details>}
            {displayPurpose !== 'music' && liveOutputSettings}
            {displayPurpose !== 'music' && streamMixSettings}

            {!isApplying && <div className="space-y-6">
                <details ref={tuningDetails} open={tuningOpen} onToggle={event => setTuningOpen(event.currentTarget.open)} className="rounded-card border border-border p-3 space-y-3">
                  <summary className="cursor-pointer text-ui-heading font-semibold">
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
                    <Button
                      onClick={() => void fetchDevices(true)}
                      variant="link" size="sm" className="h-auto min-h-9 whitespace-normal gap-1"
                      title={t('settings.AudioSettingsModal.033')}
                    >
                      <MdRefresh className="w-3 h-3" />
                      {t('settings.AudioSettingsModal.034')}</Button>
                  </div>
                  <Field label={<span className="sr-only">{t('settings.AudioSettingsModal.035')}</span>}><Select
                    ref={hostSelect}
                    aria-label={t('settings.AudioSettingsModal.035')}
                    className="max-w-full"
                    title={selectedHost ? displayAudioHost(selectedHost) : undefined}
                    value={selectedHost}
                    onChange={(e) => { editConnection('host'); setSelectedHost(e.target.value); }}
                    disabled={devicesLoading}
                  >
                    {devicesLoading && <option value={selectedHost}>{t('common.loading')}</option>}
                    {!devicesLoading && !selectedHost && <option value="">{t('settings.AudioSettingsModal.036')}</option>}
                    {!devicesLoading && !!selectedHost && !availableHosts.some(host => host.toLowerCase() === selectedHost.toLowerCase()) && <option value={selectedHost}>{t('settings.deviceMissing', { name: displayAudioHost(selectedHost) })}</option>}
                    {availableHosts.map((host) => (
                      <option key={host} value={host}>{displayAudioHost(host)}</option>
                    ))}
                  </Select></Field>
                  <p className="text-ui-support text-muted-foreground">{t(isAsio ? 'settings.connection.asioHint' : 'settings.connection.wasapiHint')}</p>
                </div>

                {/* 切替は対象の見出しと同じ行に置く。 */}
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <h3 className="text-ui-heading font-semibold">{t('settings.AudioSettingsModal.047')}</h3>
                  <div data-tuning-control>
                    <SegmentedControl label={t('settings.AudioSettingsModal.047')} value={isAdvancedMode ? 'advanced' : 'simple'}
                      onValueChange={value => setIsAdvancedMode(value === 'advanced')} options={[
                        { value: 'simple', label: t('settings.AudioSettingsModal.045') },
                        { value: 'advanced', label: t('settings.AudioSettingsModal.046') },
                      ]} />
                  </div>
                </div>

                {/* Simple Mode UI */}
                {!isAdvancedMode ? (
                  <div className="space-y-4">
                    {/* Latency Profile */}
                    <div className="space-y-2">
                      <SegmentedControl label={t('settings.AudioSettingsModal.065')} value={String(selectedBufferSize)}
                        onValueChange={value => { editConnection('buffer'); setSelectedBufferSize(Number(value)); }}
                        options={[
                          { label: t('settings.AudioSettingsModal.048'), value: '128', hint: t('settings.AudioSettingsModal.050') },
                          { label: t('settings.AudioSettingsModal.051'), value: '512', hint: t('settings.AudioSettingsModal.053') },
                          { label: t('settings.AudioSettingsModal.054'), value: '1024', hint: t('settings.AudioSettingsModal.056') },
                        ].map(profile => ({ ...profile, disabled: canChangeBufferSize && !supportedBufferSizes.includes(Number(profile.value)) }))} />
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
                      <SegmentedControl label={t('settings.AudioSettingsModal.060')} value={String(selectedSampleRate)}
                        onValueChange={value => { editConnection('rate'); setSelectedSampleRate(Number(value)); }}
                        options={[
                          { label: t('settings.AudioSettingsModal.061'), value: '48000', hint: t('settings.AudioSettingsModal.062') },
                          { label: t('settings.AudioSettingsModal.063'), value: '44100', hint: t('settings.AudioSettingsModal.064') },
                        ]} />
                    </div>
                  </div>
                ) : (
                  /* Advanced Mode UI (Buffer Size & Sample Rate) */
                  <div className="grid grid-cols-2 gap-4 pt-2">
                    {/* Buffer Size */}
                    {canChangeBufferSize ? (
                      <div className="space-y-2">
                        <Field label={t('settings.AudioSettingsModal.065')}>
                        <Select
                    aria-label={t('settings.AudioSettingsModal.066')}
                          value={selectedBufferSize}
                          onChange={(e) => { editConnection('buffer'); setSelectedBufferSize(Number(e.target.value)); }}

                        >
                          {supportedBufferSizes.map(size => (
                            <option key={size} value={size}>{size} {t('settings.AudioSettingsModal.067')}</option>
                          ))}
                        </Select></Field>
                      </div>
                    ) : (
                      <div className="space-y-2 opacity-50 pointer-events-none">
                        <label className="font-medium text-muted-foreground text-ui-control">{t('settings.AudioSettingsModal.068')}</label>
                        <div className="w-full bg-muted border border-input rounded-control px-3 py-2 text-ui-support text-muted-foreground">
                          {t('settings.AudioSettingsModal.069')}</div>
                      </div>
                    )}

                    {/* Sample Rate */}
                    <div className="space-y-2">
                      <Field label={t('master.rate')}>
                      <Select
                    aria-label={t('master.rate')}
                        value={selectedSampleRate}
                        onChange={(e) => { editConnection('rate'); setSelectedSampleRate(Number(e.target.value)); }}

                      >
                        {sampleRates.options.map(({ rate, supported }) => (
                          <option key={rate} value={rate} disabled={!supported}>{formatSampleRate(rate)} kHz{!supported ? ` ${t('settings.rateUnsupported')}` : ''}</option>
                        ))}
                      </Select></Field>
                      {(sampleRates.inputUnknown || sampleRates.outputUnknown) && <p className="text-ui-support text-muted-foreground">
                        {t(sampleRates.inputUnknown && sampleRates.outputUnknown ? 'settings.rateUnknownBoth' : sampleRates.inputUnknown ? 'settings.rateUnknownInput' : 'settings.rateUnknownOutput')}
                      </p>}
                      {!sampleRates.options.find(option => option.rate === selectedSampleRate)?.supported && <p className="text-ui-support text-warning">{t('settings.rateSelectedUnsupported')}</p>}
                      {!isAsio && (
                        <div className="text-ui-support text-warning flex items-start gap-1.5 bg-warning/10 p-1.5 rounded-control border border-warning/20 mt-2">
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
                <div className="text-ui-support text-muted-foreground bg-muted/50 rounded-control p-2 flex items-center justify-between mt-4">
                  <span className="flex items-center gap-1">{t('settings.AudioSettingsModal.068')} <InfoPopover label={t('info.buffer')}>{t('settings.AudioSettingsModal.071')}</InfoPopover></span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-foreground">{selectedBufferMs === null ? t('settings.AudioSettingsModal.072') : `${selectedBufferMs.toFixed(2)} ms`}</span>
                  </div>
                </div>

                {/* Tips Section (Only in Advanced Mode) */}
                {isAdvancedMode && (
                  <details className="text-ui-support text-muted-foreground bg-muted/50 rounded-control border border-border mt-2">
                    <summary className="p-2 cursor-pointer hover:bg-muted/80 transition-colors text-ui-control font-semibold flex items-center gap-2">
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
                {displayPurpose !== 'music' && monitorSettings}
                </details>
                <details className="space-y-3 rounded-card border border-border bg-muted/20 p-4">
                  <summary id={presetSummaryId} className="cursor-pointer text-ui-heading font-semibold">{t('settings.AudioSettingsModal.086')}</summary>
                  <SaveScopeSummary kind="io" />
                  <div className="flex items-center justify-between">
                    <InfoPopover label={t('info.preset')}>{t('settings.AudioSettingsModal.085')}</InfoPopover>
                    <div className="flex gap-2">
                      <Field label={null}><Select
                        aria-labelledby={presetSummaryId}
                        value={presets[presetName] ? presetName : ''}
                        onChange={(e) => handleLoadPreset(e.target.value)}
                      >
                        <option value="">{t('settings.AudioSettingsModal.088')}</option>
                        {Object.keys(presets).map(k => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </Select></Field>
                    </div>
                  </div>
                  <p className="text-ui-support text-muted-foreground">{t('settings.apply.connectionPreset')}</p>
                  <div className="flex items-end gap-2">
                    <Field label={t('settings.AudioSettingsModal.089')}><Input
                        type="text"

                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                      />
                    </Field>
                    <Button
                      onClick={handleSavePreset}
                      disabled={!presetName}
                      variant="ghost" className="h-auto min-h-10 whitespace-normal"
                      title={t('settings.AudioSettingsModal.090')}
                      aria-label={t('settings.AudioSettingsModal.090')}
                    >
                      <MdSave size={18} />
                    </Button>
                    <Button
                      onClick={handleDeletePreset}
                      disabled={!presetName || !presets[presetName]}
                      variant="ghost" className="h-auto min-h-10 whitespace-normal"
                      title={t('settings.AudioSettingsModal.091')}
                      aria-label={t('settings.AudioSettingsModal.091')}
                    >
                      <MdDelete size={18} />
                    </Button>
                  </div>
                </details>

              </div>}
          </TabsContent>

          <TabsContent value="sound" className="space-y-4">
          <SoundSettings model={sound} engineStats={engineStats} singingModel={singingModel} liveModel={providedLive ?? localLive}
            isBeginnerMode={isBeginnerMode} place={soundPlace} onPlace={chooseSoundPlace} onPeakPending={onPeakPending}
            music={displayPurpose === 'music'} singingDirty={singingDirty}
            onOpenVoiceCheck={onOpenVoiceCheck} onPreviewSinging={onPreviewSinging} onSaveSingingProfile={onSaveSingingProfile} streamMixAvailable={streamMixAvailable} measurementNonce={measurementNonce} onOpenMixing={() => { if (streamMixAvailable) requestLeave(() => { openStreamMixPanel(); onClose(); }); }} />
          </TabsContent>
          <TabsContent value="obs" className="space-y-4">
            <ObsConnectionSettings
              showConfirm={showConfirm}
              onClose={leavePage}
              onOpenOBSGuide={onOpenOBSGuide}
              onOpenTroubleshoot={onOpenTroubleshoot}
            />
          </TabsContent>

          <TabsContent value="appearance" className="space-y-6">
            <LanguageSelector />
            <p className="text-ui-support text-muted-foreground">
              {t('purpose.whereToSwitch')}{' '}
              <Button type="button" variant="link" className="h-auto px-0" onClick={() => chooseTab('audio')}>{t('purpose.openConnect')}</Button>
            </p>
            <NumericDetailsSwitch />
            <div className="space-y-4">
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-foreground text-ui-heading font-semibold">
                  {t('settings.AudioSettingsModal.130')}</h3>
                <RadioGroup value={theme} onValueChange={(v) => { if (v === 'light' || v === 'dark' || v === 'gaming') setTheme(v); }} className="grid auto-rows-fr gap-3">
                  <div className={`flex min-w-0 items-center gap-3 border p-3 rounded-card hover:bg-muted/50 transition-colors cursor-pointer ${theme === 'light' ? 'border-selection ring-1 ring-selection' : 'border-border'}`} onClick={() => setTheme('light')}>
                    <RadioGroupItem value="light" id="theme-light" />
                    <Label htmlFor="theme-light" className="min-w-0 cursor-pointer flex-1 text-ui-control">
                      <span className="font-bold block">{t('header.light')}</span>
                      <span className="break-words text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.131')}</span>
                    </Label>
                    <ThemeSwatch theme="light" />
                  </div>
                  <div className={`flex min-w-0 items-center gap-3 border p-3 rounded-card hover:bg-muted/50 transition-colors cursor-pointer ${theme === 'dark' ? 'border-selection ring-1 ring-selection' : 'border-border'}`} onClick={() => setTheme('dark')}>
                    <RadioGroupItem value="dark" id="theme-dark" />
                    <Label htmlFor="theme-dark" className="min-w-0 cursor-pointer flex-1 text-ui-control">
                      <span className="font-bold block">{t('header.dark')}</span>
                      <span className="break-words text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.132')}</span>
                    </Label>
                    <ThemeSwatch theme="dark" />
                  </div>
                  <div className={`flex min-w-0 items-center gap-3 border p-3 rounded-card hover:bg-muted/50 transition-colors cursor-pointer ${theme === 'gaming' ? 'border-selection ring-1 ring-selection' : 'border-border'}`} onClick={() => setTheme('gaming')}>
                    <RadioGroupItem value="gaming" id="theme-gaming" className="text-brand border-brand" />
                    <Label htmlFor="theme-gaming" className="min-w-0 cursor-pointer flex-1 text-ui-control">
                      <span className="font-bold block">{t('header.gaming')}</span>
                      <span className="break-words text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.133')}</span>
                    </Label>
                    <ThemeSwatch theme="gaming" />
                  </div>
                </RadioGroup>
                <p className="mt-3 text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.135')}</p>
                <p className="mt-2 text-ui-support text-muted-foreground [word-break:auto-phrase]">{t('settings.appearanceMotion')}</p>
                <UserDocLink name="help.appearance" compact />
              </div>

            </div>



          </TabsContent>

          <TabsContent value="shortcuts" className="space-y-4">
            <ShortcutsPanel onDirtyChange={setShortcutsDirty} />
          </TabsContent>
          <SystemSettings model={system} engineStats={engineStats} loading={loading} setLoading={setLoading} showConfirm={showConfirm}
            onClose={leavePage} onOpenWizard={onOpenWizard} onOpenLicense={onOpenLicense} handleRestart={handleRestart}
            canRestart={inputReady && !!selectedOutputDevice && (!reviewRequired || migrationConfirmed)} knownStopped={connection.knownStopped} />
          </div>
          {/* ホットキーの保存欄は、ここへ出て一覧に被さらない（#641）。空のときは高さを持たない。 */}
          <div ref={bindSlot} className="shrink-0 empty:hidden" />
        {showSingingBar && (
          // 接続とホットキーと同じく、欄の実際の高さだけ下に余白を取り、最後の操作と焦点を欄に潜らせない（#645）。
          <MeasuredSaveBar className="settings-action-bar shrink-0 border-t border-border bg-muted/20 px-4 py-2">
            <p className="settings-action-note text-ui-support text-muted-foreground">{singingDirty ? t('sound.unapplied') : t('sound.noChanges')}</p>
            <Button type="button" className="shrink-0" disabled={singingModel.busy || !singingDirty || Boolean(singingModel.snapshot?.pending) || singingModel.conflict} onClick={() => void singingModel.apply()}>{t('settings.SingingControls.427')}</Button>
          </MeasuredSaveBar>
        )}
        {activeTab === 'audio' && !loading && (
          <MeasuredSaveBar className="settings-action-bar shrink-0 border-t border-border bg-muted/20 px-4 py-2">
            {/* 音声が動いていて接続の変更があるときだけ、途切れることを押す前に示す。 */}
            <div className="settings-action-note space-y-1 text-left text-ui-support text-muted-foreground" id="settings-connection-changes">
              <p>{allowConnectionRetry || connectionRetry ? t('settings.connection.retry') : !savedConnection
                ? inputReady && selectedOutputDevice ? t('settings.connection.firstStart', { host: displayAudioHost(selectedHost), input: processInput ? inputSource.source.kind === 'process_loopback' ? inputSource.source.config.appName : '' : selectedInput, output: selectedOutputDevice.name }) : t('settings.connection.firstStartHint')
                : changedFields.length ? t('settings.connection.changes', { fields: changedFields.join('、') }) : t('settings.connection.unchanged')}</p>
              {showSaveRestartHint && <p id="settings-save-restart">{t('settings.saveRestartHint')}</p>}
            </div>
            <Button onClick={() => void handleSave()} disabled={loading || !inputReady || !selectedOutputDevice || !canSaveConnection || (reviewRequired && !migrationConfirmed)}
              className="shrink-0"
              aria-describedby={showSaveRestartHint ? 'settings-connection-changes settings-save-restart' : 'settings-connection-changes'}
              >
              {t(streamRunning ? 'settings.saveRestart' : 'settings.AudioSettingsModal.197')}
            </Button>
          </MeasuredSaveBar>
        )}
        </Tabs>
        </SaveBarScope>
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
    </PagePortal>
  );
};

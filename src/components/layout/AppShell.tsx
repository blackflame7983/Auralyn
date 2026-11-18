import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useGlobalBypass } from '@/hooks/useGlobalBypass';
import { useClearedRuntimeStats } from '@/hooks/useClearedRuntimeStats';
import { useMatchMedia } from '@/hooks/useMatchMedia';
import { useStartErrorRecovery } from '@/hooks/useStartErrorRecovery';
import { delay } from '@/hooks/internal/afterFrame';
import { largeWindow } from '@/lib/largeWindow';
import { HomeAudioStartError } from '@/lib/startHomeAudio';
import { renderClientError } from '@/lib/clientError';
import { useUsageWindow } from '@/hooks/useUsageWindow';
import { useMessages } from '@/i18n/LocaleProvider';
import { LoudnessCheck } from '../features/LevelMeter/LoudnessCheck';
import { HomePanels } from '../features/Home/HomePanels';
import { actionWord, ChannelAction } from '../features/Home/ChannelAction';
import { LiveStrip } from '../features/Home/LiveStrip';
import { SoundFlow } from '../features/Home/SoundFlow';
import { LiveControlsHiddenContext } from '../features/Home/LiveControlsContext';
import { SoundChain } from '../features/Home/SoundChain';
import { UnsetFlow } from '../features/Home/UnsetFlow';
import { usePreparation } from '@/hooks/usePreparation';
import { useLayoutMotion } from '@/hooks/useLayoutMotion';
import React, { ReactNode, useState, useRef } from 'react';
import { deriveHomeChrome } from './homeChrome';
import { AppRail, type RailDestination } from './AppRail';
import { PageSlot } from './pageSlot';
import { requestLeave } from './pageLeave';
import { useRackOpener } from './useRackOpener';
import type { AppPage } from '@/hooks/useUIState';
import { StatusBand } from './StatusBand';
import { useSessionElapsed } from '@/hooks/useSessionElapsed';
import { formatAudioRoute, usageDestination } from '@/lib/audioRouteLine';
import { engineInputName, isAppAudioInput } from '@/lib/inputSource';
import { MusicListeningCheck } from '../features/Home/MusicListeningCheck';
import { MusicHomeDesk } from '../features/Home/MusicHomeDesk';
import { EmergencyMuteButton } from './EmergencyMuteButton';
import { NoticeLane } from './NoticeLane';
import { focusOutputGain } from './OutputGainControl';
import { MuteAnnouncement, SafetyInput } from './SafetyLevels';
import { AudioCheckIcon } from '@/components/ui/AudioControlIcons';
import { cn } from '@/lib/utils';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface AppShellProps {
    onStartAudio?: () => Promise<void>;
    notices?: ReactNode;
    preparationBlocked?: boolean;
    onOpenOBSSettings: () => void;
    children: ReactNode;
    onOpenSettings: () => void;
    /** 中央に出しているページ。ホーム以外のとき、レールの現在地はページで決める。 */
    page?: AppPage;
    onOpenSettingsTab?: (tab: 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system') => void;
    onCloseSettings?: () => void;
    /** 設定ページや案内など、ホームの中身とは別に常に出す層。 */
    overlays?: ReactNode;
    /** 上の帯に置く歌／雑談の切替。説明は liveControls に残す。 */
    liveModeSwitch?: ReactNode;
    onOpenShortcuts?: () => void;
    onOpenAudioSettingsRetry?: () => void;
    onOpenSoundSettings?: () => void;
    /** 周囲の音を測る。音づくりの基本の測定欄を開く。 */
    onMeasureNoise?: () => void;
    onOpenAudioTuning?: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide: () => void;
    onOpenTroubleshoot: () => void;
    onOpenVoiceCheck: () => void;
    onOpenWizard: () => void;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
    isEngineRunning: boolean;
    engineProcessReady?: boolean | null;
    currentInput?: string;
    /** 保存済みの入力が再生中のアプリの音声か。実行中の状態を取れないときの補いにする。 */
    currentInputFromApp?: boolean;
    currentOutput?: string;
    /** いまの状態に置く歌・雑談の切替。登録前は描画されない。 */
    liveControls?: ReactNode;
    /** 右の列に置く操作ロック。 */
    liveProtect?: ReactNode;
    liveModeName?: string;
    /** 未設定でも歌・雑談の欄を出すか。登録済み・操作ロック中・処理中・失敗のときだけ true にする（#297）。 */
    liveControlsWhileUnconfigured?: boolean;
    /** チェーン列の VST 段の中身。ON/OFF。 */
    vstChain?: ReactNode;
    /** 各 VST の画面を開く操作。カードの2段目に置く。 */
    vstEditors?: ReactNode;
    /** 保存済み構成から読み込めていないVSTの名前。 */
    vstUnrestored?: string[];
    /** VST のページを開く。追加から開くときは true。 */
    onOpenVst?: (focusAdd?: boolean) => void;
    /** 保存した VST の構成を読み込む。呼び方は既存の pluginsApi.loadPreset のまま。 */
    onLoadPreset?: (name: string) => Promise<boolean>;
    /** 画面側の VST 一覧の件数。未取得は null。 */
    vstCount?: number | null;
    /** オンのVSTの件数。0 のあいだは比べるものが無いので、比較を無効にする。未取得は null。 */
    vstActiveCount?: number | null;
    /** 表示を選んだ配信ミックス。本番帯の直下へ置く。 */
    streamMixPanel?: ReactNode;
}

import { MasterBar } from './MasterBar';
import { MeterProvider } from '../features/LevelMeter/MeterContext';
import { RuntimeStatsContext } from './RuntimeStatsContext';

export const AppShell: React.FC<AppShellProps> = ({
    onStartAudio,
    children,
    notices,
    preparationBlocked,
    onOpenOBSSettings,
    onOpenSettings,
    page = 'home',
    onOpenSettingsTab,
    onCloseSettings,
    overlays,
    liveModeSwitch,
    onOpenShortcuts,
    onOpenAudioSettingsRetry,
    onOpenSoundSettings,
    onMeasureNoise,
    onOpenAudioTuning,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onOpenTroubleshoot,
    onOpenVoiceCheck,
    onOpenWizard,
    currentHost,
    currentSampleRate,
    currentBufferSize,
    isEngineRunning,
    engineProcessReady,
    currentInput,
    currentInputFromApp = false,
    currentOutput,
    liveControls,
    liveProtect,
    liveModeName,
    liveControlsWhileUnconfigured = false,
    vstChain,
    vstEditors,
    vstUnrestored,
    vstCount = null,
    vstActiveCount = null,
    onOpenVst,
    onLoadPreset,
    streamMixPanel
}) => {
    const t = useMessages();
    const [starting, setStarting] = useState(false);
    const startPending = useRef(false);
    const [startError, setStartError] = useState<unknown>(null);
    const [startPartiallyApplied, setStartPartiallyApplied] = useState(false);
    const [destinationRequest, setDestinationRequest] = useState(0);
    const startAudio = async () => {
        if (!onStartAudio || startPending.current || preparationBlocked) return;
        startPending.current = true; setStarting(true); setStartError(null); setStartPartiallyApplied(false);
        try { await onStartAudio(); }
        catch (error) { setStartError(() => error); setStartPartiallyApplied(error instanceof HomeAudioStartError && error.started); }
        finally { startPending.current = false; setStarting(false); }
    };
    const canStart = Boolean(onStartAudio && currentHost && currentInput && currentOutput);
    const [purpose] = useDisplayPurpose();
    useUsageWindow(purpose);
    const [runtimeStats, setRuntimeStats] = useClearedRuntimeStats(isEngineRunning);
    const shellRef = useRef<HTMLDivElement>(null);
    const mainRef = useRef<HTMLElement>(null);
    const listenButton = useRef<HTMLButtonElement>(null);
    // 状態や幅で区画の高さ・並びが変わっても跳ねさせず、位置を補間する（#298）。
    const homeContentRef = useRef<HTMLDivElement>(null);
    useLayoutMotion(homeContentRef);

    const audioReady = Boolean(currentHost) && isEngineRunning && engineProcessReady === true;
    // イベント・定期取得のどちらで復旧しても開始失敗を解除する。開始後の反映失敗は残す。
    useStartErrorRecovery(audioReady, startError, startPartiallyApplied, setStartError, setStartPartiallyApplied);
    const startErrorDetail = startError === null ? null : renderClientError(t,
        startError instanceof HomeAudioStartError ? startError.cause : startError);
    const preparation = usePreparation({ blocked: preparationBlocked, running: audioReady });
    const [loudnessEnabled, setLoudnessEnabled] = useState(false);
    const [measurement, setMeasurement] = useState({ active: false, busy: false, stopUnconfirmed: false });
    const [measurementRequest, setMeasurementRequest] = useState<{id: number; action: 'start' | 'stop'}>();
    const requestId = useRef(0);
    useRackOpener(onOpenVst);
    // 未設定の間は本番帯を出さず、準備の主ボタンを先頭にする。
    const quietStopped = canStart && !isEngineRunning && engineProcessReady === true;
    const configured = Boolean(currentHost) && preparation.observation.availability !== 'unconfigured';
    // 実行中の入力を優先する。アプリの音声は機器名を持たないので、アプリ名を入力の名前にする（#756）。
    const inputName = engineInputName(preparation.observation.config) ?? currentInput;
    const appAudioInput = isAppAudioInput(preparation.observation.config, currentInputFromApp);
    const chrome = deriveHomeChrome({ configured });
    // 音楽鑑賞の「音が届いているか確かめる」欄は、準備の手順とチェーン列のどちらからも開く。
    const [listenOpen, setListenOpen] = useState(false);
    const openListen = purpose === 'music' ? () => setListenOpen(true) : onOpenVoiceCheck;
    // 開いた後の測定・停止・閉じるはパネル側に集める。押せない理由は画面にも出し、押せるときの対象範囲は読み上げだけにする。
    const music = purpose === 'music';
    const measureName = t(music ? 'music.measureLevel' : 'shell.loudness');
    const measureScope = t(music ? 'music.measurementScope' : 'loudness.scope');
    const loudnessLabel = t(measurement.busy ? 'loudness.switching' : measurement.stopUnconfirmed ? 'loudness.retryStop' : measurement.active ? 'loudness.stop' : music ? 'music.measureLevel' : 'loudness.startAction');
    const loudnessAction = !loudnessEnabled && !measurement.active ? <span className="flex shrink-0 items-center gap-2">
        <span id="loudness-toggle-description" className={!audioReady ? 'whitespace-nowrap text-ui-support text-muted-foreground' : 'sr-only'}>{!audioReady ? t(engineProcessReady === null ? 'loudness.audioUnknown' : 'loudness.needsAudio') : measureScope}</span>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><ChannelAction aria-pressed={measurement.active} aria-describedby="loudness-toggle-description"
            onClick={() => { setLoudnessEnabled(true); setMeasurementRequest({ id: ++requestId.current, action: measurement.active ? 'stop' : 'start' }); }}
            disabled={measurement.busy || (!measurement.active && !audioReady)}
            aria-label={loudnessLabel}
            word={actionWord(measureName)}
            icon={<AudioCheckIcon className="h-[18px] w-[18px]" />}
        /></TooltipTrigger><TooltipContent><p>{measureName}</p><p className="max-w-64 text-ui-support">{measureScope}</p></TooltipContent></Tooltip></TooltipProvider>
    </span> : null;
    const focusOutputControl = () => {
        // 音量ゼロは右の列の出力音量へ、ミュートは解除ボタンへ移す。原因は札を描いた観測と同じスナップショットで決める（#766）。
        if (preparation.observation.muteCause === 'zeroGain') { focusOutputGain(); return; }
        const target = document.getElementById('emergency-mute');
        if (!target) return;
        target.focus();
        target.dataset.attention = '';
        delay(1200, () => { delete target.dataset.attention; });
    };
    // いまの状態の通知（LiveStrip）はホームだけに描く。それ以外のページでは、右の列の領域が同じ状態を伝える。描く条件は下の LiveStrip と同じ。
    const liveStripShown = page === 'home' && configured;
    const muteAnnouncement = preparation.observation.availability === 'muted' && !liveStripShown ? t('prep.muted') : '';
    const wideHome = useMatchMedia(`(min-width: ${largeWindow.connectColumnMinWidth}px)`);
    const routeInConnectionDiagram = configured && page === 'home' && wideHome;
    const soundChain = <SoundChain stopped={quietStopped} model={preparation} audioReady={audioReady} isEngineRunning={isEngineRunning} inputName={inputName} outputName={currentOutput}
        vst={vstChain} vstEditors={vstEditors} vstUnrestored={vstUnrestored}
        onOpenSettings={onOpenSettings} onOpenOBSSettings={onOpenOBSSettings} onOpenSoundSettings={onOpenSoundSettings} onMeasureNoise={onMeasureNoise} onOpenVst={focusAdd => onOpenVst?.(focusAdd)} vstCount={vstCount} unconfigured={!configured} />;
    const railCurrent: RailDestination = page;
    const openSettingsTab = (tab: 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system') => {
        if (onOpenSettingsTab) onOpenSettingsTab(tab);
        else onOpenSettings();
    };
    const usage = preparation.context.usage;
    const destination = usage ? usageDestination(t, usage, preparation.context.receiver) : undefined;
    const route = configured && !routeInConnectionDiagram ? formatAudioRoute(
        inputName,
        preparation.observation.config?.output ?? currentOutput,
        destination?.full,
        purpose === 'music',
    ) : null;
    const routeCompact = purpose === 'music' ? undefined : destination?.compact;
    const elapsed = useSessionElapsed(isEngineRunning);
    const nothingToCompare = vstActiveCount === 0;
    const { bypassed: isABBypassed, toggle: handleABToggle } = useGlobalBypass(nothingToCompare && isEngineRunning && engineProcessReady === true);
    // 比較は配信も音楽鑑賞も、右の列に常に出す。未設定のホームだけ、比較中に限る。
    const compareInColumn = chrome.footer.compare === 'always' || isABBypassed;
    // 止まっているあいだは比べられない。比較のオンオフはここでは変えない（#612）。
    const compareStopped = !isEngineRunning;
    // 動いていても、オンのVSTが無ければ比べるものが無い。理由は1つだけ出し、止まっているときは音声の開始を先にする。
    // 比較中は、切る操作を残す（自動で終わらせる送信が失敗しても戻せる）。
    const compareNeedsVst = nothingToCompare && !isABBypassed && !compareStopped
        ? t((vstCount ?? 0) === 0 ? 'header.compareNeedsVst' : 'header.compareNeedsVstOn') : undefined;
    const compareDisabled = compareStopped || compareNeedsVst !== undefined;
    const compareNeedsAudio =t(music ? 'header.compareNeedsAudioMusic' : 'header.compareNeedsAudio');
    const compareReason = compareStopped ? compareNeedsAudio : compareNeedsVst;
    const compareDescribedBy = [
        isABBypassed ? 'safety-compare-state' : '',
        compareStopped ? 'safety-compare-needs-audio' : '',
        compareNeedsVst ? 'safety-compare-needs-vst' : '',
    ].filter(Boolean).join(' ') || undefined;

    return (
        <MeterProvider running={isEngineRunning}><RuntimeStatsContext.Provider value={{ stats: runtimeStats, running: audioReady }}><div ref={shellRef}
            className="app-shell bg-muted/30 dark:bg-background text-foreground font-sans selection:bg-primary/20 overflow-hidden transition-colors duration-(--motion-panel)">
            <div className="app-frame relative z-10 flex min-h-0 min-w-0">
                <AppRail current={railCurrent}
                    onHome={() => requestLeave(() => { onCloseSettings?.(); mainRef.current?.scrollTo({ top: 0 }); })}
                    onSound={() => openSettingsTab('sound')}
                    onVst={() => onOpenVst?.()}
                    onConnect={() => openSettingsTab('audio')}
                    onSettings={() => openSettingsTab('appearance')}
                    onOpenShortcuts={onOpenShortcuts}
                    onOpenOBSGuide={onOpenOBSGuide}
                    onOpenDiscordGuide={onOpenDiscordGuide}
                    onOpenTroubleshoot={onOpenTroubleshoot}
                    onOpenWizard={onOpenWizard}
                />
                {/* 通知の行は中央の列の中に置く。通知が出ても、右の列の操作は動かさない。 */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <StatusBand stats={runtimeStats} host={currentHost} sampleRate={currentSampleRate} bufferSize={currentBufferSize}
                    isRunning={isEngineRunning} processReady={engineProcessReady} elapsed={elapsed} route={route} routeCompact={routeCompact}
                    canStart={canStart} starting={starting} onStart={() => { void startAudio(); }}
                    modeSwitch={liveModeSwitch} showListen={configured}
                    listenLabel={t(purpose === 'music' ? 'music.listenTitle' : 'home.voiceCheck')}
                    listenDisabled={!audioReady} listenDisabledReason={audioReady ? undefined : engineProcessReady === null ? t('loudness.audioUnknown') : compareNeedsAudio} onListen={openListen} listenRef={listenButton}
                    listenPanel={purpose === 'music' && listenOpen && <MusicListeningCheck running={isEngineRunning}
                        input={inputName} output={preparation.observation.config?.output ?? currentOutput}
                        vstBypassed={isABBypassed} compareUnavailable={compareReason} onCompareVst={() => { if (!compareDisabled) void handleABToggle(); }}
                        onSettings={onOpenSettings} onClose={() => { setListenOpen(false); listenButton.current?.focus(); }} />}
                />
                <NoticeLane />
                <div className="workspace-body relative flex min-h-0 min-w-0 flex-1">
                <main
                    ref={mainRef}
                    data-density="home"
                    className={page === 'home'
                        ? 'home-main min-w-0 flex-1 overflow-y-auto p-4 lg:p-6 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent'
                        : 'home-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pt-2 lg:px-6'}
                >
                    {page !== 'home' ? <PageSlot className="flex min-h-0 flex-1 flex-col" /> : <>
                    {/* 狭い窓は1列。窓が広いときだけ、右に接続の列を出す。 */}
                    <div ref={homeContentRef} className="home-content mx-auto">
                        {notices}
                        {/* 未設定の間は音の流れ（UnsetFlow）を先頭にし、いまの状態は出さない。
                            歌・雑談の切替は本番保護の解除や失敗の表示を兼ねるので、未設定でも条件を満たせば残す。 */}
                        {liveStripShown
                            ? <LiveStrip liveModeName={liveModeName} stopped={quietStopped} onStartAudio={canStart ? () => { void startAudio(); } : undefined} starting={starting} startError={startErrorDetail} startPartiallyApplied={startPartiallyApplied} onOpenStartErrorSettings={startPartiallyApplied ? onOpenAudioSettingsRetry ?? onOpenSettings : onOpenSettings} onChooseDestination={audioReady ? () => setDestinationRequest(n => n + 1) : undefined} model={preparation} savedInputFromApp={currentInputFromApp} running={isEngineRunning} engineProcessReady={engineProcessReady} liveControls={liveControls} onOpenDevices={onOpenSettings} />
                            : liveControls && <div hidden={!liveControlsWhileUnconfigured} data-unconfigured-live className="mb-4 rounded-card border border-border bg-card px-4 py-3 empty:hidden"><LiveControlsHiddenContext.Provider value={!liveControlsWhileUnconfigured}>{liveControls}</LiveControlsHiddenContext.Provider></div>}
                        {/* 配信・通話と音楽鑑賞で並びをそろえる：いまの状態 → 音の流れ →（配信だけ配信ミックス）→ 音調整 →（音楽だけ保存した構成）→ 診断と接続の詳細（#605 を置き換え）。 */}
                        {/* 未設定の間は UnsetFlow が音の流れなので、空の帯は重ねない。 */}
                        {configured && <SoundFlow running={isEngineRunning} music={purpose === 'music'} action={loudnessAction} />}
                        {/* 未設定の間は音の流れと次の1歩だけを出す（#297）ため、配信ミックスは置かない。 */}
                        {configured && streamMixPanel}
                        <div><LoudnessCheck
                            music={purpose === 'music'}
                            enabled={loudnessEnabled}
                            request={measurementRequest} onStateChange={setMeasurement} onClose={() => setLoudnessEnabled(false)}
                            running={audioReady}
                            stateKnown={engineProcessReady !== null}
                            onVoiceCheck={onOpenVoiceCheck}
                        /></div>
                        {/* 音調整は音の流れのあと、診断と接続の詳細より前。未設定の間だけ最後へ回す。 */}
                        {configured && soundChain}
                        {configured && purpose === 'music' && <MusicHomeDesk onLoadPreset={onLoadPreset} />}
                        {/* 未設定の間は音の流れと次の1歩だけを出し、準備の確認・送り先の選択・状態の重複を並べない（#297）。 */}
                        {!configured && <UnsetFlow usage={preparation.context.usage || null} music={purpose === 'music'} onSetup={onOpenWizard}
                            input={inputName} output={preparation.observation.config?.output ?? currentOutput} />}
                        {configured && <div className="home-connect-column min-w-0"><HomePanels diagnosticAttention={startError !== null || measurement.stopUnconfirmed} stoppedInStrip={quietStopped} pinnedOpen={routeInConnectionDiagram}
                            model={preparation}
                            homeActionInStrip={canStart && !isEngineRunning || purpose !== 'music' && audioReady && !preparation.context.usage}
                            destinationRequest={destinationRequest}
                            audioReady={audioReady}
                            statusText={audioReady ? undefined : engineProcessReady === null ? t('shell.unknown') : currentHost ? t(music ? 'shell.stoppedMusic' : 'shell.stopped') : t('shell.unconfigured')}
                            host={currentHost} sampleRate={currentSampleRate}
                            inputName={inputName} outputName={currentOutput}
                            onOpenSettings={onOpenSettings} onOpenOBSSettings={onOpenOBSSettings}
                            onOpenSoundSettings={onOpenSoundSettings} onListen={openListen}
                            onSetup={onOpenWizard}
                            onOpenOBSGuide={onOpenOBSGuide} onOpenDiscordGuide={onOpenDiscordGuide} onOpenTroubleshoot={onOpenTroubleshoot}
                        /></div>}
                        <div className="min-w-0">
                        <div id="home-rack">{children}</div>
                        </div>
                        {!configured && soundChain}
                    </div>
                    </>}
                </main>
                </div>
                </div>
                {/* 上の3操作は縮めない。下の状態表示だけが、収まらないときに縦へ送る（MasterBar）。 */}
                <aside data-density="home" aria-label={t('shell.safetyColumn')} className="flex w-[var(--safety-column-width)] shrink-0 flex-col gap-3 overflow-hidden border-l border-border bg-card p-3">
                    <MuteAnnouncement text={muteAnnouncement} />
                    <EmergencyMuteButton onOpenSettings={onOpenSettings} />
                    <MasterBar
                        input={<SafetyInput running={isEngineRunning} music={purpose === 'music'} name={inputName} fromApp={appAudioInput} />}
                        lock={liveProtect}
                        outputName={currentOutput}
                        outputMuted={preparation.observation.availability === 'muted'}
                        onCheckOutput={focusOutputControl}
                        onStatsChange={setRuntimeStats}
                        isRunning={isEngineRunning}
                        processReady={engineProcessReady}
                        host={currentHost}
                        sampleRate={currentSampleRate}
                        bufferSize={currentBufferSize}
                        onOpenVoiceCheck={onOpenVoiceCheck}
                        onOpenSoundSettings={onOpenSoundSettings}
                        onOpenAudioTuning={onOpenAudioTuning}
                        compare={compareInColumn && <TooltipProvider>
                            <div className="flex min-w-0 shrink-0 flex-col gap-1">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        id="ab-compare-btn"
                                        type="button"
                                        disabled={compareDisabled}
                                        onClick={() => { if (!compareDisabled) void handleABToggle(); }}
                                        aria-label={t('header.compare')}
                                        role="switch"
                                        aria-checked={isABBypassed}
                                        aria-describedby={compareDescribedBy}
                                        title={compareReason}
                                        className={cn(
                                            "home-control flex w-full min-w-0 shrink-0 items-center gap-1.5 rounded-card border px-2.5 py-1 text-ui-control disabled:cursor-not-allowed disabled:opacity-50",
                                            isABBypassed
                                                ? "bg-warning/10 text-warning border-warning/50 ring-1 ring-warning/30"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                        )}
                                    >
                                        <span aria-hidden="true" className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5', isABBypassed ? 'bg-warning' : 'bg-muted-foreground/40')}>
                                            <span className={cn('h-4 w-4 rounded-full bg-background', isABBypassed && 'translate-x-4')} />
                                        </span>
                                        <span className="flex min-w-0 flex-col items-start text-left">
                                            <span>{t('header.compare')}</span>
                                            {isABBypassed && <span id="safety-compare-state" className="text-ui-support font-medium">{t('header.vstOff')}</span>}
                                        </span>
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{isABBypassed ? t(music ? 'header.compareEndHintMusic' : 'header.compareEndHint') : t(music ? 'header.compareStartHintMusic' : 'header.compareStartHint')}</p>
                                </TooltipContent>
                            </Tooltip>
                            {/* 列が狭いので、理由はボタンの中へ入れず、直下に置く。止まっているあいだは既存どおり title と読み上げだけにする。 */}
                            {compareStopped && <span id="safety-compare-needs-audio" className="sr-only">{compareNeedsAudio}</span>}
                            {compareNeedsVst && <p id="safety-compare-needs-vst" className="min-w-0 whitespace-normal break-words text-ui-support text-muted-foreground">{compareNeedsVst}</p>}
                            </div>
                        </TooltipProvider>}
                    />
                </aside>
            </div>
            {overlays}
        </div></RuntimeStatsContext.Provider></MeterProvider>
    );
};

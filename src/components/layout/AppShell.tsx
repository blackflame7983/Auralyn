import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useUsageWindow } from '@/hooks/useUsageWindow';
import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { LoudnessCheck } from '../features/LevelMeter/LoudnessCheck';
import { HomePanels } from '../features/Home/HomePanels';
import { LiveStrip } from '../features/Home/LiveStrip';
import { SoundChain } from '../features/Home/SoundChain';
import { usePreparation } from '@/hooks/usePreparation';
import { useVstPanel } from '@/hooks/useVstPanel';
import { usePanelMotion } from '@/hooks/usePanelMotion';
import React, { ReactNode, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Header } from './Header';
import { audioApi } from '../../api/audio';
import { MdCompareArrows, MdGraphicEq, MdSpeed } from 'react-icons/md';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { listen } from '@tauri-apps/api/event';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface AppShellProps {
    notices?: ReactNode;
    preparationBlocked?: boolean;
    onOpenOBSSettings: () => void;
    children: ReactNode;
    onOpenSettings: () => void;
    onOpenSoundSettings?: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide: () => void;
    onOpenTroubleshoot: () => void;
    onOpenVoiceCheck: () => void;
    onOpenWizard: () => void;
    onToggleLargeMeter: () => void;
    isLargeMeterOpen: boolean;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
    isEngineRunning: boolean;
    engineProcessReady?: boolean | null;
    currentInput?: string;
    currentOutput?: string;
    /** 本番帯に置く歌・雑談の切替。登録前は描画されない。 */
    liveControls?: ReactNode;
    /** チェーン列の VST 段の中身。 */
    vstChain?: ReactNode;
    /** 右パネルに出す VST ラック。 */
    vstPanel?: ReactNode;
}

import { MasterBar } from './MasterBar';
import { MeterProvider } from '../features/LevelMeter/MeterContext';
import type { EngineRuntimeStats } from '@/api/audio';
import { RuntimeStatsContext } from './RuntimeStatsContext';

export const AppShell: React.FC<AppShellProps> = ({
    children,
    notices,
    preparationBlocked,
    onOpenOBSSettings,
    onOpenSettings,
    onOpenSoundSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onOpenTroubleshoot,
    onOpenVoiceCheck,
    onOpenWizard,
    onToggleLargeMeter,
    isLargeMeterOpen,
    currentHost,
    currentSampleRate,
    currentBufferSize,
    isEngineRunning,
    engineProcessReady,
    currentInput,
    currentOutput,
    liveControls,
    vstChain,
    vstPanel
}) => {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    useUsageWindow(purpose);
    const [runtimeStats, setRuntimeStats] = useState<EngineRuntimeStats | null>(null);
    useEffect(() => { setRuntimeStats(null); }, [isEngineRunning]);
    const shellRef = useRef<HTMLDivElement>(null);
    const footerRef = useRef<HTMLElement>(null);
    // 折り返したフッターが大型メーターを覆わないよう、実高さを共有する。
    useLayoutEffect(() => {
        const shell = shellRef.current;
        const footer = footerRef.current;
        if (!shell || !footer) return;
        const updateHeight = () => {
            const height = footer.getBoundingClientRect().height;
            if (height > 0) shell.style.setProperty('--app-footer-height', `${height}px`);
        };
        updateHeight();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(updateHeight);
        observer.observe(footer);
        return () => observer.disconnect();
    }, []);

    const audioReady = Boolean(currentHost) && isEngineRunning && engineProcessReady === true;
    const preparation = usePreparation({ blocked: preparationBlocked, running: audioReady });
    const [loudnessEnabled, setLoudnessEnabled] = useState(false);
    const [measurement, setMeasurement] = useState({ active: false, busy: false, stopUnconfirmed: false });
    const [measurementRequest, setMeasurementRequest] = useState<{id: number; action: 'start' | 'stop'}>();
    const requestId = useRef(0);
    // VST 構成は右パネルで編集する。開いたら見出しへ移り、キーボードでもそのまま続けられるようにする。
    const [vstPanelOpen, setVstPanelOpen] = useVstPanel();
    // ホームの操作幅を保てない間は重ね表示にする。メーター併用時はその幅も確保する。
    const [panelBeside, setPanelBeside] = useState(false);
    useLayoutEffect(() => {
        const media = window.matchMedia?.(`(min-width: ${isLargeMeterOpen ? 1536 : 1440}px)`);
        if (!media) return;
        const update = () => setPanelBeside(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, [isLargeMeterOpen]);
    const panelOverlays = Boolean(vstPanel) && vstPanelOpen && !panelBeside;
    const panelRef = useRef<HTMLElement>(null);
    const panelMotion = usePanelMotion(Boolean(vstPanel) && vstPanelOpen);
    useEffect(() => {
        if (!panelOverlays) return;
        const close = (event: KeyboardEvent) => {
            // 入れ子のメニューや設定画面の Escape は、その画面に任せる。
            if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) {
                event.preventDefault();
                setVstPanelOpen(false);
            }
        };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [panelOverlays, setVstPanelOpen]);
    useEffect(() => {
        if (panelOverlays && document.activeElement?.closest('main'))
            document.getElementById('plugin-rack-heading')?.focus({ preventScroll: true });
    }, [panelOverlays]);
    const [focusRack, setFocusRack] = useState(0);
    const openRack = () => { setVstPanelOpen(true); setFocusRack(n => n + 1); };
    useEffect(() => {
        if (!focusRack) return;
        document.getElementById('plugin-rack-heading')?.focus({ preventScroll: true });
    }, [focusRack]);
    // パネルを閉じてフォーカスの行き場がなくなったら、開いたボタンへ戻してキーボード操作を続けられるようにする。
    const panelWasOpen = useRef(vstPanelOpen);
    useEffect(() => {
        if (panelWasOpen.current && !vstPanelOpen && (document.activeElement === document.body || !document.activeElement || panelRef.current?.contains(document.activeElement)))
            document.getElementById('vst-panel-toggle')?.focus({ preventScroll: true });
        panelWasOpen.current = vstPanelOpen;
    }, [vstPanelOpen]);
    // 未設定の間は本番帯を出さず、準備の主ボタンを先頭にする。
    const configured = Boolean(currentHost) && preparation.observation.availability !== 'unconfigured';
    // 音楽鑑賞の聴き比べは、準備の手順とチェーン列のどちらからも開く。
    const [listenOpen, setListenOpen] = useState(false);
    const openListen = purpose === 'music' ? () => setListenOpen(true) : onOpenVoiceCheck;
    // 開いた後の測定・停止・閉じるはパネル側に集める。押せない理由は画面にも出し、押せるときの対象範囲は読み上げだけにする。
    const loudnessLabel = t(measurement.busy ? 'loudness.switching' : measurement.stopUnconfirmed ? 'loudness.retryStop' : measurement.active ? 'loudness.stop' : 'loudness.startAction');
    // 大型メーターは声のレベルを大きく見るためのものなので、ヘッダーではなく本番帯のメーター横から開く。
    const largeMeterLabel = t(isLargeMeterOpen ? 'header.meterClose' : 'header.meterOpen');
    const largeMeterButton = <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><button type="button" onClick={onToggleLargeMeter} aria-pressed={isLargeMeterOpen}
        aria-label={largeMeterLabel}
        className={cn('inline-flex shrink-0 items-center rounded-md border p-1.5', isLargeMeterOpen ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border hover:bg-muted')}>
        <MdGraphicEq aria-hidden="true" className="h-[18px] w-[18px]" />
    </button></TooltipTrigger><TooltipContent><p>{t('home.largeMeterTool')}</p><p className="max-w-64 text-xs">{t('meter.arrivalUnverified')}</p></TooltipContent></Tooltip></TooltipProvider>;
    const loudnessAction = !loudnessEnabled && !measurement.active ? <span className="flex shrink-0 items-center gap-2">
        <span id="loudness-toggle-description" className={!audioReady ? 'whitespace-nowrap text-xs text-muted-foreground' : 'sr-only'}>{!audioReady ? t(engineProcessReady === null ? 'loudness.audioUnknown' : 'loudness.needsAudio') : t('loudness.scope')}</span>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><button type="button" aria-pressed={measurement.active} aria-describedby="loudness-toggle-description"
            onClick={() => { setLoudnessEnabled(true); setMeasurementRequest({ id: ++requestId.current, action: measurement.active ? 'stop' : 'start' }); }}
            disabled={measurement.busy || (!measurement.active && !audioReady)}
            aria-label={loudnessLabel}
            className="inline-flex items-center rounded-md border border-border p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent">
            {/* 本番帯を詰めないようアイコンだけにし、名前は読み上げとツールチップで伝える。 */}
            <MdSpeed aria-hidden="true" className="h-[18px] w-[18px]" />
        </button></TooltipTrigger><TooltipContent><p>{t('home.loudnessTool')}</p><p className="max-w-64 text-xs">{t('loudness.scope')}</p></TooltipContent></Tooltip></TooltipProvider>
    </span> : null;
    const soundChain = <SoundChain model={preparation} audioReady={audioReady} isEngineRunning={isEngineRunning} inputName={currentInput} outputName={currentOutput}
        vst={vstChain} listenOpen={listenOpen} onListen={openListen} onListenClose={() => setListenOpen(false)}
        onOpenSettings={onOpenSettings} onOpenOBSSettings={onOpenOBSSettings} onOpenSoundSettings={onOpenSoundSettings} onOpenVst={openRack} vstPanelOpen={Boolean(vstPanel) && vstPanelOpen} />;
    const [isABBypassed, setIsABBypassed] = useState(false);
    const handleABToggle = useCallback(async () => {
        try {
            const next = !isABBypassed;
            await audioApi.setGlobalBypass(next);
            setIsABBypassed(next);
            if (next) {
                toast.warning(<LocalizedMessage id="shell.compareOn" />);
            } else {
                toast.success(<LocalizedMessage id="shell.compareOff" />);
            }
        } catch (e) {
            console.error("A/B toggle failed", e);
            toast.error(<LocalizedMessage id="shell.compareFailed" />);
        }
    }, [isABBypassed]);

    useEffect(() => {
        const unlisten = listen<boolean>('global-bypass-changed', event => setIsABBypassed(event.payload));
        return () => { void unlisten.then(stop => stop()); };
    }, []);

    return (
        <MeterProvider running={isEngineRunning}><RuntimeStatsContext.Provider value={{ stats: runtimeStats, running: audioReady }}><div ref={shellRef} data-panel-instant={panelMotion.instant || undefined}
            data-vst-open={Boolean(vstPanel) && vstPanelOpen || undefined} data-vst-overlay={panelOverlays || undefined} data-large-meter={isLargeMeterOpen || undefined}
            data-meter-suspended={panelMotion.present && !panelBeside || undefined}
            className="app-shell min-h-screen bg-muted/30 dark:bg-background text-foreground font-sans selection:bg-primary/20 overflow-hidden transition-colors duration-300">
            {/* 背景のオーロラ。音声処理中（本番中とみなす）と動きを減らす設定では止める（DESIGN.md 5.6）。 */}
            <div className={`fixed inset-0 pointer-events-none z-0 opacity-0 dark:opacity-100 transition-opacity duration-500 ${isEngineRunning ? '[&>.aurora-glow]:[animation-play-state:paused]' : ''}`}>
                <div className="aurora-glow absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-brand-secondary/5 blur-[130px] rounded-full mix-blend-screen animate-[pulse_8s_ease-in-out_infinite]" />
                <div className="aurora-glow absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-brand/10 blur-[100px] rounded-full mix-blend-screen animate-[pulse_10s_ease-in-out_infinite_reverse]" />
            </div>

            {/* Subtle Grid overlay - Fades out in center to avoid distraction */}
            <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.02] bg-[linear-gradient(currentColor_1px,transparent_1px),linear-gradient(90deg,currentColor_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_at_center,transparent_40%,black_80%)]" />

            <div className="relative z-10 flex flex-col h-screen">
                <Header
                    onOpenSettings={onOpenSettings}
                    onOpenOBSGuide={onOpenOBSGuide}
                    onOpenDiscordGuide={onOpenDiscordGuide}
                    onOpenTroubleshoot={onOpenTroubleshoot}
                    onOpenWizard={onOpenWizard}
                    stats={runtimeStats}
                    currentHost={currentHost}
                    currentSampleRate={currentSampleRate}
                    currentBufferSize={currentBufferSize}
                    isEngineRunning={isEngineRunning}
                    engineProcessReady={engineProcessReady}
                />
                {/* 重ね表示は中央の作業領域だけを覆う。緊急ミュートと出力音量は操作できるままにする。 */}
                <div className="relative flex min-h-0 flex-1">
                <main
                    inert={panelOverlays}
                    className="home-main min-w-0 flex-1 overflow-y-auto p-4 lg:p-6 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent"
                >
                    {/* 左右に分けると片側だけが詰まって見えるので、どの幅でも上から1列に並べ、広い画面では中央に寄せる。 */}
                    <div className="mx-auto max-w-[1180px]">
                        {notices}
                        {/* 音量チェックと大型メーターは本番帯のメーター横に置き、ホーム上部に常設の行を作らない。
                            未設定の間は準備の主ボタンを先頭にし、止まったメーターを重ねない。
                            歌・雑談の切替は本番保護の解除や失敗の表示を兼ねるので、本番帯がなくても残す。 */}
                        {configured
                            ? <LiveStrip model={preparation} running={isEngineRunning} liveControls={liveControls} onOpenDevices={onOpenSettings} inputName={currentInput} outputName={currentOutput} meterAction={<span className="flex shrink-0 items-center gap-2">{loudnessAction}{largeMeterButton}</span>} />
                            : liveControls && <div className="mb-4 rounded-xl border border-border bg-card/70 px-4 py-3 empty:hidden">{liveControls}</div>}
                        {/* 音量チェックは開いたメーターの直下に出す。 */}
                        <div><LoudnessCheck
                            music={purpose === 'music'}
                            enabled={loudnessEnabled}
                            request={measurementRequest} onStateChange={setMeasurement} onClose={() => setLoudnessEnabled(false)}
                            running={audioReady}
                            stateKnown={engineProcessReady !== null}
                            onVoiceCheck={onOpenVoiceCheck}
                        /></div>
                        {/* チェーン列は本番帯の直下に置き、準備や経路の情報より下へ押し出さない。未設定の間だけ準備の後ろへ回す。 */}
                        {configured && soundChain}
                        <div className="min-w-0"><HomePanels
                            model={preparation}
                            audioReady={audioReady}
                            statusText={audioReady ? undefined : engineProcessReady === null ? t('shell.unknown') : currentHost ? t('shell.stopped') : t('shell.unconfigured')}
                            inputName={currentInput} outputName={currentOutput}
                            onOpenSettings={onOpenSettings} onOpenOBSSettings={onOpenOBSSettings}
                            onCheckOutput={() => {
                                const target = runtimeStats?.preparation?.muted === false && runtimeStats.preparation.outputGain === 0
                                    ? '#master-output-gain [role="slider"]' : '#emergency-mute';
                                document.querySelector<HTMLElement>(target)?.focus();
                            }}
                            onOpenSoundSettings={onOpenSoundSettings} onListen={openListen}
                            onOpenOBSGuide={onOpenOBSGuide} onOpenDiscordGuide={onOpenDiscordGuide} onOpenTroubleshoot={onOpenTroubleshoot}
                        /></div>
                        <div className="min-w-0">
                        <div id="home-rack">{children}</div>
                        </div>
                        {!configured && soundChain}
                    </div>
                </main>
                {panelOverlays && <div aria-hidden="true" className="vst-panel-scrim absolute inset-0 z-[44] bg-overlay/35" onClick={() => setVstPanelOpen(false)} />}
                {/* パネルと同じ時間で予約幅を戻す。退場後のアンマウントではホームの幅を変えない。 */}
                {vstPanel && <div aria-hidden="true" className="vst-panel-space" data-state={vstPanelOpen ? 'open' : 'closed'} />}
                {panelMotion.present && <aside ref={panelRef} id="vst-panel" aria-labelledby="plugin-rack-heading"
                    data-state={vstPanelOpen ? 'open' : 'closed'} aria-hidden={!vstPanelOpen} inert={!vstPanelOpen}
                    onTransitionEnd={panelMotion.onTransitionEnd}
                    className="vst-panel-motion absolute inset-y-0 right-0 z-[45] w-[min(420px,100%)] overflow-y-auto border-l border-border bg-background p-4 shadow-2xl scrollbar-thin">
                    {vstPanel}
                </aside>}
                </div>

                {/* Master Section Footer */}
                <footer ref={footerRef} className="min-h-16 bg-background border-t border-border px-4 z-50 footer-shadow shrink-0 transition-colors duration-300">
                    <div className="mx-auto max-w-[1180px] w-full flex items-start gap-3">
                    <div className="flex shrink-0 items-center py-2">
                        {/* Effect Compare Button */}
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        id="ab-compare-btn"
                                        onClick={handleABToggle}
                                        aria-label={t('header.compare')}
                                        aria-pressed={isABBypassed}
                                        aria-describedby={isABBypassed ? 'footer-compare-state' : undefined}
                                        className={cn(
                                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold font-mono whitespace-nowrap shrink-0",
                                            isABBypassed
                                                ? "bg-warning/10 text-warning border-warning/50 ring-1 ring-warning/30 animate-pulse"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                        )}
                                    >
                                        <MdCompareArrows aria-hidden="true" className="w-4 h-4" />
                                        <span className="flex flex-col items-start">
                                            <span>{t('header.compare')}</span>
                                            {isABBypassed && <span id="footer-compare-state" className="text-xs font-medium">{t('header.vstOff')}</span>}
                                        </span>
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{isABBypassed ? t('header.compareEndHint') : t('header.compareStartHint')}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                    <div className="flex-1 min-w-0">
                        <MasterBar
                            onStatsChange={setRuntimeStats}
                            isRunning={isEngineRunning}
                            processReady={engineProcessReady}
                            host={currentHost}
                            sampleRate={currentSampleRate}
                            bufferSize={currentBufferSize}
                            onOpenVoiceCheck={onOpenVoiceCheck}
                            onOpenSoundSettings={onOpenSoundSettings}
                        />
                    </div>
                    </div>
                </footer>
            </div>
        </div></RuntimeStatsContext.Provider></MeterProvider>
    );
};

import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useUsageWindow } from '@/hooks/useUsageWindow';
import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { LoudnessCheck } from '../features/LevelMeter/LoudnessCheck';
import { HomePanels } from '../features/Home/HomePanels';
import { LiveStrip } from '../features/Home/LiveStrip';
import { usePreparation } from '@/hooks/usePreparation';
import React, { ReactNode, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Header } from './Header';
import { audioApi } from '../../api/audio';
import { MdCompareArrows } from 'react-icons/md';
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
    preparationBlocked?: boolean;
    isBeginnerMode: boolean;
    onDisplayModeChange: (beginner: boolean) => void;
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
}

import { MasterBar } from './MasterBar';
import { MeterProvider } from '../features/LevelMeter/MeterContext';
import type { EngineRuntimeStats } from '@/api/audio';
import { RuntimeStatsContext } from './RuntimeStatsContext';

export const AppShell: React.FC<AppShellProps> = ({
    children,
    preparationBlocked,
    isBeginnerMode,
    onDisplayModeChange,
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
    liveControls
}) => {
    const t = useMessages();
    const [purpose, setPurpose] = useDisplayPurpose();
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
    const openRack = () => {
        const rack = document.getElementById('home-rack');
        if (!rack) return;
        const disclosure = document.getElementById('plugin-rack-disclosure') as HTMLDetailsElement | null;
        if (disclosure) disclosure.open = true;
        const target = document.getElementById('plugin-rack-heading');
        target?.scrollIntoView?.({ block: 'start' });
        target?.focus({ preventScroll: true });
    };
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
        <MeterProvider running={isEngineRunning}><RuntimeStatsContext.Provider value={{ stats: runtimeStats, running: audioReady }}><div ref={shellRef} className="min-h-screen bg-muted/30 dark:bg-background text-foreground font-sans selection:bg-primary/20 overflow-hidden transition-colors duration-300">
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
                    onToggleLargeMeter={onToggleLargeMeter}
                    isLargeMeterOpen={isLargeMeterOpen}
                    stats={runtimeStats}
                    currentHost={currentHost}
                    currentSampleRate={currentSampleRate}
                    currentBufferSize={currentBufferSize}
                    isEngineRunning={isEngineRunning}
                    engineProcessReady={engineProcessReady}
                />
                <main
                    className={`flex-1 overflow-y-auto p-4 lg:p-6 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent pb-4 ${isLargeMeterOpen ? 'pr-36 lg:pr-36' : ''}`}
                >
                    <div className="max-w-4xl mx-auto min-[1280px]:max-w-none min-[1280px]:grid min-[1280px]:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] min-[1280px]:gap-x-6">
                        <div
                            className="mb-3 flex flex-wrap items-center justify-between gap-3 min-[1280px]:col-span-2"
                            aria-label={t('shell.view')}
                        >
                            <label className="flex flex-wrap items-center gap-2 text-sm">
                                {t('purpose.label')}
                                <select value={purpose} onChange={event => setPurpose(event.target.value as 'voice' | 'music')} className="rounded border border-border bg-background p-2">
                                    <option value="voice">{t('purpose.voice')}</option><option value="music">{t('purpose.music')}</option>
                                </select>
                            </label>
                            <div
                                role="group"
                                aria-label={t('shell.viewGoal')}
                                className="flex flex-wrap gap-2"
                            >
                                <button
                                    aria-pressed={isBeginnerMode}
                                    onClick={() => onDisplayModeChange(true)}
                                    className="rounded-md border border-border px-3 py-2 text-sm aria-pressed:border-primary aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-primary/40"
                                >
                                    {t('shell.simple')}
                                </button>
                                <button
                                    aria-pressed={!isBeginnerMode}
                                    onClick={() => onDisplayModeChange(false)}
                                    className="rounded-md border border-border px-3 py-2 text-sm aria-pressed:border-primary aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-primary/40"
                                >
                                    {t('shell.advanced')}
                                </button>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                            {/* 開いた後の測定・停止・閉じるはパネル側に集める。 */}
                            {!loudnessEnabled && !measurement.active && <button
                                type="button"
                                aria-pressed={measurement.active}
                                onClick={() => { setLoudnessEnabled(true); setMeasurementRequest({id: ++requestId.current, action: measurement.active ? 'stop' : 'start'}); }}
                                disabled={measurement.busy || (!measurement.active && !audioReady)}
                                aria-describedby="loudness-toggle-description"
                                className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted aria-pressed:border-primary aria-pressed:bg-muted aria-pressed:ring-1 aria-pressed:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                            >
                                {t(measurement.busy ? 'loudness.switching' : measurement.stopUnconfirmed ? 'loudness.retryStop' : measurement.active ? 'loudness.stop' : 'loudness.startAction')}
                            </button>}
                            {/* 押せない理由は画面にも出す。押せるときの対象範囲は読み上げだけにする。 */}
                            <span id="loudness-toggle-description" className={!audioReady && !loudnessEnabled && !measurement.active ? 'text-xs text-muted-foreground' : 'sr-only'}>{!audioReady ? t(engineProcessReady === null ? 'loudness.audioUnknown' : 'loudness.needsAudio') : t('loudness.scope')}</span>
                            </div>
                        </div>
                        <div className="min-[1280px]:col-span-2"><LoudnessCheck
                            music={purpose === 'music'}
                            enabled={loudnessEnabled}
                            request={measurementRequest} onStateChange={setMeasurement} onClose={() => setLoudnessEnabled(false)}
                            running={audioReady}
                            stateKnown={engineProcessReady !== null}
                            onVoiceCheck={onOpenVoiceCheck}
                        /></div>
                        {/* 未設定の間は準備の主ボタンを先頭にし、止まったメーターを重ねない。
                            歌・雑談の切替は本番保護の解除や失敗の表示を兼ねるので、本番帯がなくても残す。 */}
                        {Boolean(currentHost) && preparation.observation.availability !== 'unconfigured'
                            ? <LiveStrip model={preparation} running={isEngineRunning} liveControls={liveControls} />
                            : liveControls && <div className="mb-3 rounded-xl border border-border bg-card/70 px-3 py-2 empty:hidden min-[1280px]:col-span-2">{liveControls}</div>}
                        <div className="min-w-0"><HomePanels
                            model={preparation}
                            audioReady={audioReady}
                            statusText={audioReady ? undefined : engineProcessReady === null ? t('shell.unknown') : currentHost ? t('shell.stopped') : t('shell.unconfigured')}
                            isEngineRunning={isEngineRunning}
                            inputName={currentInput} outputName={currentOutput}
                            onOpenSettings={onOpenSettings} onOpenOBSSettings={onOpenOBSSettings}
                            onOpenSoundSettings={onOpenSoundSettings} onOpenVoiceCheck={onOpenVoiceCheck}
                            onOpenOBSGuide={onOpenOBSGuide} onOpenDiscordGuide={onOpenDiscordGuide} onOpenTroubleshoot={onOpenTroubleshoot} onOpenVst={openRack}
                        /></div>
                        <div className="min-w-0">
                        <div id="home-rack">{children}</div>
                        </div>
                    </div>
                </main>

                {/* Master Section Footer */}
                <footer ref={footerRef} className="min-h-16 bg-background border-t border-border px-4 z-50 footer-shadow shrink-0 transition-colors duration-300">
                    <div className="w-full flex items-start gap-3">
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

import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { LoudnessCheck } from '../features/LevelMeter/LoudnessCheck';
import { HomePanels } from '../features/Home/HomePanels';
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
}

import { MasterBar } from './MasterBar';

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
    currentOutput
}) => {
    const t = useMessages();
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
    const [loudnessEnabled, setLoudnessEnabled] = useState(false);
    useEffect(() => setLoudnessEnabled(false), [isBeginnerMode]);
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
        <div ref={shellRef} className="min-h-screen bg-muted/30 dark:bg-background text-foreground font-sans selection:bg-primary/20 overflow-hidden transition-colors duration-300">
            {/* Ambient Animated Glows - Visible mainly in Dark Mode */}
            <div className="fixed inset-0 pointer-events-none z-0 opacity-0 dark:opacity-100 transition-opacity duration-500">
                <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-brand-secondary/5 blur-[130px] rounded-full mix-blend-screen animate-[pulse_8s_ease-in-out_infinite]" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-brand/10 blur-[100px] rounded-full mix-blend-screen animate-[pulse_10s_ease-in-out_infinite_reverse]" />
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
                    currentHost={currentHost}
                    currentSampleRate={currentSampleRate}
                    currentBufferSize={currentBufferSize}
                    isEngineRunning={isEngineRunning}
                    engineProcessReady={engineProcessReady}
                />
                <main
                    className={`flex-1 overflow-y-auto p-4 lg:p-6 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent pb-4 transition-all duration-300 ${isLargeMeterOpen ? 'pr-36 lg:pr-36' : ''}`}
                >
                    <div className="max-w-4xl mx-auto">
                        <div
                            className="mb-3 flex flex-wrap items-center justify-between gap-3"
                            aria-label={t('shell.view')}
                        >
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
                            <button
                                type="button"
                                aria-pressed={loudnessEnabled}
                                onClick={() => setLoudnessEnabled(value => !value)}
                                title={t('shell.loudnessHint')}
                                className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted aria-pressed:border-primary aria-pressed:bg-muted aria-pressed:ring-1 aria-pressed:ring-primary/40"
                            >
                                {t('shell.loudness')}
                            </button>
                        </div>
                        <HomePanels
                            audioReady={audioReady}
                            statusText={audioReady ? undefined : engineProcessReady === null ? t('shell.unknown') : currentHost ? t('shell.stopped') : t('shell.unconfigured')}
                            isEngineRunning={isEngineRunning}
                            inputName={currentInput} outputName={currentOutput}
                            blocked={preparationBlocked}
                            onOpenSettings={onOpenSettings} onOpenOBSSettings={onOpenOBSSettings}
                            onOpenSoundSettings={onOpenSoundSettings} onOpenVoiceCheck={onOpenVoiceCheck}
                            onOpenOBSGuide={onOpenOBSGuide} onOpenDiscordGuide={onOpenDiscordGuide} onOpenTroubleshoot={onOpenTroubleshoot}
                        />
                        <LoudnessCheck
                            enabled={loudnessEnabled}
                            running={isEngineRunning}
                            stateKnown={engineProcessReady !== null}
                            onVoiceCheck={onOpenVoiceCheck}
                        />
                        {children}
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
                                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold font-mono transition-all whitespace-nowrap shrink-0",
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
        </div>
    );
};

import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { LoudnessCheck } from '../features/LevelMeter/LoudnessCheck';
import React, { ReactNode, useState, useCallback, useEffect } from 'react';
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
}

import { MasterBar } from './MasterBar';

export const AppShell: React.FC<AppShellProps> = ({
    children,
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
    engineProcessReady
}) => {
    const t = useMessages();
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
        <div className="min-h-screen bg-muted/30 dark:bg-background text-foreground font-sans selection:bg-primary/20 overflow-hidden transition-colors duration-300">
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
                    onToggleGlobalBypass={handleABToggle}
                    isGlobalBypassed={isABBypassed}
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
                    <div className="max-w-4xl mr-auto ml-0">
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
                                    className="rounded-md border border-border px-3 py-2 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                                >
                                    {t('shell.simple')}
                                </button>
                                <button
                                    aria-pressed={!isBeginnerMode}
                                    onClick={() => onDisplayModeChange(false)}
                                    className="rounded-md border border-border px-3 py-2 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                                >
                                    {t('shell.advanced')}
                                </button>
                            </div>
                            {isBeginnerMode && (
                                <button
                                    onClick={onOpenOBSSettings}
                                    className="rounded-md border border-border px-3 py-2 text-sm"
                                >
                                    {t('shell.obs')}
                                </button>
                            )}
                            {!isBeginnerMode && (
                                <label className="flex items-center gap-2 text-sm" title={t('shell.loudnessHint')}>
                                    <input type="checkbox" checked={loudnessEnabled} onChange={e => setLoudnessEnabled(e.target.checked)} />
                                    {t('shell.loudness')}
                                </label>
                            )}
                        </div>
                        {!isEngineRunning && (
                            <section aria-label={t('shell.start')} className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                                <p role="status" className="text-sm font-semibold">{engineProcessReady === null ? t('shell.unknown') : currentHost ? t('shell.stopped') : t('shell.unconfigured')}</p>
                                <button onClick={onOpenSettings} className="rounded-md bg-primary px-3 py-1.5 text-sm font-bold text-primary-foreground">{t('shell.configure')}</button>
                            </section>
                        )}
                        {isBeginnerMode && (
                            <section aria-label={t('shell.prepare')} className="mb-3 grid grid-cols-2 gap-3">
                                <button onClick={onOpenSoundSettings ?? onOpenSettings} className="text-left rounded-md border border-border bg-card p-3 hover:bg-muted">
                                    <span className="block text-sm font-semibold">{t('shell.sound')}</span>
                                    <span className="block text-xs text-muted-foreground mt-1">{t('shell.soundHint')}</span>
                                </button>
                                <button onClick={onOpenVoiceCheck} className="text-left rounded-md border border-border bg-card p-3 hover:bg-muted">
                                    <span className="block text-sm font-semibold">{t('shell.listen')}</span>
                                    <span className="block text-xs text-muted-foreground mt-1">{t('shell.listenHint')}</span>
                                </button>
                            </section>
                        )}
                        {isBeginnerMode && <label className="mb-2 flex items-center gap-2 text-sm" title={t('shell.loudnessHint')}><input type="checkbox" checked={loudnessEnabled} onChange={e => setLoudnessEnabled(e.target.checked)} />{t('shell.loudness')}</label>}
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
                <footer className="h-16 bg-background border-t border-border px-4 z-50 footer-shadow shrink-0 transition-colors duration-300 overflow-x-auto">
                    <div className="h-full w-full min-w-max flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        {/* Effect Compare Button */}
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        id="ab-compare-btn"
                                        onClick={handleABToggle}
                                        aria-label={isABBypassed ? `${t('shell.comparingEffectsOff')}：${t('header.compareEnd')}` : t('header.compareStart')}
                                        className={cn(
                                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold font-mono transition-all whitespace-nowrap shrink-0",
                                            isABBypassed
                                                ? "bg-warning/10 text-warning border-warning/50 ring-1 ring-warning/30 animate-pulse"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                        )}
                                    >
                                        <MdCompareArrows className="w-4 h-4" />
                                        <span className="hidden xl:inline">{isABBypassed ? t('shell.comparingEffectsOff') : t('header.compare')}</span>
                                        <span className="xl:hidden">{isABBypassed ? t('header.comparing') : t('header.compare')}</span>
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{isABBypassed ? t('header.compareEndHint') : t('header.compareStartHint')}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                    <div className="h-full min-w-0">
                        <MasterBar
                            isRunning={isEngineRunning}
                            processReady={engineProcessReady}
                            host={currentHost}
                            sampleRate={currentSampleRate}
                            bufferSize={currentBufferSize}
                            onOpenVoiceCheck={onOpenVoiceCheck}
                        />
                    </div>
                    </div>
                </footer>
            </div>
        </div>
    );
};

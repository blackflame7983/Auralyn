import React, { ReactNode, useState, useCallback, useEffect } from 'react';
import { Header } from './Header';
import { audioApi } from '../../api/audio';
import { MdCompareArrows } from 'react-icons/md';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface AppShellProps {
    children: ReactNode;
    onOpenSettings: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide: () => void;
    onOpenTroubleshoot: () => void;
    onOpenWizard: () => void;
    onToggleLargeMeter: () => void;
    isLargeMeterOpen: boolean;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
    isEngineRunning: boolean;
}

import { MasterBar } from './MasterBar';

export const AppShell: React.FC<AppShellProps> = ({
    children,
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onOpenTroubleshoot,
    onOpenWizard,
    onToggleLargeMeter,
    isLargeMeterOpen,
    currentHost,
    currentSampleRate,
    currentBufferSize,
    isEngineRunning
}) => {
    const [isABBypassed, setIsABBypassed] = useState(false);
    const footerStatusText = !isEngineRunning
        ? '停止中'
        : isABBypassed
            ? '比較中'
            : '稼働中';
    const handleABToggle = useCallback(async () => {
        try {
            const next = !isABBypassed;
            await audioApi.setGlobalBypass(next);
            setIsABBypassed(next);
            if (next) {
                toast.warning('原音比較を開始しました（エフェクトOFF）');
            } else {
                toast.success('原音比較を終了しました（エフェクト再開）');
            }
        } catch (e) {
            console.error("A/B toggle failed", e);
            toast.error('原音比較の切替に失敗しました');
        }
    }, [isABBypassed]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.altKey &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                event.key.toLowerCase() === 'p'
            ) {
                event.preventDefault();
                void handleABToggle();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleABToggle]);

    return (
        <div className="min-h-screen bg-muted/30 dark:bg-background text-foreground font-sans selection:bg-primary/20 overflow-hidden transition-colors duration-300">
            {/* Ambient Animated Glows - Visible mainly in Dark Mode */}
            <div className="fixed inset-0 pointer-events-none z-0 opacity-0 dark:opacity-100 transition-opacity duration-500">
                <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-accent-secondary/5 blur-[130px] rounded-full mix-blend-screen animate-[pulse_8s_ease-in-out_infinite]" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-accent-primary/10 blur-[100px] rounded-full mix-blend-screen animate-[pulse_10s_ease-in-out_infinite_reverse]" />
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
                />
                <main
                    className={`flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent pb-4 transition-all duration-300 ${isLargeMeterOpen ? 'pr-36' : ''}`}
                >
                    <div className="max-w-4xl mr-auto ml-0">
                        {children}
                    </div>
                </main>

                {/* Master Section Footer */}
                <footer className="h-20 bg-background border-t border-border px-4 z-50 shadow-[0_-5px_20px_rgba(0,0,0,0.05)] dark:shadow-[0_-5px_20px_rgba(0,0,0,0.5)] shrink-0 transition-colors duration-300 overflow-hidden">
                    <div className="h-full w-full flex items-center justify-between gap-3 min-w-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="flex flex-col">
                            <span className="text-xs font-bold text-zinc-400 dark:text-zinc-500 tracking-widest">AURALYN</span>
                            <span className="text-[10px] text-zinc-500 dark:text-zinc-700 font-mono">{footerStatusText}</span>
                        </div>

                        {/* Effect Compare Button */}
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        id="ab-compare-btn"
                                        onClick={handleABToggle}
                                        aria-label={isABBypassed ? '原音比較を終了してエフェクト処理を再開する' : '原音比較を開始する（エフェクトOFF）'}
                                        className={cn(
                                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold font-mono transition-all whitespace-nowrap shrink-0",
                                            isABBypassed
                                                ? "bg-orange-500/10 text-orange-500 border-orange-500/50 ring-1 ring-orange-500/30 animate-pulse"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                        )}
                                    >
                                        <MdCompareArrows className="w-4 h-4" />
                                        <span className="hidden xl:inline">{isABBypassed ? '原音比較中（エフェクトOFF）' : '原音比較'}</span>
                                        <span className="xl:hidden">{isABBypassed ? '比較中' : '比較'}</span>
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{isABBypassed ? 'Alt+P またはクリックで原音比較を終了（エフェクト再開）' : 'Alt+P またはクリックで原音比較を開始（エフェクトOFF）'}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                    <div className="h-full py-2 min-w-0">
                        <MasterBar
                            host={currentHost}
                            sampleRate={currentSampleRate}
                            bufferSize={currentBufferSize}
                        />
                    </div>
                    </div>
                </footer>
            </div>
        </div>
    );
};

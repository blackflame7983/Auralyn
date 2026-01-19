import React, { ReactNode } from 'react';
import { Header } from './Header';

interface AppShellProps {
    children: ReactNode;
    onOpenSettings: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide: () => void;
    onToggleLargeMeter: () => void;
    isLargeMeterOpen: boolean;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
}

import { MasterBar } from './MasterBar';

export const AppShell: React.FC<AppShellProps> = ({
    children,
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onToggleLargeMeter,
    isLargeMeterOpen,
    currentHost,
    currentSampleRate,
    currentBufferSize
}) => {
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
                    onToggleLargeMeter={onToggleLargeMeter}
                    isLargeMeterOpen={isLargeMeterOpen}
                    currentHost={currentHost}
                    currentSampleRate={currentSampleRate}
                    currentBufferSize={currentBufferSize}
                />
                <main
                    className={`flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent pb-4 transition-all duration-300 ${isLargeMeterOpen ? 'pr-36' : ''}`}
                >
                    <div className="max-w-4xl mr-auto ml-0">
                        {children}
                    </div>
                </main>

                {/* Master Section Footer */}
                <footer className="h-20 bg-background border-t border-border flex items-center justify-between px-6 z-50 shadow-[0_-5px_20px_rgba(0,0,0,0.05)] dark:shadow-[0_-5px_20px_rgba(0,0,0,0.5)] shrink-0 transition-colors duration-300">
                    <div className="flex flex-col">
                        <span className="text-xs font-bold text-zinc-400 dark:text-zinc-500 tracking-widest">AURALYN</span>
                        <span className="text-[10px] text-zinc-500 dark:text-zinc-700 font-mono">READY</span>
                    </div>
                    <div className="h-full py-2">
                        <MasterBar />
                    </div>
                </footer>
            </div>
        </div>
    );
};

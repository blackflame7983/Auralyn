import { LoudnessCheck } from '../features/LevelMeter/LoudnessCheck';
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
    const [loudnessEnabled, setLoudnessEnabled] = useState(false);
    useEffect(() => setLoudnessEnabled(false), [isBeginnerMode]);
    const [isABBypassed, setIsABBypassed] = useState(false);
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
                    engineProcessReady={engineProcessReady}
                />
                <main
                    className={`flex-1 overflow-y-auto p-4 lg:p-6 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent pb-4 transition-all duration-300 ${isLargeMeterOpen ? 'pr-36 lg:pr-36' : ''}`}
                >
                    <div className="max-w-4xl mr-auto ml-0">
                        <div
                            className="mb-3 flex flex-wrap items-center justify-between gap-3"
                            aria-label="表示の切替"
                        >
                            <div
                                role="group"
                                aria-label="用途に合わせた表示"
                                className="flex flex-wrap gap-2"
                            >
                                <button
                                    aria-pressed={isBeginnerMode}
                                    onClick={() => onDisplayModeChange(true)}
                                    className="rounded-md border border-border px-3 py-2 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                                >
                                    配信向け・かんたん
                                </button>
                                <button
                                    aria-pressed={!isBeginnerMode}
                                    onClick={() => onDisplayModeChange(false)}
                                    className="rounded-md border border-border px-3 py-2 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                                >
                                    VST・詳細
                                </button>
                            </div>
                            {isBeginnerMode && (
                                <button
                                    onClick={onOpenOBSSettings}
                                    className="rounded-md border border-border px-3 py-2 text-sm"
                                >
                                    OBSを整える
                                </button>
                            )}
                            {!isBeginnerMode && (
                                <label className="flex items-center gap-2 text-sm" title="開始は手動です。非表示にすると測定を停止します。">
                                    <input type="checkbox" checked={loudnessEnabled} onChange={e => setLoudnessEnabled(e.target.checked)} />
                                    音量チェックを表示
                                </label>
                            )}
                        </div>
                        {!isEngineRunning && (
                            <section aria-label="音声の開始" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                                <p role="status" className="text-sm font-semibold">{engineProcessReady === null ? '音声の状態を確認できません' : currentHost ? '音声停止中' : '音声未設定'}</p>
                                <button onClick={onOpenSettings} className="rounded-md bg-primary px-3 py-1.5 text-sm font-bold text-primary-foreground">マイクと出力先を設定する</button>
                            </section>
                        )}
                        {isBeginnerMode && (
                            <section aria-label="配信前の準備" className="mb-3 grid grid-cols-2 gap-3">
                                <button onClick={onOpenSoundSettings ?? onOpenSettings} className="text-left rounded-md border border-border bg-card p-3 hover:bg-muted">
                                    <span className="block text-sm font-semibold">1. 声を整える</span>
                                    <span className="block text-xs text-muted-foreground mt-1">ノイズ低減・内蔵ボイスチェーン</span>
                                </button>
                                <button onClick={onOpenVoiceCheck} className="text-left rounded-md border border-border bg-card p-3 hover:bg-muted">
                                    <span className="block text-sm font-semibold">2. 録音して聴く</span>
                                    <span className="block text-xs text-muted-foreground mt-1">加工前後をボイスチェックで比較</span>
                                </button>
                            </section>
                        )}
                        {isBeginnerMode && <label className="mb-2 flex items-center gap-2 text-sm" title="開始は手動です。非表示にすると測定を停止します。"><input type="checkbox" checked={loudnessEnabled} onChange={e => setLoudnessEnabled(e.target.checked)} />音量チェックを表示</label>}
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
                <footer className="h-16 bg-background border-t border-border px-4 z-50 shadow-[0_-5px_20px_rgba(0,0,0,0.05)] dark:shadow-[0_-5px_20px_rgba(0,0,0,0.5)] shrink-0 transition-colors duration-300 overflow-x-auto">
                    <div className="h-full w-full min-w-max flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
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

import React, { useState, useEffect } from 'react';
import { LevelMeter } from '../features/LevelMeter/LevelMeter';
import { DeviceStatus } from '../features/DeviceStatus/DeviceStatus';
import { useTheme } from '../../hooks/useTheme';
import { DiscordIcon } from '../ui/DiscordIcon';
// Icons: Material Symbols via react-icons
import {
    MdSettings,
    MdHelpOutline,
    MdWbSunny,
    MdDarkMode,
    MdMicOff,
    MdGraphicEq,
    MdEmergency,
    MdGamepad
} from 'react-icons/md';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../api/audio';
import { toast } from 'sonner';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    TooltipProvider
} from "@/components/ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem
} from "@/components/ui/dropdown-menu";

interface HeaderProps {
    onOpenSettings: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide: () => void;
    onToggleLargeMeter: () => void;
    isLargeMeterOpen: boolean;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
}

export const Header: React.FC<HeaderProps> = ({
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onToggleLargeMeter,
    isLargeMeterOpen,
    currentHost,
    currentSampleRate,
    currentBufferSize
}) => {
    const { theme, setTheme } = useTheme();
    const [isGlobalMuted, setIsGlobalMuted] = useState(false);

    useEffect(() => {
        const unlisten = listen<boolean>('global-mute-changed', (event) => {
            setIsGlobalMuted(event.payload);
            if (event.payload) {
                toast.warning("緊急ミュートを有効化しました (音声停止)");
            } else {
                toast.success("ミュートを解除しました");
            }
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    const handleToggleMute = async () => {
        try {
            await audioApi.toggleGlobalMute();
        } catch (e) {
            console.error("Failed to toggle global mute", e);
        }
    };

    return (
        <header className={`h-16 flex items-center justify-between px-6 border-b sticky top-0 z-50 transition-colors duration-300 backdrop-blur-md ${theme === 'light'
            ? 'bg-white/95 border-border/20 shadow-sm'
            : 'bg-background/80 border-border/40'
            }`}>
            <TooltipProvider>
                <div className="flex items-center gap-6">
                    {/* Logo Section */}
                    <div className="flex items-center gap-3 select-none">
                        <img src="/auralyn_icon.png?v=17" alt="Auralyn Logo" className="w-8 h-8 object-contain drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" />
                        <h1 className="text-xl font-bold tracking-tight text-foreground">
                            Aura<span className="text-primary">lyn</span>
                        </h1>
                        <span className="text-[10px] bg-muted border border-border px-2 py-0.5 rounded text-muted-foreground font-mono">
                            BETA
                        </span>
                    </div>

                    {/* Device Status (Quick Access to Settings) */}
                    <DeviceStatus
                        host={currentHost}
                        sampleRate={currentSampleRate}
                        bufferSize={currentBufferSize}
                        onClick={onOpenSettings}
                    />
                </div>

                <div className="flex items-center gap-4">
                    {/* Panic Button (Global Mute) */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={handleToggleMute}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all font-bold text-sm shadow-sm ${isGlobalMuted
                                    ? 'bg-destructive text-destructive-foreground border-destructive animate-pulse ring-2 ring-destructive/50'
                                    : 'bg-background hover:bg-destructive/10 text-destructive border-destructive/30 hover:border-destructive hover:shadow-destructive/20'
                                    }`}
                            >
                                {isGlobalMuted ? (
                                    <>
                                        <MdMicOff className="w-5 h-5" />
                                        <span className="hidden lg:inline-block">緊急停止中</span>
                                    </>
                                ) : (
                                    <>
                                        <MdEmergency className="w-5 h-5" />
                                        <span className="hidden lg:inline-block">緊急ミュート</span>
                                    </>
                                )}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{isGlobalMuted ? "ミュート解除 (音声を再開)" : "音声を即ミュート（事故防止）"}</p>
                        </TooltipContent>
                    </Tooltip>

                    <div className="h-8 w-px bg-border/50 mx-2" />

                    {/* Visualizers (IN / OUT) */}
                    <div className="flex items-center gap-3">
                        <LevelMeter width={12} height={32} type="input" />
                        <LevelMeter width={12} height={32} type="output" />
                    </div>

                    {/* Large Meter Toggle */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={onToggleLargeMeter}
                                className={`p-2 rounded-lg transition-all border ${isLargeMeterOpen
                                    ? 'bg-primary/10 text-primary border-primary/50'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-muted border-transparent'
                                    }`}
                            >
                                <MdGraphicEq className="w-5 h-5" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>大型レベルメーター</p>
                        </TooltipContent>
                    </Tooltip>

                    {/* Theme Toggle Dropdown */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className={`p-2 transition-colors rounded-lg flex items-center gap-2 ${theme === 'gaming' ? 'text-primary hover:text-primary hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                                aria-label="Theme Settings"
                            >
                                {theme === 'light' && <MdWbSunny className="w-5 h-5" />}
                                {theme === 'dark' && <MdDarkMode className="w-5 h-5" />}
                                {theme === 'gaming' && <MdGamepad className="w-5 h-5" />}
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>テーマ設定</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as any)}>
                                <DropdownMenuRadioItem value="light" className="gap-2">
                                    <MdWbSunny className="w-4 h-4" /> ライト (Light)
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="dark" className="gap-2">
                                    <MdDarkMode className="w-4 h-4" /> ダーク (Dark)
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="gaming" className="gap-2">
                                    <MdGamepad className="w-4 h-4 text-cyan-400" /> ゲーミング (Gaming)
                                </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Audio Settings */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={onOpenSettings}
                                className="p-2 px-3 text-muted-foreground hover:text-foreground transition-colors hover:bg-muted rounded-lg flex items-center gap-2"
                            >
                                <MdSettings className="w-5 h-5" />
                                <span className="text-xs font-bold hidden lg:inline-block">設定</span>
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>オーディオ設定</p>
                        </TooltipContent>
                    </Tooltip>

                    {/* Help & Guide Dropdown */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="p-2 px-3 text-muted-foreground hover:text-foreground transition-colors hover:bg-muted rounded-lg flex items-center gap-2"
                            >
                                <MdHelpOutline className="w-5 h-5" />
                                <span className="text-xs font-bold hidden lg:inline-block">ヘルプ</span>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[200px]">
                            <DropdownMenuLabel>ガイド & ヘルプ</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onOpenOBSGuide} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-black text-white rounded-full text-[10px] font-bold shadow-sm">OBS</span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">OBS連携ガイド</span>
                                    <span className="text-[10px] text-muted-foreground">配信ソフトへの音声送出</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={onOpenDiscordGuide} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-[#5865F2] text-white rounded-full shadow-sm"><DiscordIcon className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">Discord連携ガイド</span>
                                    <span className="text-[10px] text-muted-foreground">通話/ボイスチャット設定</span>
                                </div>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </TooltipProvider>
        </header>
    );
};

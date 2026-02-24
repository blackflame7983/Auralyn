import React, { useState, useEffect, useRef } from 'react';
import { LevelMeter } from '../features/LevelMeter/LevelMeter';
import { DeviceStatus } from '../features/DeviceStatus/DeviceStatus';
import { Slider } from '@/components/ui/slider';
import { useTheme } from '../../hooks/useTheme';
import { DiscordIcon } from '../ui/DiscordIcon';
import {
    MdSettings,
    MdHelpOutline,
    MdWbSunny,
    MdDarkMode,
    MdMicOff,
    MdGraphicEq,
    MdEmergency,
    MdGamepad,
    MdFavorite,
    MdMic,
    MdSystemUpdateAlt,
    MdAutoFixHigh,
    MdCompareArrows
} from 'react-icons/md';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../api/audio';
import { toast } from 'sonner';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
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
    onOpenTroubleshoot: () => void;
    onOpenWizard: () => void;
    onToggleGlobalBypass: () => void;
    isGlobalBypassed: boolean;
    onToggleLargeMeter: () => void;
    isLargeMeterOpen: boolean;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
    isEngineRunning: boolean;
}

export const Header: React.FC<HeaderProps> = ({
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onOpenTroubleshoot,
    onOpenWizard,
    onToggleGlobalBypass,
    isGlobalBypassed,
    onToggleLargeMeter,
    isLargeMeterOpen,
    currentHost,
    currentSampleRate,
    currentBufferSize,
    isEngineRunning
}) => {
    const { theme, setTheme } = useTheme();
    const [isGlobalMuted, setIsGlobalMuted] = useState(false);
    const [inputGain, setInputGain] = useState(() => {
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) : 100;
    });
    const [isBeginnerMode, setIsBeginnerMode] = useState(() => {
        return localStorage.getItem('vst_host_beginner_mode') !== 'false';
    });
    const gainDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleInputGainChange = (value: number[], fromExternal = false) => {
        const gain = value[0];
        setInputGain(gain);
        if (gainDebounceRef.current) clearTimeout(gainDebounceRef.current);
        gainDebounceRef.current = setTimeout(() => {
            audioApi.setInputGain(gain / 100).catch(e => console.error("Failed to set input gain", e));
            localStorage.setItem('vst_host_input_gain', String(gain));
        }, 50);
        // Notify other components (avoid re-entrant loop when fromExternal)
        if (!fromExternal) {
            window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: gain }));
        }
    };

    // Sync input gain from other components (e.g. LargeLevelMeter)
    useEffect(() => {
        const handler = (e: Event) => {
            const pct = (e as CustomEvent<number>).detail;
            if (pct !== inputGain) {
                handleInputGainChange([pct], true);
            }
        };
        window.addEventListener('input-gain-sync', handler);
        return () => window.removeEventListener('input-gain-sync', handler);
    }, [inputGain]);

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

    useEffect(() => {
        localStorage.setItem('vst_host_beginner_mode', String(isBeginnerMode));
        window.dispatchEvent(new CustomEvent('vst_host_beginner_mode_changed', { detail: isBeginnerMode }));
    }, [isBeginnerMode]);

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
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Logo Section */}
                    <div className="flex items-center gap-2 select-none shrink-0">
                        <img src="/auralyn_icon.png?v=17" alt="Auralyn Logo" className="w-7 h-7 object-contain drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" />
                        <h1 className="hidden sm:block text-lg font-bold tracking-tight text-foreground">
                            Aura<span className="text-primary">lyn</span>
                        </h1>
                    </div>

                    {/* Device Status (Quick Access to Settings) */}
                    <DeviceStatus
                        host={currentHost}
                        sampleRate={currentSampleRate}
                        bufferSize={currentBufferSize}
                        isRunning={isEngineRunning}
                        onClick={onOpenSettings}
                    />
                </div>

                <div className="flex items-center gap-2 lg:gap-4 shrink-0 pl-2">
                    {/* Panic Button (Global Mute) */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={handleToggleMute}
                                aria-label={isGlobalMuted ? '緊急ミュートを解除' : '緊急ミュートを有効化'}
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

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={onToggleGlobalBypass}
                                aria-label={isGlobalBypassed ? '原音比較を終了してエフェクト処理を再開する' : '原音比較を開始する（エフェクトOFF）'}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all font-bold text-xs shadow-sm ${isGlobalBypassed
                                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 ring-1 ring-amber-500/30'
                                    : 'bg-background hover:bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:border-amber-500/60'
                                    }`}
                            >
                                <MdCompareArrows className="w-4 h-4" />
                                <span className="hidden lg:inline-block">
                                    {isGlobalBypassed ? '原音比較ON' : '原音比較'}
                                </span>
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{isGlobalBypassed ? 'Alt+P またはクリックで原音比較を終了（エフェクト再開）' : 'Alt+P またはクリックで原音比較を開始（エフェクトOFF）'}</p>
                        </TooltipContent>
                    </Tooltip>

                    {isBeginnerMode && (
                        <button
                            onClick={onOpenWizard}
                            aria-label="かんたん設定を開く"
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-xs font-bold"
                        >
                            <MdAutoFixHigh className="w-4 h-4" />
                            <span className="hidden lg:inline">かんたん設定</span>
                        </button>
                    )}

                    {!isBeginnerMode && (
                        <>
                            <div className="h-8 w-px bg-border/50 mx-2" />

                            {/* Input Gain + Visualizers */}
                            <div className="flex items-center gap-3">
                                {/* Compact Input Gain */}
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div className="flex items-center gap-1.5 group">
                                            <MdMic className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                                            <div className="w-16 flex items-center" onPointerDown={e => e.stopPropagation()}>
                                                <Slider
                                                    value={[inputGain]}
                                                    max={200}
                                                    step={1}
                                                    onValueChange={handleInputGainChange}
                                                    onDoubleClick={() => handleInputGainChange([100])}
                                                    className="cursor-pointer"
                                                />
                                            </div>
                                            <span className="text-[10px] font-mono text-muted-foreground w-8 text-right tabular-nums">{inputGain}%</span>
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p>マイク入力ゲイン（ダブルクリックで100%にリセット）</p>
                                    </TooltipContent>
                                </Tooltip>

                                <div className="h-6 w-px bg-border/30" />
                                <LevelMeter width={12} height={32} type="input" />
                                <LevelMeter width={12} height={32} type="output" />
                            </div>

                            {/* Large Meter Toggle */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        onClick={onToggleLargeMeter}
                                        aria-label={isLargeMeterOpen ? '大型レベルメーターを閉じる' : '大型レベルメーターを開く'}
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
                                        aria-label="テーマ設定を開く"
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
                                            <MdWbSunny className="w-4 h-4" /> ライト
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="dark" className="gap-2">
                                            <MdDarkMode className="w-4 h-4" /> ダーク
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="gaming" className="gap-2">
                                            <MdGamepad className="w-4 h-4 text-cyan-400" /> ゲーミング
                                        </DropdownMenuRadioItem>
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </>
                    )}

                    {/* Audio Settings */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={onOpenSettings}
                                aria-label="オーディオ設定を開く"
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
                                aria-label="ヘルプメニューを開く"
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
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onOpenTroubleshoot} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-amber-500 text-white rounded-full shadow-sm text-[10px] font-bold">?</span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">音が出ない？</span>
                                    <span className="text-[10px] text-muted-foreground">自動診断で問題を特定</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={async () => {
                                const toastId = toast.loading('アップデートを確認中...');
                                try {
                                    const update = await check();
                                    if (update) {
                                        toast.dismiss(toastId);
                                        toast.info(`v${update.version} が利用可能です`, {
                                            description: '今すぐアップデートしますか？',
                                            duration: 15000,
                                            action: {
                                                label: 'アップデート',
                                                onClick: async () => {
                                                    const dlToast = toast.loading('ダウンロード中...');
                                                    try {
                                                        await update.downloadAndInstall();
                                                        toast.dismiss(dlToast);
                                                        toast.success('インストール完了。再起動します...');
                                                        await relaunch();
                                                    } catch (e) {
                                                        toast.dismiss(dlToast);
                                                        console.error('Update install failed:', e);
                                                        toast.error('アップデートに失敗しました');
                                                    }
                                                },
                                            },
                                        });
                                    } else {
                                        toast.dismiss(toastId);
                                        toast.success('最新バージョンです');
                                    }
                                } catch (e) {
                                    toast.dismiss(toastId);
                                    // Updater not configured yet (empty pubkey) - graceful fallback
                                    toast.info('自動更新は今後のリリースで有効になります', {
                                        description: 'GitHubから最新版をダウンロードできます。',
                                        action: {
                                            label: 'GitHub',
                                            onClick: () => window.open('https://github.com/blackflame7983/Auralyn/releases', '_blank'),
                                        },
                                    });
                                }
                            }} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-blue-500 text-white rounded-full shadow-sm"><MdSystemUpdateAlt className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">アップデートを確認</span>
                                    <span className="text-[10px] text-muted-foreground">最新版があるかチェック</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => window.open('https://ofuse.me/o?uid=149216', '_blank')} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-pink-500 text-white rounded-full shadow-sm"><MdFavorite className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">開発を支援する (OFUSE)</span>
                                    <span className="text-[10px] text-muted-foreground">寄付・ファンレター</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onSelect={() => setIsBeginnerMode(prev => !prev)}
                                className="gap-3 cursor-pointer p-3"
                            >
                                <span className="w-6 h-6 flex items-center justify-center bg-primary/15 text-primary rounded-full shadow-sm">
                                    <MdAutoFixHigh className="w-3.5 h-3.5" />
                                </span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">
                                        {isBeginnerMode ? '詳細表示に切替' : 'かんたん表示に切替'}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                        {isBeginnerMode ? '詳細調整項目を表示します' : '主要操作だけに絞って表示します'}
                                    </span>
                                </div>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </TooltipProvider>
        </header>
    );
};

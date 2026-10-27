import * as Popover from '@radix-ui/react-popover';
import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { useBeginnerMode } from '../../hooks/useBeginnerMode';
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
    MdGamepad,
    MdFavorite,
    MdMic,
    MdSystemUpdateAlt,
    MdAutoFixHigh
} from 'react-icons/md';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type EngineRuntimeStats } from '../../api/audio';
import { toast } from 'sonner';
import { useAppUpdate, UpdateGuide } from './AppUpdate';
import { AvailableUpdateDialog } from './AvailableUpdateDialog';
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
    onToggleLargeMeter: () => void;
    isLargeMeterOpen: boolean;
    stats?: EngineRuntimeStats | null;
    currentHost: string;
    currentSampleRate?: number;
    currentBufferSize?: number;
    isEngineRunning: boolean;
    engineProcessReady?: boolean | null;
}

export const Header: React.FC<HeaderProps> = ({
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onOpenTroubleshoot,
    onOpenWizard,
    onToggleLargeMeter,
    isLargeMeterOpen,
    stats,
    currentHost,
    currentSampleRate,
    currentBufferSize,
    isEngineRunning,
    engineProcessReady
}) => {
    const t = useMessages();
    const { theme, setTheme } = useTheme();
    const appUpdate = useAppUpdate();
    const [isGlobalMuted, setIsGlobalMuted] = useState(false);
    const [inputGain, setInputGain] = useState(() => {
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) : 100;
    });
    const [isBeginnerMode, setIsBeginnerMode] = useBeginnerMode();
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
                toast.warning(<LocalizedMessage id="header.muteOn" />);
            } else {
                toast.success(<LocalizedMessage id="header.muteOff" />);
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
        <header className={`h-16 shrink-0 overflow-x-auto flex items-center justify-between px-4 xl:px-6 border-b sticky top-0 z-50 transition-colors duration-300 backdrop-blur-md ${theme === 'light'
            ? 'bg-card/95 border-border/20 shadow-sm'
            : 'bg-background/80 border-border/40'
            }`}>
            <TooltipProvider>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Logo Section */}
                    <div className="flex items-center gap-2 select-none shrink-0">
                        <img src="/auralyn_icon.png?v=17" alt="Auralyn Logo" className="w-7 h-7 object-contain drop-shadow-[0_0_8px_hsl(var(--brand)/0.5)]" />
                        <h1 aria-label="Auralyn" className="hidden lg:block text-lg font-bold tracking-tight text-foreground">
                            Aura<span className="text-brand">lyn</span>
                        </h1>
                    </div>

                    {/* 音声状態は表示専用。設定は共通ボタンから開く。 */}
                    <DeviceStatus
                        stats={stats}
                        host={currentHost}
                        sampleRate={currentSampleRate}
                        bufferSize={currentBufferSize}
                        isRunning={isEngineRunning}
                        processReady={engineProcessReady}
                    />
                </div>

                <div className="flex items-center gap-2 xl:gap-4 shrink-0 pl-2">
                    {/* Panic Button (Global Mute) */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                aria-pressed={isGlobalMuted}
                                onClick={handleToggleMute}
                                aria-label={t('header.emergency')}
                                aria-describedby={isGlobalMuted ? 'header-mute-state' : undefined}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all font-bold text-sm shadow-sm text-foreground ${isGlobalMuted
                                    ? 'bg-destructive/10 border-destructive ring-2 ring-destructive/50'
                                    : 'bg-background hover:bg-destructive/10 border-destructive/30 hover:border-destructive hover:shadow-destructive/20'
                                    }`}
                            >
                                <MdMicOff aria-hidden="true" className="w-5 h-5 shrink-0" />
                                <span className="flex flex-col items-start whitespace-nowrap">
                                    <span>{t('header.emergency')}</span>
                                    {isGlobalMuted && <span id="header-mute-state" className="text-xs font-medium">{t('header.muted')}</span>}
                                </span>
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{isGlobalMuted ? t('header.unmuteHint') : t('header.muteHint')}</p>
                        </TooltipContent>
                    </Tooltip>

                    <button
                        onClick={onOpenWizard}
                        aria-label={t('header.setupOpen')}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-input bg-background text-foreground hover:bg-muted transition-colors text-xs font-bold"
                    >
                        <MdAutoFixHigh className="w-4 h-4" />
                        <span>{t('header.setup')}</span>
                    </button>

                    <Popover.Root>
                        <Popover.Trigger asChild>
                            <button type="button" aria-label={t('header.inputGain')} className="flex items-center gap-1 rounded-md border border-border px-2 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                                <MdMic aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="hidden lg:inline whitespace-nowrap">{t('header.inputGain')}</span>
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal><Popover.Content aria-label={t('header.inputGain')} sideOffset={5} collisionPadding={12} className="z-[200] w-64 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-lg">
                            <div className="flex items-center justify-between gap-4 text-sm"><span>{t('header.inputGain')}</span><span>{inputGain}%</span></div>
                            <Slider aria-label={t('header.inputGain')} aria-valuetext={`${inputGain}%`} value={[inputGain]} max={200} step={1}
                                onValueChange={handleInputGainChange} onDoubleClick={() => handleInputGainChange([100])} className="mt-4" />
                            <p className="mt-2 text-xs text-muted-foreground">{t('header.inputGainHint')}</p>
                        </Popover.Content></Popover.Portal>
                    </Popover.Root>

                    {!isBeginnerMode && (
                        <>
                            <div className="h-8 w-px bg-border/50 mx-1" />

                            {/* Input Gain + Visualizers */}
                            <div className="hidden xl:flex items-center gap-3">
                                <div className="hidden xl:block h-6 w-px bg-border/30" />
                                <LevelMeter running={isEngineRunning} width={12} height={32} type="input" />
                                <LevelMeter running={isEngineRunning} width={12} height={32} type="output" />
                            </div>

                            {/* Large Meter Toggle */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        onClick={onToggleLargeMeter}
                                        aria-label={isLargeMeterOpen ? t('header.meterClose') : t('header.meterOpen')}
                                        className={`p-2 rounded-lg transition-all border ${isLargeMeterOpen
                                            ? 'bg-primary/10 text-primary border-primary/50'
                                            : 'text-muted-foreground hover:text-foreground hover:bg-muted border-transparent'
                                            }`}
                                    >
                                        <MdGraphicEq className="w-5 h-5" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{t('header.meter')}</p>
                                </TooltipContent>
                            </Tooltip>

                            {/* Theme Toggle Dropdown */}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        className={`hidden xl:flex p-2 transition-colors rounded-lg items-center gap-2 ${theme === 'gaming' ? 'text-primary hover:text-primary hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                                        aria-label={t('header.themeOpen')}
                                    >
                                        {theme === 'light' && <MdWbSunny className="w-5 h-5" />}
                                        {theme === 'dark' && <MdDarkMode className="w-5 h-5" />}
                                        {theme === 'gaming' && <MdGamepad className="w-5 h-5" />}
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuLabel>{t('header.theme')}</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as any)}>
                                        <DropdownMenuRadioItem value="light" className="gap-2">
                                            <MdWbSunny className="w-4 h-4" /> {t('header.light')}
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="dark" className="gap-2">
                                            <MdDarkMode className="w-4 h-4" /> {t('header.dark')}
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="gaming" className="gap-2">
                                            <MdGamepad className="w-4 h-4 text-brand" /> {t('header.gaming')}
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
                                aria-label={t('header.audioSettingsOpen')}
                                className="p-2 px-3 text-muted-foreground hover:text-foreground transition-colors hover:bg-muted rounded-lg flex items-center gap-2"
                            >
                                <MdSettings className="w-5 h-5" />
                                <span className="text-xs font-bold hidden lg:inline-block">{t('common.settings')}</span>
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{t('header.audioSettings')}</p>
                        </TooltipContent>
                    </Tooltip>

                    {/* Help & Guide Dropdown */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                aria-label={t('header.helpOpen')}
                                className="p-2 px-3 text-muted-foreground hover:text-foreground transition-colors hover:bg-muted rounded-lg flex items-center gap-2"
                            >
                                <MdHelpOutline className="w-5 h-5" />
                                <span className="text-xs font-bold hidden lg:inline-block">{t('header.help')}</span>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[200px]">
                            <DropdownMenuLabel>{t('header.guides')}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onOpenOBSGuide} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-overlay text-discord-foreground rounded-full text-xs font-bold shadow-sm">OBS</span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">{t('header.obs')}</span>
                                    <span className="text-xs text-muted-foreground">{t('header.obsHint')}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={onOpenDiscordGuide} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-discord text-discord-foreground rounded-full shadow-sm"><DiscordIcon className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">{t('header.discord')}</span>
                                    <span className="text-xs text-muted-foreground">{t('header.discordHint')}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onOpenTroubleshoot} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-muted text-foreground rounded-full shadow-sm text-xs font-bold">?</span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">{t('header.noSound')}</span>
                                    <span className="text-xs text-muted-foreground">{t('header.diagnostics')}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem disabled={appUpdate.busy} onSelect={() => void appUpdate.checkUpdates()} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-info text-info-foreground rounded-full shadow-sm"><MdSystemUpdateAlt className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">{appUpdate.label}</span>
                                    <span className="text-xs text-muted-foreground">{appUpdate.description}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => window.open('https://ofuse.me/o?uid=149216', '_blank')} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-brand-secondary text-background rounded-full shadow-sm"><MdFavorite className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">{t('header.support')}</span>
                                    <span className="text-xs text-muted-foreground">{t('header.supportHint')}</span>
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
                                        {isBeginnerMode ? t('header.advanced') : t('header.simple')}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {isBeginnerMode ? t('header.advancedHint') : t('header.simpleHint')}
                                    </span>
                                </div>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </TooltipProvider>
            {appUpdate.showGuide && <UpdateGuide onClose={appUpdate.closeGuide} />}
            {appUpdate.showAvailable && appUpdate.available && <AvailableUpdateDialog update={appUpdate.available} busy={appUpdate.busy} downloaded={appUpdate.downloaded} onClose={appUpdate.closeAvailable} onDownload={appUpdate.download} onInstall={appUpdate.install} />}
        </header>
    );
};

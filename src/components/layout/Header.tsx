import { useMessages, LocalizedMessage } from '@/i18n/LocaleProvider';
import { useBeginnerMode } from '../../hooks/useBeginnerMode';
import React, { useState, useEffect } from 'react';
import { DeviceStatus } from '../features/DeviceStatus/DeviceStatus';
import { useTheme } from '../../hooks/useTheme';
import { DiscordIcon } from '../ui/DiscordIcon';
import {
    MdSettings,
    MdHelpOutline,
    MdMicOff,
    MdGraphicEq,
    MdFavorite,
    MdSystemUpdateAlt,
    MdAutoFixHigh,
    MdSpaceDashboard
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
    DropdownMenuTrigger
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
    const { theme } = useTheme();
    const appUpdate = useAppUpdate();
    const [isGlobalMuted, setIsGlobalMuted] = useState(false);
    const [isBeginnerMode, setIsBeginnerMode] = useBeginnerMode();

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
                        showDetails={!isBeginnerMode}
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
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border font-bold text-sm shadow-sm text-foreground ${isGlobalMuted
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

                    {/* セットアップは初回や機器を替えたときにだけ使うので、アイコンにして説明はツールチップに置く。 */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={onOpenWizard}
                                aria-label={t('header.setupOpen')}
                                className="p-2 rounded-lg border border-input bg-background text-foreground hover:bg-muted transition-colors"
                            >
                                <MdAutoFixHigh aria-hidden="true" className="w-5 h-5" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p className="font-bold">{t('header.setup')}</p>
                            <p>{t('header.setupHint')}</p>
                        </TooltipContent>
                    </Tooltip>


                    {!isBeginnerMode && (
                        <>

                            {/* Large Meter Toggle */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        onClick={onToggleLargeMeter}
                                        aria-label={isLargeMeterOpen ? t('header.meterClose') : t('header.meterOpen')}
                                        className={`p-2 rounded-lg transition-colors border ${isLargeMeterOpen
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

                        </>
                    )}

                    {/* かんたん／詳細は頻繁に切り替えないので、本文に常設せずアイコン1つにする。
                        ヘルプメニューの近道と同じ名前・アイコンにし（DESIGN.md 2.2）、詳細表示中は主色で示す。
                        セットアップの杖アイコンとは見分けられるよう、表示の切替には別のアイコンを使う。 */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={() => setIsBeginnerMode(prev => !prev)}
                                aria-label={isBeginnerMode ? t('header.advanced') : t('header.simple')}
                                data-detailed={!isBeginnerMode}
                                className="p-2 rounded-lg border transition-colors text-muted-foreground border-transparent hover:text-foreground hover:bg-muted data-[detailed=true]:bg-primary/10 data-[detailed=true]:text-primary data-[detailed=true]:border-primary/50"
                            >
                                <MdSpaceDashboard aria-hidden="true" className="w-5 h-5" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p className="font-bold">{isBeginnerMode ? t('header.advanced') : t('header.simple')}</p>
                            <p>{isBeginnerMode ? t('header.advancedHint') : t('header.simpleHint')}</p>
                        </TooltipContent>
                    </Tooltip>

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
                                    <MdSpaceDashboard className="w-3.5 h-3.5" />
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

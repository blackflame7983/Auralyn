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
    MdFavorite,
    MdSystemUpdateAlt,
    MdCable
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
    const [isBeginnerMode] = useBeginnerMode();

    useEffect(() => {
        const unlisten = listen<boolean>('global-mute-changed', (event) => {
            setIsGlobalMuted(event.payload);
            toast.dismiss('emergency-mute-failed');
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
            toast.error(t('header.muteFailed'), { id: 'emergency-mute-failed', duration: Infinity,
                action: { label: t('header.audioSettingsOpen'), onClick: onOpenSettings } });
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
                    {(!isEngineRunning || engineProcessReady === false || engineProcessReady === null) && <DeviceStatus
                        stats={stats}
                        host={currentHost}
                        sampleRate={currentSampleRate}
                        bufferSize={currentBufferSize}
                        isRunning={isEngineRunning}
                        processReady={engineProcessReady}
                        showDetails={!isBeginnerMode}
                    />}
                </div>

                <div className="flex items-center gap-2 xl:gap-4 shrink-0 pl-2">
                    {/* Panic Button (Global Mute) */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                id="emergency-mute" aria-pressed={isGlobalMuted}
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
                                className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            >
                                <MdCable aria-hidden="true" className="w-5 h-5" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p className="font-bold">{t('header.setup')}</p>
                            <p>{t('header.setupHint')}</p>
                        </TooltipContent>
                    </Tooltip>


                    {/* 大型メーターは本番帯のメーター横へ移した。表示モード（かんたん／詳細）はなくし、VST 構成は右パネル、細かい数値は設定の外観で切り替える。 */}

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
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </TooltipProvider>
            {appUpdate.showGuide && <UpdateGuide onClose={appUpdate.closeGuide} />}
            {appUpdate.showAvailable && appUpdate.available && <AvailableUpdateDialog update={appUpdate.available} busy={appUpdate.busy} downloaded={appUpdate.downloaded} onClose={appUpdate.closeAvailable} onDownload={appUpdate.download} onInstall={appUpdate.install} />}
        </header>
    );
};

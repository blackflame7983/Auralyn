import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
import { useBeginnerMode } from '../../hooks/useBeginnerMode';
import { HowToUseModal } from '../features/Guide/HowToUseModal';
import React, { useState, useEffect, useRef } from 'react';
import { DeviceStatus } from '../features/DeviceStatus/DeviceStatus';
import { useTheme } from '../../hooks/useTheme';
import { DiscordIcon } from '../ui/DiscordIcon';
import {
    MdSettings,
    MdHelpOutline,
    MdFavorite,
    MdSystemUpdateAlt
} from 'react-icons/md';
import { type EngineRuntimeStats } from '../../api/audio';
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
    stoppedInStrip?: boolean;
    onOpenSettings: () => void;
    onOpenShortcuts?: () => void;
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
    onOpenShortcuts,
    onOpenWizard,
    onOpenOBSGuide,
    onOpenDiscordGuide,
    onOpenTroubleshoot,
    stats,
    stoppedInStrip = false,
    currentHost,
    currentSampleRate,
    currentBufferSize,
    isEngineRunning,
    engineProcessReady
}) => {
    const [helpOpen, setHelpOpen] = useState(false);
    // 開発プレビューの ?screen=help だけ、使い方を最初から開く。本番ビルドでは消える。
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        const params = new URLSearchParams(location.search);
        if (params.get('mock') !== null && params.get('screen') === 'help') setHelpOpen(true);
    }, []);
    const [helpMenuOpen, setHelpMenuOpen] = useState(false);
    const helpTrigger = useRef<HTMLButtonElement>(null);
    const menuHelp = useRef(false);
    useEffect(() => {
        const open = (event: KeyboardEvent) => {
            if (event.key !== 'F1' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.defaultPrevented) return;
            event.preventDefault();
            if (event.repeat) return;
            if (helpTrigger.current?.getAttribute('aria-expanded') === 'true') {
                menuHelp.current = true;
                setHelpMenuOpen(false);
            } else setHelpOpen(true);
        };
        window.addEventListener('keydown', open);
        return () => window.removeEventListener('keydown', open);
    }, []);
    const t = useMessages();
    const { theme } = useTheme();
    const appUpdate = useAppUpdate();
    const [isBeginnerMode] = useBeginnerMode();

    return (
        <header className={`h-16 shrink-0 overflow-x-auto flex items-center justify-between px-4 xl:px-6 border-b sticky top-0 z-50 transition-colors duration-(--motion-panel) gaming:backdrop-blur-md ${theme === 'light'
            ? 'bg-card border-border/20 shadow-sm'
            : 'bg-background gaming:bg-background/80 border-border/40'
            }`}>
            <TooltipProvider>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Logo Section */}
                    <div className="flex items-center gap-2 select-none shrink-0">
                        <img src="/auralyn_icon.png?v=17" alt="" className="w-7 h-7 object-contain gaming:drop-shadow-[0_0_8px_hsl(var(--brand)/0.5)]" />
                        <h1 aria-label="Auralyn" className="sr-only lg:not-sr-only text-[1.0625rem] font-medium leading-none tracking-tight text-foreground">
                            Aura<span className="text-brand">lyn</span>
                        </h1>
                    </div>

                    {/* 音声状態は表示専用。設定は共通ボタンから開く。 */}
                    {(!stoppedInStrip && (!isEngineRunning || engineProcessReady === false || engineProcessReady === null)) && <DeviceStatus
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
                    {/* 緊急ミュートは右の列へ移した。大型メーターは本番帯のメーター横。VST 構成は右パネル、細かい数値は設定の外観で切り替える。 */}

                    {/* Audio Settings */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm"
                                onClick={onOpenSettings}
                                aria-label={t('header.audioSettingsOpen')}
                                className="gap-2"
                            >
                                <MdSettings className="w-5 h-5" />
                                <span className="text-ui-support font-bold hidden lg:inline-block">{t('common.settings')}</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{t('header.audioSettings')}</p>
                        </TooltipContent>
                    </Tooltip>

                    {/* Help & Guide Dropdown */}
                    <DropdownMenu open={helpMenuOpen} onOpenChange={setHelpMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm"
                                ref={helpTrigger}
                                aria-label={t('header.helpOpen')}
                                className="gap-2"
                            >
                                <MdHelpOutline className="w-5 h-5" />
                                <span className="text-ui-support font-bold hidden lg:inline-block">{t('header.help')}</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[200px]" onCloseAutoFocus={event => {
                            if (menuHelp.current) {
                                event.preventDefault();
                                menuHelp.current = false;
                                helpTrigger.current?.focus();
                                setHelpOpen(true);
                            }
                        }}>
                            <DropdownMenuItem onSelect={() => {
                                menuHelp.current = true;
                            }} className="gap-3 cursor-pointer p-3">
                                <MdHelpOutline aria-hidden="true" className="h-4 w-4 shrink-0" />
                                <div className="flex flex-col"><span className="font-bold text-ui-support">{t('help.title')}</span>
                                    <span className="text-ui-support text-muted-foreground">{t('help.hint')}</span></div>
                            </DropdownMenuItem>
                            <DropdownMenuLabel>{t('header.guides')}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onOpenOBSGuide} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-overlay text-discord-foreground rounded-full text-ui-support font-bold shadow-sm">OBS</span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-ui-support">{t('header.obs')}</span>
                                    <span className="text-ui-support text-muted-foreground">{t('header.obsHint')}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={onOpenDiscordGuide} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-discord text-discord-foreground rounded-full shadow-sm"><DiscordIcon className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-ui-support">{t('header.discord')}</span>
                                    <span className="text-ui-support text-muted-foreground">{t('header.discordHint')}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onOpenTroubleshoot} className="gap-3 cursor-pointer p-3">
                                <MdHelpOutline aria-hidden="true" className="h-4 w-4 shrink-0" />
                                <div className="flex flex-col">
                                    <span className="font-bold text-ui-support">{t('header.noSound')}</span>
                                    <span className="text-ui-support text-muted-foreground">{t('header.diagnostics')}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem disabled={appUpdate.busy} onSelect={() => void appUpdate.checkUpdates()} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-info text-info-foreground rounded-full shadow-sm"><MdSystemUpdateAlt className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-ui-support">{appUpdate.label}</span>
                                    <span className="text-ui-support text-muted-foreground">{appUpdate.description}</span>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => window.open('https://ofuse.me/o?uid=149216', '_blank')} className="gap-3 cursor-pointer p-3">
                                <span className="w-6 h-6 flex items-center justify-center bg-brand-secondary text-background rounded-full shadow-sm"><MdFavorite className="w-3.5 h-3.5" /></span>
                                <div className="flex flex-col">
                                    <span className="font-bold text-ui-support">{t('header.support')}</span>
                                    <span className="text-ui-support text-muted-foreground">{t('header.supportHint')}</span>
                                </div>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </TooltipProvider>
            {helpOpen && <HowToUseModal onClose={() => setHelpOpen(false)}
                onSetup={onOpenWizard} onTroubleshoot={onOpenTroubleshoot}
                onOBS={onOpenOBSGuide} onDiscord={onOpenDiscordGuide} onShortcuts={onOpenShortcuts ?? onOpenSettings} />}
            {appUpdate.showGuide && <UpdateGuide onClose={appUpdate.closeGuide} />}
            {appUpdate.showAvailable && appUpdate.available && <AvailableUpdateDialog update={appUpdate.available} busy={appUpdate.busy} downloaded={appUpdate.downloaded} onClose={appUpdate.closeAvailable} onDownload={appUpdate.download} onInstall={appUpdate.install} />}
        </header>
    );
};

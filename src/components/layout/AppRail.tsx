import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
import { HowToUseModal } from '../features/Guide/HowToUseModal';
import { useEffect, useRef, useState } from 'react';
import { DiscordIcon } from '../ui/DiscordIcon';
import {
    MdCable,
    MdExtension,
    MdFavorite,
    MdGraphicEq,
    MdHelpOutline,
    MdHome,
    MdSettings,
    MdSystemUpdateAlt,
} from 'react-icons/md';
import type { IconType } from 'react-icons';
import { useAppUpdate, UpdateGuide } from './AppUpdate';
import { AvailableUpdateDialog } from './AvailableUpdateDialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { usePageLock } from './pageLeave';
import type { MessageKey } from '@/i18n/messages';

export type RailDestination = 'home' | 'sound' | 'vst' | 'connect' | 'settings';

interface AppRailProps {
    current: RailDestination;
    onHome: () => void;
    onSound: () => void;
    onVst: () => void;
    onConnect: () => void;
    onSettings: () => void;
    onOpenShortcuts?: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide: () => void;
    onOpenTroubleshoot: () => void;
    onOpenWizard: () => void;
}

const destinations: { id: RailDestination; icon: IconType; label: MessageKey; name?: MessageKey }[] = [
    { id: 'home', icon: MdHome, label: 'rail.home' },
    { id: 'sound', icon: MdGraphicEq, label: 'rail.sound' },
    { id: 'vst', icon: MdExtension, label: 'rail.vst' },
    { id: 'connect', icon: MdCable, label: 'rail.connect', name: 'rail.connectName' },
    { id: 'settings', icon: MdSettings, label: 'rail.settings' },
];

// 左のレール。窓の高さいっぱいで、縦にはスクロールしない。ヘルプは下端。
export function AppRail({
    current, onHome, onSound, onVst, onConnect, onSettings,
    onOpenShortcuts, onOpenOBSGuide, onOpenDiscordGuide, onOpenTroubleshoot, onOpenWizard,
}: AppRailProps) {
    const t = useMessages();
    const pageLocked = usePageLock();
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
    const appUpdate = useAppUpdate();
    const go: Record<RailDestination, () => void> = { home: onHome, sound: onSound, vst: onVst, connect: onConnect, settings: onSettings };

    return (
        <nav aria-label={t('rail.label')} className="flex h-full w-[76px] shrink-0 flex-col items-stretch overflow-hidden border-r border-border bg-card py-2">
            <div className="flex h-12 shrink-0 items-center justify-center">
                <img src="/auralyn_icon.png?v=17" alt="" className="h-7 w-7 object-contain" />
                <h1 className="sr-only">Auralyn</h1>
            </div>
            <TooltipProvider>
                <div className="flex min-h-0 flex-1 flex-col">
                    {destinations.map(item => {
                        const active = item.id === current;
                        const name = pageLocked ? t('settings.leave.blocked') : t(item.name ?? item.label);
                        const button = (
                            <Button key={item.id} type="button" variant="ghost" size="sm"
                                aria-current={active ? 'page' : undefined}
                                aria-disabled={pageLocked || undefined}
                                aria-label={item.name && !pageLocked ? name : undefined}
                                title={name}
                                onClick={() => { if (!pageLocked) go[item.id](); }}
                                className={cn(
                                    'h-14 w-full shrink-0 flex-col gap-0.5 rounded-control border-l-[3px] px-1 font-normal text-ui-support',
                                    active ? 'border-l-brand bg-segment-accent/10 font-bold text-foreground' : 'border-l-transparent text-muted-foreground',
                                )}>
                                <item.icon aria-hidden="true" className="h-6 w-6" />
                                <span>{t(item.label)}</span>
                            </Button>
                        );
                        return item.name
                            ? <Tooltip key={item.id}><TooltipTrigger asChild>{button}</TooltipTrigger><TooltipContent side="right"><p>{name}</p></TooltipContent></Tooltip>
                            : button;
                    })}
                    <DropdownMenu open={helpMenuOpen} onOpenChange={setHelpMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" ref={helpTrigger}
                                aria-label={t('header.helpOpen')}
                                className="mt-auto h-14 w-full shrink-0 flex-col gap-0.5 px-1 font-normal text-ui-support text-muted-foreground">
                                <MdHelpOutline aria-hidden="true" className="h-6 w-6" />
                                <span>{t('header.help')}</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="end" className="min-w-[200px]" onCloseAutoFocus={event => {
                            if (menuHelp.current) {
                                event.preventDefault();
                                menuHelp.current = false;
                                helpTrigger.current?.focus();
                                setHelpOpen(true);
                            }
                        }}>
                            <DropdownMenuItem onSelect={() => { menuHelp.current = true; }} className="gap-3 cursor-pointer p-3">
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
                onOBS={onOpenOBSGuide} onDiscord={onOpenDiscordGuide} onShortcuts={onOpenShortcuts ?? onSettings} />}
            {appUpdate.showGuide && <UpdateGuide onClose={appUpdate.closeGuide} />}
            {appUpdate.showAvailable && appUpdate.available && <AvailableUpdateDialog update={appUpdate.available} busy={appUpdate.busy} downloaded={appUpdate.downloaded} onClose={appUpdate.closeAvailable} onDownload={appUpdate.download} onInstall={appUpdate.install} />}
        </nav>
    );
}

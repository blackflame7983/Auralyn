import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { audioApi } from '@/api/audio';
import { quitApp } from '@/api/quit';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useMessages } from '@/i18n/LocaleProvider';
import { renderClientError } from '@/lib/clientError';

export type StatusSessionKind = 'running' | 'stopped' | 'unknown' | 'unconfigured';

export function statusSessionKind(processReady: boolean | null | undefined, isRunning: boolean, host: string): StatusSessionKind {
    if (processReady === null) return 'unknown';
    if (processReady !== false && isRunning) return 'running';
    return host ? 'stopped' : 'unconfigured';
}

const dangerItemClass = 'flex-col items-start gap-1 whitespace-normal border border-destructive-text py-2 text-left focus:text-destructive-text data-[highlighted]:text-destructive-text';

function DangerItem({ action, title, detail, onSelect }: { action: string; title: string; detail: string; onSelect: () => void }) {
    return (
        <DropdownMenuItem data-status-action={action} className={dangerItemClass} onSelect={onSelect}>
            <span className="font-medium text-destructive-text">{title}</span>
            <span className="text-ui-support font-normal text-muted-foreground">{detail}</span>
        </DropdownMenuItem>
    );
}

export function StatusMenu({
    kind, label, canStart, starting = false, onStart, children,
}: {
    kind: StatusSessionKind;
    label?: string;
    canStart: boolean;
    starting?: boolean;
    onStart: () => void;
    children: ReactNode;
}) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const showStop = kind === 'running';
    const showStart = kind === 'stopped' && canStart;
    const stop = async () => {
        try { await audioApi.stop(); }
        catch (error) {
            toast.error(t('band.stopFailed'), { id: 'band-stop-failed', description: renderClientError(t, error) });
        }
    };
    const quit = async () => {
        try { await quitApp(); }
        catch (error) {
            toast.error(t('band.quitFailed'), { id: 'band-quit-failed', description: renderClientError(t, error) });
        }
    };
    const startLabel = music
        ? (starting ? 'home.startingListening' : 'home.startListening')
        : (starting ? 'home.starting' : 'home.startAudio');
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" aria-label={label} data-status-menu={kind} className="h-8 shrink-0 justify-start gap-2 px-1 text-left">
                    {children}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-96">
                {showStop && <DangerItem action="stop" title={t('band.stopAudio')} detail={t(music ? 'band.stopAudioMusic' : 'band.stopAudioHelp')} onSelect={() => { void stop(); }} />}
                {showStart && <DropdownMenuItem data-status-action="start" disabled={starting} onSelect={() => { onStart(); }}>{t(startLabel)}</DropdownMenuItem>}
                {(showStop || showStart) && <DropdownMenuSeparator />}
                <DangerItem action="quit" title={t('band.quit')} detail={t('band.quitHelp')} onSelect={() => { void quit(); }} />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

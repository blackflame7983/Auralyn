import { useEffect, useState } from 'react';
import { MdMicOff } from 'react-icons/md';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '@/api/audio';
import { LocalizedMessage, useMessages } from '@/i18n/LocaleProvider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface EmergencyMuteButtonProps {
    onOpenSettings: () => void;
}

/** 緊急ミュート。名前は固定し、状態は aria-pressed と別の文言で示す。 */
export function EmergencyMuteButton({ onOpenSettings }: EmergencyMuteButtonProps) {
    const t = useMessages();
    const [isGlobalMuted, setIsGlobalMuted] = useState(false);

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
        return () => { void unlisten.then(stop => stop()); };
    }, []);

    const handleToggleMute = async () => {
        try {
            await audioApi.toggleGlobalMute();
        } catch (e) {
            console.error('Failed to toggle global mute', e);
            toast.error(t('header.muteFailed'), { id: 'emergency-mute-failed', duration: Infinity,
                action: { label: t('header.audioSettingsOpen'), onClick: onOpenSettings } });
        }
    };

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        id="emergency-mute" aria-pressed={isGlobalMuted}
                        onClick={handleToggleMute}
                        aria-label={t('header.emergency')}
                        aria-describedby={isGlobalMuted ? 'header-mute-state' : undefined}
                        className={`press-feedback flex w-full max-w-full shrink-0 items-center gap-2 px-3 py-1.5 rounded-full border font-medium text-ui-support shadow-sm text-foreground ${isGlobalMuted
                            ? 'bg-destructive/10 border-destructive-text ring-2 ring-destructive-text'
                            : 'bg-background hover:bg-destructive/10 border-destructive-text hover:border-destructive-text'
                            }`}
                    >
                        <MdMicOff aria-hidden="true" className="w-5 h-5 shrink-0" />
                        <span className="flex min-w-0 flex-col items-start">
                            <span>{t('header.emergency')}</span>
                            {isGlobalMuted && <span id="header-mute-state" className="text-ui-support font-medium">{t('header.muted')}</span>}
                        </span>
                    </button>
                </TooltipTrigger>
                <TooltipContent>
                    <p>{isGlobalMuted ? t('header.unmuteHint') : t('header.muteHint')}</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

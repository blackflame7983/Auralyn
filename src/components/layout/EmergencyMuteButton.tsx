import { MdMicOff, MdVolumeOff } from 'react-icons/md';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useEmergencyMute } from '@/hooks/useEmergencyMute';
import { useMessages } from '@/i18n/LocaleProvider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface EmergencyMuteButtonProps {
    onOpenSettings: () => void;
}

/** 緊急ミュート。名前は固定し、状態は aria-pressed と別の文言で示す。 */
export function EmergencyMuteButton({ onOpenSettings }: EmergencyMuteButtonProps) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const { isGlobalMuted, toggle } = useEmergencyMute(onOpenSettings);
    const MuteIcon = purpose === 'music' ? MdVolumeOff : MdMicOff;

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        id="emergency-mute" aria-pressed={isGlobalMuted}
                        onClick={toggle}
                        aria-label={t('header.emergency')}
                        aria-describedby={isGlobalMuted ? 'header-mute-state' : undefined}
                        className={`press-feedback flex w-full max-w-full shrink-0 items-center gap-2 px-3 py-1.5 rounded-full border font-medium text-ui-support shadow-sm text-foreground ${isGlobalMuted
                            ? 'bg-destructive/10 border-destructive-text ring-2 ring-destructive-text'
                            : 'bg-background hover:bg-destructive/10 border-destructive-text hover:border-destructive-text'
                            }`}
                    >
                        <MuteIcon aria-hidden="true" data-emergency-icon={purpose === 'music' ? 'speaker' : 'microphone'} className="w-5 h-5 shrink-0" />
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

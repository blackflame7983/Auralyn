import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '@/api/audio';
import { LocalizedMessage, useMessages } from '@/i18n/LocaleProvider';

export function useEmergencyMute(onOpenSettings: () => void) {
    const t = useMessages();
    const [isGlobalMuted, setIsGlobalMuted] = useState(false);
    useEffect(() => {
        const unlisten = listen<boolean>('global-mute-changed', (event) => {
            setIsGlobalMuted(event.payload);
            toast.dismiss('emergency-mute-failed');
            if (event.payload) toast.warning(<LocalizedMessage id="header.muteOn" />);
            else toast.success(<LocalizedMessage id="header.muteOff" />);
        });
        return () => { void unlisten.then(stop => stop()); };
    }, []);
    const toggle = () => {
        void audioApi.toggleGlobalMute().catch((error: unknown) => {
            console.error('Failed to toggle global mute', error);
            toast.error(t('header.muteFailed'), { id: 'emergency-mute-failed', duration: Infinity,
                action: { label: t('header.audioSettingsOpen'), onClick: onOpenSettings } });
        });
    };
    return { isGlobalMuted, toggle };
}

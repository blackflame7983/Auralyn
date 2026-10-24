import { useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';
import { desktopApi } from '../../../api/desktop';

// OSの許可状態を推測せず、利用者が設定を確認できる導線を用意する。
export function MicrophonePermissionGuide({ expanded = false }: { expanded?: boolean }) {
    const t = useMessages();
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState(false);
    const openSettings = async () => {
        setOpening(true);
        setError(false);
        try {
            await desktopApi.openSettings('microphonePrivacy');
        } catch {
            setError(true);
        } finally {
            setOpening(false);
        }
    };

    return (
        <details open={expanded || undefined} className="text-xs rounded-lg border border-border p-3 space-y-2">
            <summary className="cursor-pointer font-medium">{t('settings.MicrophonePermissionGuide.238')}</summary>
            <div className="space-y-2 pt-2 text-muted-foreground">
                <p>{t('settings.MicrophonePermissionGuide.239')}</p>
                <p>{t('settings.MicrophonePermissionGuide.240')}</p>
                <button disabled={opening} onClick={() => void openSettings()} className="px-3 py-2 rounded-md border border-input text-foreground hover:bg-muted">
                    {t('settings.MicrophonePermissionGuide.241')}</button>
                {error && <p role="alert">{t('settings.MicrophonePermissionGuide.242')}</p>}
                <p>{t('settings.MicrophonePermissionGuide.243')}</p>
            </div>
        </details>
    );
}

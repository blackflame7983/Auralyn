import { openUrl } from '@tauri-apps/plugin-opener';
import { MdOpenInNew } from 'react-icons/md';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { getUserDocUrl, type UserDocName } from '@/lib/userDocs';

export function UserDocLink({ name, compact = false }: { name: UserDocName; compact?: boolean }) {
    const { locale } = useLocale();
    const t = useMessages();
    return <button type="button" onClick={() => openUrl(getUserDocUrl(name, locale))}
        className="mt-2 inline-flex max-w-full items-center gap-1 rounded text-left text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {t(compact ? 'help.learnMore' : 'help.readMore')}
        <MdOpenInNew aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="sr-only">{t('help.external')}</span>
    </button>;
}

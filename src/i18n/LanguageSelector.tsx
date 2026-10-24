import { useEffect, useRef, useState } from 'react';
import { useLocale, useMessages } from './LocaleProvider';
import { projectLocale } from './nativeLocale';
import type { Locale } from './locale';

export function LanguageSelector() {
    const { locale, setLocale } = useLocale();
    const t = useMessages();
    const [error, setError] = useState<'storage' | 'native' | null>(null);
    const [syncing, setSyncing] = useState(false);
    const latest = useRef(0);
    useEffect(() => () => { latest.current += 1; }, []);
    return <div className="mb-3 space-y-1 text-sm" aria-busy={syncing}>
        <label className="flex items-center gap-3">{t('language.label')}
            <select className="rounded border border-border bg-background px-2 py-1" value={locale} onChange={event => {
                const next = event.target.value as Locale;
                const current = ++latest.current;
                const saved = setLocale(next);
                setError(saved ? null : 'storage');
                setSyncing(true);
                void projectLocale(next, saved).then(accepted => {
                    if (current !== latest.current) return;
                    if (saved && !accepted) setError('native');
                    setSyncing(false);
                });
            }}><option value="ja">日本語</option><option value="en">English</option></select>
        </label>
        {error && <p role="alert">{t(error === 'storage' ? 'language.saveFailed' : 'language.nativeFailed')}</p>}
        {locale === 'en' && <p className="text-xs text-muted-foreground">{t('language.partial')}</p>}
    </div>;
}

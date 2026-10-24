import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { LOCALE_KEY, localeStore, type Locale, type LocaleStore } from './locale';
import { message, type MessageKey } from './messages';

export const LocaleContext = createContext<{ locale: Locale; setLocale: LocaleStore['setLocale'] } | null>(null);

export function LocaleProvider({ children, store = localeStore }: { children: ReactNode; store?: LocaleStore }) {
    const locale = useSyncExternalStore(store.subscribe, store.getSnapshot, () => 'ja' as const);
    useLayoutEffect(() => { document.documentElement.lang = locale; }, [locale]);
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === LOCALE_KEY || event.key === null) store.refresh();
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [store]);
    const value = useMemo(() => ({ locale, setLocale: store.setLocale }), [locale, store]);
    return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
    const context = useContext(LocaleContext);
    // 単体画面も同じ既定storeで表示できる。製品入口はProviderで包む。
    const fallback = useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot, () => 'ja' as const);
    return context ?? { locale: fallback, setLocale: localeStore.setLocale };
}
// 操作callback/購読を再生成せず、表示・通知の解決時に最新localeを使う。
export function useMessages() {
    const { locale } = useLocale();
    const current = useRef(locale);
    current.current = locale;
    return useCallback((key: MessageKey, args?: Record<string, string | number>) => message(current.current, key, args), []);
}
export function LocalizedMessage({ id }: { id: MessageKey }) { const t = useMessages(); return <>{t(id)}</>; }

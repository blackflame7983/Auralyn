export type Locale = 'ja' | 'en';
export const LOCALE_KEY = 'vst_host_locale';

export function normalizeLocale(value: unknown): Locale {
    return value === 'en' ? 'en' : 'ja';
}

function readPreference(): unknown {
    try { return localStorage.getItem(LOCALE_KEY); }
    catch { return null; }
}

function writePreference(locale: Locale): boolean {
    try { localStorage.setItem(LOCALE_KEY, locale); return true; }
    catch { return false; }
}

// 音声・録音・下書きの寿命から独立した表示言語だけのstore。
export function createLocaleStore(read = readPreference, write = writePreference, initialize = true) {
    let current = initialize ? normalizeLocale(read()) : 'ja' as Locale;
    const listeners = new Set<() => void>();
    const update = (next: Locale) => {
        if (next === current) return;
        current = next;
        listeners.forEach(listener => listener());
    };
    return {
        getSnapshot: () => current,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        setLocale: (next: Locale): boolean => {
            if (next !== 'ja' && next !== 'en') return false;
            const persisted = write(next);
            update(next);
            return persisted;
        },
        // 起動時の設定移行後と、別windowのstorage通知で再読込する。
        refresh: () => { update(normalizeLocale(read())); },
    };
}

export type LocaleStore = ReturnType<typeof createLocaleStore>;
export const localeStore = createLocaleStore(readPreference, writePreference, false);
export function readLocalePreference(): { status: 'valid'; locale: Locale } | { status: 'missing' | 'invalid' | 'unavailable' } {
    try { const value = localStorage.getItem(LOCALE_KEY); return value === 'ja' || value === 'en' ? {status: 'valid', locale: value} : {status: value === null ? 'missing' : 'invalid'}; }
    catch { return {status: 'unavailable'}; }
}

export function initializeLocale(): Locale {
    localeStore.refresh();
    const locale = localeStore.getSnapshot();
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    return locale;
}

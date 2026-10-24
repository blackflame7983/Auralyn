import { invoke } from '@tauri-apps/api/core';
import { LOCALE_KEY, readLocalePreference, localeStore, type Locale } from './locale';

let session: Promise<number> | null = null;
let sequence = 0;
let initialized = false;
function getSession() {
    if (!session) session = invoke<number>('begin_display_locale_session').catch(error => { session = null; throw error; });
    return session;
}
export async function projectLocale(locale: Locale, persist: boolean): Promise<boolean> {
    const order = ++sequence;
    const preference = readLocalePreference();
    const clearProjection = !persist && locale === 'ja' && (preference.status === 'missing' || preference.status === 'invalid');
    try {
        const epoch = await getSession();
        return await invoke<boolean>('set_display_locale', { request: { epoch, sequence: order, locale, persist, clearProjection } });
    } catch { return false; }
}
// 設定移行後に一度だけ登録。音声・録音・presetの寿命とは独立する。
export function initializeLocaleBridge() {
    if (initialized) return () => {};
    initialized = true;
    const sync = () => { const locale = localeStore.getSnapshot(); const preference = readLocalePreference(); void projectLocale(locale, preference.status === 'valid' && preference.locale === locale); };
    sync();
    const unsubscribe = localeStore.subscribe(sync);
    // 同じ表示言語でも明示設定が削除された場合は、旧projectionだけを無効化する。
    const onStorage = (event: StorageEvent) => {
        if (event.key !== LOCALE_KEY && event.key !== null) return;
        const preference = readLocalePreference();
        void projectLocale(preference.status === 'valid' ? preference.locale : 'ja', preference.status === 'valid');
    };
    window.addEventListener('storage', onStorage);
    return () => { unsubscribe(); window.removeEventListener('storage', onStorage); initialized = false; };
}

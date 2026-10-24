import { renderClientError } from '@/lib/clientError';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { message, type MessageKey } from '@/i18n/messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { desktopApi, type Distribution } from '@/api/desktop';
import { flushSession } from '@/api/migration';

const KEY = 'vst_host_update_policy';
export interface UpdatePolicy { automatic: boolean; download: boolean }
export interface AvailableUpdate { version: string; body?: string | null; canInstall: boolean }
export function readUpdatePolicy(): UpdatePolicy {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        return { automatic: saved.automatic !== false, download: saved.download === true };
    } catch { return { automatic: true, download: false }; }
}
export function saveUpdatePolicy(policy: UpdatePolicy) {
    localStorage.setItem(KEY, JSON.stringify(policy));
    window.dispatchEvent(new Event('update-policy-changed'));
}
export function useUpdates() {
    const t = useMessages();
    const { locale } = useLocale();
    const localeRef = useRef(locale);
    localeRef.current = locale;
    const [distribution, setDistribution] = useState<Distribution>('unknown');
    const [policy, setPolicy] = useState(readUpdatePolicy);
    const [busy, setBusy] = useState(false);
    const [showGuide, setShowGuide] = useState(false);
    const [showAvailable, setShowAvailable] = useState(false);
    const [available, setAvailable] = useState<AvailableUpdate | null>(null);
    const [downloaded, setDownloaded] = useState(false);
    const busyRef = useRef(false);
    const downloadedRef = useRef(false);
    useEffect(() => {
        let active = true;
        desktopApi.getDistribution().then(value => { if (active) setDistribution(value); }).catch(() => {});
        const changed = () => setPolicy(readUpdatePolicy());
        window.addEventListener('update-policy-changed', changed);
        return () => { active = false; window.removeEventListener('update-policy-changed', changed); };
    }, []);

    const checkUpdates = useCallback(async (automatic = false) => {
        if (busyRef.current || (automatic && downloadedRef.current)) return;
        // Notifications use the locale at operation start, even if an await finishes after a switch.
        const startedLocale = localeRef.current;
        const notify = (key: MessageKey, args?: Record<string, string | number>) => message(startedLocale, key, args);
        busyRef.current = true; setBusy(true);
        try {
            let current: Distribution;
            try { current = await desktopApi.getDistribution(); }
            catch {
                if (!automatic) toast.error(notify('updates.methodFailed'), { description: notify('updates.retryAfterRestart') });
                return;
            }
            setDistribution(current);
            if (current === 'msix') { if (!automatic) setShowGuide(true); return; }
            if (current !== 'standalone') {
                if (!automatic) toast.error(notify('updates.methodFailed'), { description: notify('updates.retryAfterRestart') });
                return;
            }
            const update = await invoke<AvailableUpdate | null>('check_update');
            setAvailable(update); setDownloaded(false); downloadedRef.current = false;
            if (!update) { if (!automatic) toast.success(notify('updates.latest')); return; }
            toast.info(notify('updates.available', { version: update.version }), {
                id: 'auralyn-update', duration: Infinity,
                description: notify('updates.keepCurrent'),
                action: { label: notify('updates.review'), onClick: () => setShowAvailable(true) },
            });
            if (!automatic) setShowAvailable(true);
            if (automatic && policy.download && update.canInstall) {
                await invoke('download_update', { version: update.version });
                setDownloaded(true); downloadedRef.current = true;
            }
        } catch (error) {
            if (!automatic) toast.info(notify('updates.checkFailed'), {
                description: renderClientError(notify, error),
                action: { label: notify('updates.distributionPage'), onClick: () => window.open('https://github.com/blackflame7983/Auralyn-Releases/releases', '_blank') },
            });
        } finally { busyRef.current = false; setBusy(false); }
    }, [policy.download]);

    useEffect(() => {
        if (!policy.automatic || distribution !== 'standalone') return;
        const first = setTimeout(() => void checkUpdates(true), 10000);
        const periodic = setInterval(() => void checkUpdates(true), 24 * 60 * 60 * 1000);
        return () => { clearTimeout(first); clearInterval(periodic); };
    }, [policy.automatic, distribution, checkUpdates]);

    const perform = async (install: boolean) => {
        if (!available || busyRef.current) return;
        const startedLocale = localeRef.current;
        const notify = (key: MessageKey, args?: Record<string, string | number>) => message(startedLocale, key, args);
        busyRef.current = true; setBusy(true);
        try {
            if (install) {
                await flushSession();
                await invoke('install_update', { version: available.version });
            } else {
                await invoke('download_update', { version: available.version });
                setDownloaded(true); downloadedRef.current = true;
            }
        } catch (error) {
            if (install) { setDownloaded(false); downloadedRef.current = false; }
            toast.error(install ? notify('updates.installFailed') : notify('updates.downloadFailed'), { description: renderClientError(notify, error) });
        } finally { busyRef.current = false; setBusy(false); }
    };
    return {
        label: distribution === 'standalone' ? t('updates.check') : t('updates.method'),
        description: distribution === 'msix' ? t('updates.msixDescription') : t('updates.methodDescription'),
        busy, available, downloaded, showAvailable, showGuide,
        checkUpdates: () => checkUpdates(false),
        closeGuide: () => setShowGuide(false), closeAvailable: () => setShowAvailable(false),
        download: () => perform(false), install: () => perform(true),
    };
}

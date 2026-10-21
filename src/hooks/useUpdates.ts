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
        busyRef.current = true; setBusy(true);
        try {
            let current: Distribution;
            try { current = await desktopApi.getDistribution(); }
            catch {
                if (!automatic) toast.error('更新方法を確認できませんでした', { description: 'アプリを再起動してから、もう一度お試しください。' });
                return;
            }
            setDistribution(current);
            if (current === 'msix') { if (!automatic) setShowGuide(true); return; }
            if (current !== 'standalone') {
                if (!automatic) toast.error('更新方法を確認できませんでした', { description: 'アプリを再起動してから、もう一度お試しください。' });
                return;
            }
            const update = await invoke<AvailableUpdate | null>('check_update');
            setAvailable(update); setDownloaded(false); downloadedRef.current = false;
            if (!update) { if (!automatic) toast.success('最新バージョンです'); return; }
            toast.info(`v${update.version} が利用可能です`, {
                id: 'auralyn-update', duration: Infinity,
                description: '適用するまで現在の版で使い続けられます。',
                action: { label: '更新内容を確認', onClick: () => setShowAvailable(true) },
            });
            if (!automatic) setShowAvailable(true);
            if (automatic && policy.download && update.canInstall) {
                await invoke('download_update', { version: update.version });
                setDownloaded(true); downloadedRef.current = true;
            }
        } catch (error) {
            if (!automatic) toast.info('自動更新情報を取得できませんでした', {
                description: String(error),
                action: { label: '配布ページ', onClick: () => window.open('https://github.com/blackflame7983/Auralyn-Releases/releases', '_blank') },
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
            toast.error(install ? '更新を適用できませんでした' : '更新を取得できませんでした', { description: String(error) });
        } finally { busyRef.current = false; setBusy(false); }
    };
    return {
        label: distribution === 'standalone' ? 'アップデートを確認' : '更新方法を確認',
        description: distribution === 'msix' ? 'MSIX版は配布元から更新します' : 'インストール形式に合う更新方法',
        busy, available, downloaded, showAvailable, showGuide,
        checkUpdates: () => checkUpdates(false),
        closeGuide: () => setShowGuide(false), closeAvailable: () => setShowAvailable(false),
        download: () => perform(false), install: () => perform(true),
    };
}

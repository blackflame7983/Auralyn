import { useEffect, useRef, useState } from 'react';
import type { VstPlugin } from '@/api/audio';
import { pluginKey } from '@/lib/pluginIdentity';

export const pluginListStorage = {
    favorites: 'vst_host_plugin_favorites',
    recent: 'vst_host_plugin_recent',
} as const;

function readStoredPaths(key: string): string[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
    } catch {
        return [];
    }
}

function migrateStoredKeys(stored: string[], plugins: VstPlugin[]): { keys: string[]; changed: boolean } {
    if (plugins.length === 0) return { keys: stored, changed: false };
    const keys: string[] = [];
    let changed = false;
    for (const key of stored) {
        if (key.includes('::')) {
            if (!keys.includes(key)) keys.push(key);
            continue;
        }
        const matches = plugins.filter(plugin => plugin.path === key);
        if (matches.length === 1) {
            const migrated = pluginKey(matches[0]);
            if (migrated !== key) changed = true;
            if (!keys.includes(migrated)) keys.push(migrated);
        } else if (!keys.includes(key)) {
            keys.push(key);
        }
    }
    if (keys.length !== stored.length) changed = true;
    return { keys, changed };
}

export function storedKeyMatches(plugin: VstPlugin, stored: string, plugins: VstPlugin[]): boolean {
    if (stored === pluginKey(plugin)) return true;
    if (stored.includes('::') || plugin.path !== stored) return false;
    return plugins.filter(candidate => candidate.path === plugin.path).length !== 1;
}

export function usePluginBrowserLists(plugins: VstPlugin[]) {
    const [favorites, setFavorites] = useState<string[]>([]);
    const [recentPaths, setRecentPaths] = useState<string[]>([]);
    useEffect(() => {
        const favoriteStored = readStoredPaths(pluginListStorage.favorites);
        const recentStored = readStoredPaths(pluginListStorage.recent);
        const nextFavorites = migrateStoredKeys(favoriteStored, plugins);
        const nextRecent = migrateStoredKeys(recentStored, plugins);
        if (!nextFavorites.changed && !nextRecent.changed) {
            setFavorites(nextFavorites.keys);
            setRecentPaths(nextRecent.keys);
            return;
        }
        const previousFavorites = localStorage.getItem(pluginListStorage.favorites);
        const previousRecent = localStorage.getItem(pluginListStorage.recent);
        const restoreStored = (key: string, previous: string | null) => {
            try {
                if (previous === null) localStorage.removeItem(key);
                else localStorage.setItem(key, previous);
            } catch {
                // 戻し書きも失敗したときは旧キーを残し、次の表示で再試行する。
            }
        };
        try {
            if (nextFavorites.changed) localStorage.setItem(pluginListStorage.favorites, JSON.stringify(nextFavorites.keys));
            if (nextRecent.changed) localStorage.setItem(pluginListStorage.recent, JSON.stringify(nextRecent.keys));
        } catch {
            restoreStored(pluginListStorage.favorites, previousFavorites);
            restoreStored(pluginListStorage.recent, previousRecent);
            setFavorites(favoriteStored);
            setRecentPaths(recentStored);
            return;
        }
        setFavorites(nextFavorites.keys);
        setRecentPaths(nextRecent.keys);
    }, [plugins]);
    return { favorites, setFavorites, recentPaths, setRecentPaths };
}

// 開いた時点で空なら一度だけ探す。その後の一覧の変化ではやり直さない。
export function useScanEmptyCatalog(isOpen: boolean, pluginCount: number, onScan: () => void) {
    const scan = useRef(onScan);
    const count = useRef(pluginCount);
    scan.current = onScan;
    count.current = pluginCount;
    useEffect(() => {
        if (isOpen && count.current === 0) scan.current();
    }, [isOpen]);
}

export function useClearCategoryOnTab(activeTab: string, setSelectedCategory: (value: string | null) => void) {
    useEffect(() => {
        if (activeTab !== 'all') setSelectedCategory(null);
    }, [activeTab, setSelectedCategory]);
}

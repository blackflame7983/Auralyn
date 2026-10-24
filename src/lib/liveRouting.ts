import { useSyncExternalStore } from 'react';
import type { LiveMode } from '@/api/liveModes';
export const LIVE_ROUTING_KEY = 'vst_host_live_scene_routing';
export const LIVE_ROUTING_CHANGED = 'live-scene-routing-changed';
export interface LiveRouting { version: 1; strategy: 'none' | 'preset' | 'mode'; mappings: Record<string, LiveMode>; explicitEnabled: boolean }
export function readLiveRouting(): LiveRouting | null {
    const text = localStorage.getItem(LIVE_ROUTING_KEY);
    if (text === null) return null; // 未移行ユーザーの従来方式。背景接続は増やさない。
    try {
        const value = JSON.parse(text);
        if (value.version !== 1 || !['none', 'preset', 'mode'].includes(value.strategy) || typeof value.explicitEnabled !== 'boolean'
            || !value.mappings || typeof value.mappings !== 'object' || Array.isArray(value.mappings)
            || Object.values(value.mappings).some(mode => mode !== 'singing' && mode !== 'talk')) throw new Error();
        return value;
    } catch { return { version: 1, strategy: 'none', explicitEnabled: false, mappings: {} }; }
}
export function saveLiveRouting(value: LiveRouting) {
    if (rackRestoreBusy()) throw new Error('プリセット・プロファイルの復元中です。完了してから連動方式を変更してください。');
    localStorage.setItem(LIVE_ROUTING_KEY, JSON.stringify(value));
    window.dispatchEvent(new Event(LIVE_ROUTING_CHANGED));
}
let restores = 0;
const subscribers = new Set<() => void>();
export const rackRestoreBusy = () => restores > 0;
export function beginRackRestore() {
    restores++; subscribers.forEach(update => update());
    let active = true;
    return () => { if (active) { active = false; restores--; subscribers.forEach(update => update()); } };
}
export const useRackRestoreBusy = () => useSyncExternalStore(callback => { subscribers.add(callback); return () => { subscribers.delete(callback); }; }, rackRestoreBusy);

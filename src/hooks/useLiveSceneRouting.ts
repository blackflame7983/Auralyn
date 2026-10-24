import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { obsApi, type ObsLiveSceneEvent, type ObsLiveSceneStatus } from '@/api/obs';
import { presetApi } from '@/api/presets';
import { liveModesApi } from '@/api/liveModes';
import { LIVE_ROUTING_CHANGED, readLiveRouting, rackRestoreBusy } from '@/lib/liveRouting';
import { useObsUsage } from './useObsUsage';

// 新イベントだけを購読する唯一のrouter。接続や現在sceneの取得では適用しない。
export function useLiveSceneRouting(onLoadPreset: (name: string) => Promise<boolean>) {
    const t = useMessages();
    const [version, setVersion] = useState(0);
    const routing = readLiveRouting();
    useObsUsage(Boolean(routing?.explicitEnabled && routing.strategy !== 'none'), true);
    useEffect(() => {
        const changed = () => setVersion(value => value + 1);
        window.addEventListener(LIVE_ROUTING_CHANGED, changed);
        return () => window.removeEventListener(LIVE_ROUTING_CHANGED, changed);
    }, []);
    useEffect(() => {
        const chosen = readLiveRouting();
        if (chosen && (!chosen.explicitEnabled || chosen.strategy === 'none')) return;
        const strategy = chosen?.strategy ?? 'preset';
        let active = true; let ticket = 0; let baseline: ObsLiveSceneStatus | null = null;
        const reset = async () => {
            const request = ++ticket; baseline = null;
            try { const value = await obsApi.liveSceneStatus(); if (active && request === ticket) baseline = value; }
            catch { if (active && request === ticket) toast.error(t('liveNotices.connectionFailed')); }
        };
        const route = async (event: ObsLiveSceneEvent) => {
            if (!active || !baseline || typeof event.sceneName !== 'string'
                || !Number.isSafeInteger(event.sequence) || !Number.isSafeInteger(event.connectionGeneration)
                || event.connectionGeneration < baseline.connectionGeneration
                || (event.connectionGeneration === baseline.connectionGeneration && event.sequence <= baseline.sequence)) return;
            baseline = { connected: true, connectionGeneration: event.connectionGeneration, sequence: event.sequence };
            const request = ++ticket;
            const valid = async () => {
                if (!active || request !== ticket || rackRestoreBusy()) return false;
                const status = await obsApi.liveSceneStatus();
                return active && request === ticket && !rackRestoreBusy() && status.connected
                    && status.connectionGeneration === event.connectionGeneration && status.sequence === event.sequence;
            };
            try {
                if (strategy === 'mode') {
                    const mode = chosen?.mappings[event.sceneName];
                    if (mode !== 'singing' && mode !== 'talk') return;
                    const snapshot = await liveModesApi.request({ action: 'snapshot' });
                    if (!await valid()) return;
                    await liveModesApi.select(mode, snapshot.epoch);
                } else {
                    const list = await presetApi.list();
                    if (!list.includes(event.sceneName) || !await valid()) return;
                    toast.info(t('liveNotices.loadingPreset', { scene: event.sceneName }));
                    await onLoadPreset(event.sceneName);
                }
            } catch { if (active && request === ticket) toast.error(t('liveNotices.routeFailed')); }
        };
        const scene = obsApi.onLiveSceneChanged(event => { void route(event); });
        const invalidated = obsApi.onLiveSceneInvalidated(() => { void reset(); });
        void Promise.all([scene, invalidated]).then(() => { if (active) void reset(); }).catch(() => { if (active) toast.error(t('liveNotices.routeEventsFailed')); });
        return () => { active = false; ticket++; [scene, invalidated].forEach(item => void item.then(stop => stop()).catch(() => {})); };
    }, [onLoadPreset, version]);
}

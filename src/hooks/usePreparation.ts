import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { liveOutputApi } from '@/api/liveOutput';
import { obsApi } from '@/api/obs';
import {
    buildPreparationObservation, emptyObservation, expireConfirmations,
    observationStamp, preparationReach, readPreparationContext, savePreparationContext,
    type Confirmations, type PreparationContext, type PreparationObservation, type PreparationStage,
} from '@/lib/preparation';

export function usePreparation({ blocked = false, running = false }: { blocked?: boolean; running?: boolean }) {
    const [context, setContext] = useState(readPreparationContext);
    const [observation, setObservation] = useState(emptyObservation);
    const [records, setRecords] = useState<Confirmations>({});
    const [checking, setChecking] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const alive = useRef(false);
    const generation = useRef(0);
    const listenersReady = useRef(false);
    const currentContext = useRef(context);
    const currentObservation = useRef(observation);
    currentObservation.current = observation;
    const blockedRef = useRef(blocked);
    blockedRef.current = blocked;
    const runningRef = useRef(running);
    runningRef.current = running;
    const eventStopped = useRef(false);
    const inFlight = useRef<Promise<PreparationObservation | null> | null>(null);

    const accept = useCallback((next: PreparationObservation) => {
        setObservation(next);
        setRecords(old => expireConfirmations(old, next));
    }, []);
    const expireAll = useCallback(() => {
        generation.current += 1;
        setRecords(old => Object.fromEntries(Object.entries(old).map(([stage, receipt]) => [stage, { ...receipt, expired: true }])));
    }, []);
    const refresh = useCallback((): Promise<PreparationObservation | null> => {
        if (!alive.current || !runningRef.current || eventStopped.current || blockedRef.current || document.hidden || !listenersReady.current) return Promise.resolve(null);
        if (inFlight.current) return inFlight.current;
        const version = generation.current;
        const capturedContext = currentContext.current;
        const receipt = preparationReach.get();
        setChecking(true);
        const request = (async () => {
            try {
                const state = await audioApi.getAudioState();
                if (!state || typeof state.is_running !== 'boolean') throw new Error('Unavailable audio state');
                let next: PreparationObservation;
                if (!state.is_running) next = { ...emptyObservation(state.config?.host ? 'stopped' : 'unconfigured'), config: state.config };
                else {
                    const before = await audioApi.getEngineRuntimeStats();
                    const live = await liveOutputApi.request();
                    // OBS以外の用途では、OBSへの状態取得・接続・検査を行わない。
                    const obsCurrent = capturedContext.usage === 'obs' && receipt?.verification && capturedContext.receiver.trim() === receipt.verification.source
                        ? await obsApi.audioReachCurrent(receipt.verification.operationId) === true : false;
                    const after = await audioApi.getEngineRuntimeStats();
                    const finalState = await audioApi.getAudioState();
                    if (observationStamp(before) !== observationStamp(after) || JSON.stringify(state) !== JSON.stringify(finalState)) throw new Error('Audio conditions changed while reading');
                    next = buildPreparationObservation(state, after, live, capturedContext, capturedContext.usage === 'obs' ? receipt : null, obsCurrent);
                }
                if (!alive.current || version !== generation.current || blockedRef.current || document.hidden) return null;
                accept(next);
                return next;
            } catch {
                if (alive.current && version === generation.current && !document.hidden) accept(emptyObservation());
                return null;
            } finally {
                inFlight.current = null;
                if (alive.current) setChecking(false);
                // StrictModeの再購読や状態変更で破棄した読取りは、新しい条件で取り直す。
                if (alive.current && version !== generation.current) queueMicrotask(() => { void refresh(); });
            }
        })();
        inFlight.current = request;
        return request;
    }, [accept]);

    useEffect(() => {
        alive.current = true;
        let active = true;
        const refreshConditions = () => { if (!active) return; generation.current += 1; setChecking(true); setObservation(old => ({ ...old, availability: 'pending' })); void refresh(); };
        const stop = () => { if (!active) return; eventStopped.current = true; expireAll(); accept(emptyObservation('stopped')); };
        const fail = () => { if (!active) return; eventStopped.current = true; expireAll(); accept(emptyObservation('failed')); };
        const external = () => { if (!active) return; expireAll(); void refresh(); };
        const started = () => { if (!active) return; eventStopped.current = false; external(); };
        const obsInvalidated = () => {
            if (!active) return;
            generation.current += 1;
            setRecords(old => old.receiver ? { ...old, receiver: { ...old.receiver, expired: true } } : old);
            setObservation(old => ({ ...old, obsCurrent: false }));
            void refresh();
        };
        const visibility = () => {
            if (document.hidden) { expireAll(); preparationReach.clear(); accept(emptyObservation()); }
            else void refresh();
        };
        const purposeChanged = () => {
            const next = readPreparationContext();
            if (next.usage !== currentContext.current.usage) {
                generation.current += 1;
                currentContext.current = { ...currentContext.current, usage: next.usage, receiver: '' };
                savePreparationContext(currentContext.current);
                setContext(currentContext.current);
                setRecords(old => old.receiver ? { ...old, receiver: { ...old.receiver, expired: true } } : old);
            }
            void refresh();
        };
        const subscriptions = [
            listen('audio-started', started), listen('audio-stopped', stop), listen('audio-error', fail), listen('audio-stream-error', fail),
            listen('audio-conditions-changed', refreshConditions), listen('global-bypass-changed', refreshConditions),
            listen('obs://reach-invalidated', obsInvalidated), listen('obs://timing-invalidated', obsInvalidated),
        ];
        void Promise.all(subscriptions).then(() => {
            if (active && alive.current) { listenersReady.current = true; void refresh(); }
        }).catch(() => { if (active && alive.current) { listenersReady.current = false; accept(emptyObservation()); } });
        const unsubscribe = preparationReach.subscribe(() => {
            const receipt = preparationReach.get();
            const ctx = currentContext.current;
            if (ctx.usage === 'obs' && !ctx.receiver.trim() && receipt?.verification && receipt.reached === true) {
                currentContext.current = { ...ctx, receiver: receipt.verification.source };
                setContext(currentContext.current); savePreparationContext(currentContext.current);
            }
            refreshConditions();
        });
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('preparation-external-change', external);
        window.addEventListener('profile-fx-applied', refreshConditions);
        window.addEventListener('preparation-purpose-changed', purposeChanged);
        const timer = setInterval(() => { void refresh(); }, 2000);
        return () => {
            active = false; alive.current = false; listenersReady.current = false; generation.current += 1;
            clearInterval(timer); unsubscribe();
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('preparation-external-change', external);
            window.removeEventListener('profile-fx-applied', refreshConditions);
            window.removeEventListener('preparation-purpose-changed', purposeChanged);
            subscriptions.forEach(p => { void p.then(stop => stop()).catch(() => {}); });
        };
    }, [accept, expireAll, refresh]);

    useEffect(() => {
        generation.current += 1;
        if (!running) { expireAll(); accept(emptyObservation('stopped')); }
        if (!blocked) void refresh();
    }, [blocked, running, accept, expireAll, refresh]);

    const changeContext = (patch: Partial<PreparationContext>) => {
        const next = { ...currentContext.current, ...patch };
        generation.current += 1;
        currentContext.current = next; setContext(next); savePreparationContext(next);
        setObservation(old => ({ ...old, availability: 'pending', obsCurrent: false }));
        if (patch.location !== undefined || patch.signal !== undefined || patch.usage !== undefined || patch.receiver !== undefined) preparationReach.clear();
        setRecords(old => Object.fromEntries(Object.entries(old).map(([stage, receipt]) => [stage,
            patch.location !== undefined || patch.signal !== undefined || stage === 'receiver' ? { ...receipt, expired: true } : receipt])));
        void refresh();
    };
    const confirm = async (stage: PreparationStage) => {
        if (confirming || blockedRef.current || document.hidden) return;
        const version = generation.current;
        const expectedKey = currentObservation.current.keys?.[stage];
        setConfirming(true);
        try {
            const next = await refresh();
            const ctx = currentContext.current;
            if (!next?.keys || next.keys[stage] !== expectedKey || next.availability !== 'ready' || version !== generation.current || !ctx.usage
                || (stage === 'receiver' && ctx.usage !== 'listening' && !ctx.receiver.trim()) || blockedRef.current || document.hidden) return;
            setRecords(old => ({ ...old, [stage]: { key: next.keys![stage], at: Date.now(), target: stage === 'receiver' ? ctx.receiver : next.config?.input ?? '', expired: false } }));
        } finally { if (alive.current) setConfirming(false); }
    };
    const unconfirm = (stage: PreparationStage) => setRecords(old => old[stage] ? { ...old, [stage]: { ...old[stage]!, expired: true } } : old);
    return { context, changeContext, observation, records, checking, confirming, confirm, unconfirm, refresh, reset: expireAll };
}
export type PreparationModel = ReturnType<typeof usePreparation>;

import { createOutputChangeScheduler, startPreparationRefresh } from '@/hooks/internal/preparationRefresh';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { noiseMeasurementApi } from '@/api/noiseMeasurement';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { liveOutputApi } from '@/api/liveOutput';
import { obsApi } from '@/api/obs';
import { withOutputControls } from '@/lib/preparationOutputControls';
import {
    buildPreparationObservation, emptyObservation, expireConfirmations,
    normalizeReceiver, observationStamp, preparationReach, readPreparationContext, savePreparationContext,
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
    const probeSequence = useRef(0);

    const accept = useCallback((next: PreparationObservation) => {
        setObservation(next);
        setRecords(old => expireConfirmations(old, next));
    }, []);
    const expireAll = useCallback(() => {
        generation.current += 1;
        setRecords(old => Object.fromEntries(Object.entries(old).map(([stage, receipt]) => [stage, { ...receipt, expired: true }])));
    }, []);
    const refresh = useCallback((): Promise<PreparationObservation | null> => {
        if (!alive.current || !runningRef.current || eventStopped.current || blockedRef.current || isAppHidden() || !listenersReady.current) return Promise.resolve(null);
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
                if (!alive.current || version !== generation.current || blockedRef.current || isAppHidden()) return null;
                accept(next);
                return next;
            } catch {
                if (alive.current && version === generation.current && !isAppHidden()) accept(emptyObservation());
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

    // 取得を止めている間は、札に出るミュートと音量ゼロだけを読み直す。最新の読取りだけを採る。
    const probeOutputControls = useCallback(async () => {
        if (!alive.current || !runningRef.current || eventStopped.current || isAppHidden()) return;
        const sequence = ++probeSequence.current;
        try {
            const stats = await audioApi.getEngineRuntimeStats();
            if (!alive.current || sequence !== probeSequence.current || !blockedRef.current || isAppHidden()) return;
            setObservation(old => withOutputControls(old, stats));
        } catch { /* 読めないときは直前の札を保つ。失敗の扱いは再開時の取り直しに任せる。 */ }
    }, []);

    useEffect(() => {
        alive.current = true;
        let active = true;
        // 診断などで読み取りを止めている間は、背後の画面を確認待ちにしない。再開時に読み直す。
        const refreshConditions = () => { if (!active) return; generation.current += 1; if (blockedRef.current) return; setChecking(true); setObservation(old => ({ ...old, availability: 'pending' })); void refresh(); };
        let lastGainSync: number | null = null;
        const stop = () => { if (!active) return; lastGainSync = null; eventStopped.current = true; expireAll(); accept(emptyObservation('stopped')); };
        const fail = () => { if (!active) return; lastGainSync = null; eventStopped.current = true; expireAll(); accept(emptyObservation('failed')); };
        const external = () => { if (!active) return; expireAll(); void refresh(); };
        const started = () => { if (!active) return; lastGainSync = null; eventStopped.current = false; external(); };
        const obsInvalidated = () => {
            if (!active) return;
            generation.current += 1;
            setRecords(old => old.receiver ? { ...old, receiver: { ...old.receiver, expired: true } } : old);
            setObservation(old => ({ ...old, obsCurrent: false }));
            void refresh();
        };
        const visibility = () => {
            if (isAppHidden()) { expireAll(); preparationReach.clear(); accept(emptyObservation()); }
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
        // 緊急ミュートと出力音量は条件の通知を持たないため、変化の通知から取り直す。古い読取りは世代で捨て、連続する通知は1回へまとめる。
        const outputScheduler = createOutputChangeScheduler(() => { if (blockedRef.current) void probeOutputControls(); else void refresh(); });
        const outputChanged = () => { if (!active) return; generation.current += 1; outputScheduler.request(); };
        // 同じ音量の再通知（音量の自動調整の状態確認など）では取り直さない。エンジンの再起動では値を忘れる。
        const gainSynced = (event: Event) => {
            const pct = event instanceof CustomEvent ? event.detail as unknown : null;
            if (typeof pct === 'number' && Number.isFinite(pct)) { if (pct === lastGainSync) return; lastGainSync = pct; }
            outputChanged();
        };
        const subscriptions = [
            listen('audio-started', started), listen('audio-stopped', stop), listen('audio-error', fail), listen('audio-stream-error', fail),
            listen('audio-conditions-changed', refreshConditions), listen('global-bypass-changed', refreshConditions),
            listen('global-mute-changed', outputChanged),
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
        addAppVisibilityListener(visibility);
        window.addEventListener('preparation-external-change', external);
        window.addEventListener('output-gain-sync', gainSynced);
        window.addEventListener('profile-fx-applied', refreshConditions);
        window.addEventListener('preparation-purpose-changed', purposeChanged);
        const stopRefresh = startPreparationRefresh(() => { void refresh(); });
        return () => {
            active = false; alive.current = false; listenersReady.current = false; generation.current += 1;
            stopRefresh(); unsubscribe(); outputScheduler.cancel();
            removeAppVisibilityListener(visibility);
            window.removeEventListener('preparation-external-change', external);
            window.removeEventListener('output-gain-sync', gainSynced);
            window.removeEventListener('profile-fx-applied', refreshConditions);
            window.removeEventListener('preparation-purpose-changed', purposeChanged);
            subscriptions.forEach(p => { void p.then(stop => stop()).catch(() => {}); });
        };
    }, [accept, expireAll, refresh, probeOutputControls]);

    useEffect(() => {
        generation.current += 1;
        if (!running) { expireAll(); accept(emptyObservation('stopped')); }
        if (!blocked) void refresh();
    }, [blocked, running, accept, expireAll, refresh]);

    const changeContext = (patch: Partial<PreparationContext>) => {
        const receiver = patch.receiver === undefined ? undefined : normalizeReceiver(patch.receiver);
        const receiverOnly = receiver !== undefined && patch.location === undefined && patch.signal === undefined && patch.usage === undefined;
        // 名前が実質変わらないなら、確認の失効も再取得もしない。
        if (receiverOnly && receiver === currentContext.current.receiver) return;
        const next = { ...currentContext.current, ...patch, ...(receiver === undefined ? {} : { receiver }) };
        if ((patch.location !== undefined && patch.location !== currentContext.current.location) || (patch.signal !== undefined && patch.signal !== currentContext.current.signal)) {
            void noiseMeasurementApi.request({ action: 'invalidate' }).catch(() => {});
        }
        generation.current += 1;
        currentContext.current = next; setContext(next); savePreparationContext(next);
        // 名前だけの変更は音の状態を変えないので、読み直しが終わるまで「確認待ち」にしない。
        setObservation(old => ({ ...old, ...(receiverOnly ? {} : { availability: 'pending' as const }), obsCurrent: false }));
        if (patch.location !== undefined || patch.signal !== undefined || patch.usage !== undefined || receiver !== undefined) preparationReach.clear();
        setRecords(old => Object.fromEntries(Object.entries(old).map(([stage, receipt]) => [stage,
            patch.location !== undefined || patch.signal !== undefined || stage === 'receiver' ? { ...receipt, expired: true } : receipt])));
        void refresh();
    };
    const confirm = async (stage: PreparationStage) => {
        if (confirming || blockedRef.current || isAppHidden()) return;
        const version = generation.current;
        const expectedKey = currentObservation.current.keys?.[stage];
        setConfirming(true);
        try {
            const next = await refresh();
            const ctx = currentContext.current;
            if (!next?.keys || next.keys[stage] !== expectedKey || next.availability !== 'ready' || version !== generation.current || !ctx.usage
                || blockedRef.current || isAppHidden()) return;
            const receiverFallback = ctx.usage === 'obs' ? 'OBS' : ctx.usage === 'discord' ? 'Discord' : ctx.usage === 'other' ? (next.config?.output ?? '') : '';
            const key = next.keys[stage];
            setRecords(old => ({ ...old, [stage]: { key, at: Date.now(), target: stage === 'receiver' ? (ctx.receiver.trim() || receiverFallback) : next.config?.input ?? '', expired: false } }));

        } finally { if (alive.current) setConfirming(false); }
    };
    const unconfirm = (stage: PreparationStage) => setRecords(old => {
        const receipt = old[stage];
        return receipt ? { ...old, [stage]: { ...receipt, expired: true } } : old;
    });
    const changeContextRef = useRef(changeContext);
    changeContextRef.current = changeContext;
    useEffect(() => {
        const onReceiverEdited = (event: Event) => {
            if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
            event.preventDefault();
            const next = normalizeReceiver(event.detail);
            if (next === currentContext.current.receiver) return;
            changeContextRef.current({ receiver: next });
        };
        window.addEventListener('preparation-receiver-edited', onReceiverEdited);
        return () => window.removeEventListener('preparation-receiver-edited', onReceiverEdited);
    }, []);
    return { context, changeContext, observation, records, checking, confirming, confirm, unconfirm, refresh, reset: () => { expireAll(); void noiseMeasurementApi.request({ action: 'invalidate' }).catch(() => {}); } };
}
export type PreparationModel = ReturnType<typeof usePreparation>;

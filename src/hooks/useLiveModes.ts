import { useMessages } from '@/i18n/LocaleProvider';
import { message, type MessageKey } from '@/i18n/messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { builtinApi } from '@/api/builtinEffects';
import { liveModesApi, type LiveMode, type LiveModeSnapshot } from '@/api/liveModes';
import { rackRestoreBusy, useRackRestoreBusy } from '@/lib/liveRouting';

type LiveNotice = { key: MessageKey; reason?: keyof typeof clientKeys; rawDetail?: string };
const clientKeys = { notReady: 'liveNotices.notReady', pending: 'liveNotices.pending', reverb: 'liveNotices.reverb' } as const;
// 既知のclient理由だけをcode化する。原文messageは制御や外部例外の翻訳に使わない。
class LiveModeClientError extends Error {
    constructor(readonly code: keyof typeof clientKeys) { super(message('ja', clientKeys[code])); }
}

// 保持するだけではIPCしない。開いた操作部品だけが購読・定期確認を使用する。
export function useLiveModes(externalBusy = false) {
    const t = useMessages();
    const rackBusy = useRackRestoreBusy();
    const [users, setUsers] = useState(0);
    const activate = useCallback(() => { setUsers(n => n + 1); return () => setUsers(n => Math.max(0, n - 1)); }, []);
    const [snapshot, setSnapshot] = useState<LiveModeSnapshot | null>(null);
    const [busy, setBusy] = useState(false);
    const [errorNotice, setError] = useState<LiveNotice | null>(null);
    const mounted = useRef(true); const serial = useRef(0); const writing = useRef(false);
    const reading = useRef(false);
    const current = useRef(snapshot); current.current = snapshot;
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
    const refresh = useCallback(async (clearError = true) => {
        if (writing.current || reading.current || document.hidden) return;
        reading.current = true;
        const request = ++serial.current;
        try {
            const value = await liveModesApi.request({ action: 'snapshot' });
            if (mounted.current && request === serial.current) { current.current = value; setSnapshot(value); if (clearError) setError(null); }
        } catch { if (mounted.current && request === serial.current) setError({ key: 'liveNotices.stateFailed' }); }
        finally { reading.current = false; }
    }, []);
    useEffect(() => {
        if (!users) return;
        let active = true;
        const update = () => { if (active) void refresh(false); };
        const event = listen('live-modes-invalidated', update);
        void event.catch(() => { if (active) setError({ key: 'liveNotices.eventsFailed' }); });
        const timer = setInterval(update, 500);
        document.addEventListener('visibilitychange', update);
        update();
        return () => { active = false; serial.current++; clearInterval(timer); document.removeEventListener('visibilitychange', update); void event.then(stop => stop()).catch(() => {}); };
    }, [users > 0, refresh]);
    const change = async (action: () => Promise<LiveModeSnapshot>) => {
        if (writing.current) return;
        if (externalBusy || rackRestoreBusy()) { setError({ key: 'liveNotices.restoring' }); return; }
        writing.current = true; serial.current++; setBusy(true); setError(null);
        try {
            const value = await action();
            if (mounted.current) { current.current = value; setSnapshot(value); }
        } catch (cause) {
            if (mounted.current) setError({ key: 'liveNotices.operationFailed', reason: cause instanceof LiveModeClientError ? cause.code : undefined, rawDetail: cause instanceof LiveModeClientError ? undefined : String(cause) });
        } finally { writing.current = false; if (mounted.current) setBusy(false); }
    };
    const error = errorNotice ? [t(errorNotice.key), errorNotice.reason ? t(clientKeys[errorNotice.reason]) : '',
        errorNotice.rawDetail ? t('liveNotices.rawDetail', { detail: errorNotice.rawDetail }) : ''].filter(Boolean).join(' ') : '';
    return { activate, snapshot, busy: busy || rackBusy || externalBusy, error, refresh,
        select: (mode: LiveMode) => current.current ? change(() => liveModesApi.select(mode, current.current!.epoch)) : Promise.resolve(),
        protect: (armed: boolean) => current.current ? change(() => liveModesApi.protect(armed, current.current!.epoch)) : Promise.resolve(),
        saveApplied: (mode: LiveMode) => change(async () => {
            const before = current.current;
            if (!before) throw new LiveModeClientError('notReady');
            const applied = await builtinApi.request({ action: 'snapshot' });
            if (applied.pending) throw new LiveModeClientError('pending');
            if (mode === 'talk' && applied.config.reverb?.enabled) throw new LiveModeClientError('reverb');
            return liveModesApi.request({ action: 'save', expectedVersion: before.definitions.version,
                singing: mode === 'singing' ? applied.config : before.definitions.singing,
                talk: mode === 'talk' ? applied.config : before.definitions.talk });
        }),
    };
}
export type LiveModesModel = ReturnType<typeof useLiveModes>;

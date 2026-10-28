import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { builtinApi, type BuiltinSnapshot } from '@/api/builtinEffects';
import { gainCommand, readOutputGainStatus, confirmOutputGain, type GainSnapshot } from '@/api/outputGain';
import { voicePreviewApi, type VoicePreviewSnapshot } from '@/api/voiceCheckPreview';
import { liveModesApi } from '@/api/liveModes';
import { useMessages } from '@/i18n/LocaleProvider';

export function AdjustmentHistoryPanel({ onVoiceCheck }: { onVoiceCheck?: () => void }) {
    const t = useMessages();
    const [snapshot, setSnapshot] = useState<{ builtin: BuiltinSnapshot; gain: GainSnapshot; noise: VoicePreviewSnapshot; protected: boolean } | null>(null);
    const [known, setKnown] = useState(false);
    const [busy, setBusy] = useState(false);
    const [eventsReady, setEventsReady] = useState(false);
    const pending = useRef(false);
    const generation = useRef(0);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        const invalidate = () => { generation.current++; setKnown(false); };
        const events = ['audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'audio-conditions-changed', 'global-bypass-changed'].map(event => listen(event, invalidate));
        void Promise.all(events).then(() => { if (alive.current) setEventsReady(true); }).catch(() => {if(alive.current) {setKnown(false);setEventsReady(false);}});
        window.addEventListener('profile-fx-applied', invalidate);
        window.addEventListener('output-gain-sync', invalidate);
        document.addEventListener('visibilitychange', invalidate);
        return () => { alive.current = false; generation.current++; events.forEach(e => void e.then(stop => stop()).catch(() => {})); window.removeEventListener('profile-fx-applied', invalidate); window.removeEventListener('output-gain-sync', invalidate); document.removeEventListener('visibilitychange', invalidate); };
    }, []);
    const load = async (version: number) => {
        const stream = await audioApi.getAudioStreamState();
        if (!stream.running || stream.streamFailed) throw new Error('Stream unavailable');
        const [builtin, gain, noise, live] = await Promise.all([builtinApi.request({action: 'snapshot'}), readOutputGainStatus(), voicePreviewApi.request({action: 'history_status', clientId: 'recovery-hub', sessionId: 0, operationId: 0, epoch: null}), liveModesApi.request({action: 'snapshot'})]);
        if (alive.current && version === generation.current && !document.hidden) { setSnapshot({builtin, gain, noise, protected: live.armed}); setKnown(true); }
    };
    const run = async (action?: () => Promise<unknown>) => {
        if (pending.current || document.hidden || !eventsReady) return;
        pending.current = true; setBusy(true); setKnown(false);
        try {
            if (action) await action();
            await load(++generation.current);
        } catch { if (alive.current) setKnown(false); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
    };
    const builtinChange = (redo: boolean) => run(async () => {
        const before = snapshot?.builtin;
        if (!before || !known) throw new Error('Unverified history');
        let next = await builtinApi.request(redo ? {action: 'redo', epoch: before.epoch, expectedRevision: before.revision, redoToken: before.redoToken!} : {action: 'undo', epoch: before.epoch, expectedRevision: before.revision, undoToken: before.undoToken!});
        for (let i = 0; next.pending && i < 40; i++) { await new Promise(resolve => setTimeout(resolve, 25)); next = await builtinApi.request({action: 'snapshot'}); }
        if (next.pending || next.error || next.epoch !== before.epoch) throw new Error('Application unconfirmed');
        window.dispatchEvent(new Event('profile-fx-applied'));
    });
    const gainChange = (redo: boolean) => run(async () => {
        const before = snapshot?.gain;
        if (!before || !known || before.historyId == null || !before.historyEpoch) throw new Error('Unverified history');
        await confirmOutputGain(await gainCommand({action: redo ? 'redo_history' : 'undo_history', id: before.historyId, revision: before.revision, epoch: before.historyEpoch}));
    });
    const rows = [
        { key: 'nr' as const, undo: !!snapshot?.noise.noiseUndoToken, redo: !!snapshot?.noise.noiseRedoToken, pending: snapshot?.noise.noisePending, open: onVoiceCheck },
        { key: 'builtin' as const, undo: !!snapshot?.builtin.undoToken, redo: !!snapshot?.builtin.redoToken, pending: snapshot?.builtin.pending },
        { key: 'gain' as const, undo: !!snapshot?.gain.undoAvailable && !!snapshot?.gain.historyEpoch, redo: !!snapshot?.gain.redoAvailable && !!snapshot?.gain.historyEpoch, pending: !snapshot?.gain.settled },
    ];
    return <section aria-label={t('history.current')} className="space-y-2 my-3">
        <h3 className="font-semibold">{t('history.current')}</h3><p className="text-xs">{t('history.scope')}</p>
        <button type="button" disabled={busy || !eventsReady} className="rounded border p-2" onClick={() => void run()}>{t('history.inspect')}</button>
        <ul className="space-y-3">{rows.map(row => <li key={row.key} className="rounded border p-2 space-y-2">
            <p>{t(`history.${row.key}`)}: <span role="status">{t(!known || row.pending ? 'history.pending' : snapshot?.protected ? 'history.protected' : row.undo ? 'history.undoReady' : row.redo ? 'history.redoReady' : 'history.none')}</span></p>
            {row.key === 'nr' ? row.open && <button type="button" className="rounded border p-2" onClick={row.open}>{t('history.openNR')}</button> : <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || !known || snapshot?.protected || row.pending || !row.undo} className="rounded border p-2 disabled:opacity-50" onClick={() => void (row.key === 'builtin' ? builtinChange(false) : gainChange(false))}>{t('history.undo')}</button>
                <button type="button" disabled={busy || !known || snapshot?.protected || row.pending || !row.redo} className="rounded border p-2 disabled:opacity-50" onClick={() => void (row.key === 'builtin' ? builtinChange(true) : gainChange(true))}>{t('history.redo')}</button>
            </div>}
        </li>)}</ul>
    </section>;
}

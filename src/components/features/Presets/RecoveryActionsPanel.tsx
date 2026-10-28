import { obsApi } from '@/api/obs';
import type { MessageKey } from '@/i18n/messages';
import { AdjustmentHistoryPanel } from './AdjustmentHistoryPanel';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { useMessages } from '@/i18n/LocaleProvider';
import type { BundleOperation, BundleResult } from '@/api/bundles';
import { BroadcastBundlePanel } from './BroadcastBundlePanel';

export function RecoveryActionsPanel({ onOperation, onVoiceCheck, onSettings }: {
    onOperation?: (request: BundleOperation) => Promise<BundleResult | null>;
    onVoiceCheck?: () => void; onSettings?: () => void;
}) {
    const t = useMessages();
    const [stream, setStream] = useState<'unknown' | 'running' | 'stopped' | 'failed'>('unknown');
    const [diagnostics, setDiagnostics] = useState<MessageKey[]>([]);
    const [busy, setBusy] = useState(false);
    const [eventsReady, setEventsReady] = useState(false);
    const alive = useRef(false);
    const generation = useRef(0);
    const pending = useRef(false);
    useEffect(() => {
        alive.current = true; setEventsReady(false);
        let active = true;
        const invalidate = () => {
            if (!active) return;
            generation.current++;
            setStream('unknown'); setDiagnostics([]);
        };
        const hidden = () => { if (document.hidden) invalidate(); };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error']
            .map(event => listen(event, invalidate));
        void Promise.all(subscriptions).then(() => { if (active) setEventsReady(true); }).catch(() => { if (active) { invalidate(); setEventsReady(false); } });
        document.addEventListener('visibilitychange', hidden);
        return () => {
            active = false; alive.current = false; generation.current++;
            document.removeEventListener('visibilitychange', hidden);
            subscriptions.forEach(subscription => { void subscription.then(unlisten => unlisten()).catch(() => {}); });
        };
    }, []);
    const inspect = async () => {
        if (!alive.current || !eventsReady || pending.current || document.hidden) return;
        pending.current = true;
        const version = ++generation.current;
        const current = () => alive.current && version === generation.current && !document.hidden;
        setBusy(true); setStream('unknown'); setDiagnostics([]);
        try {
            const state = await audioApi.getAudioStreamState();
            if (current()) setStream(state.streamFailed ? 'failed' : state.running ? 'running' : 'stopped');
            const notes: MessageKey[] = [];
            try {
                const observed = await audioApi.getAudioState();
                if (observed && !observed.config?.host) notes.push('history.unconfigured');
                else if (observed?.config) {
                    const config = observed.config;
                    const devices = await audioApi.getDevices();
                    const matches = (items: typeof devices.inputs, name: string | null | undefined) => items.filter(d => d.name === name && d.host.toLowerCase() === config.host.toLowerCase()).length === 1;
                    if (!matches(devices.inputs, config.input) || !matches(devices.outputs, config.output)) notes.push('history.deviceUnknown');
                }
            } catch { notes.push('history.detailsUnknown'); }
            try {
                if (localStorage.getItem('vst_host_session_restore_protected') === 'true') notes.push('history.pluginProtected');
                if (localStorage.getItem('vst_host_setup_goal') === 'obs' && await obsApi.connectionStatus() === false) notes.push('history.obsDisconnected');
            } catch { notes.push('history.detailsUnknown'); }
            if (current()) setDiagnostics(notes);
        } catch { if (current()) setStream('unknown'); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
    };
    return <section className="min-h-0 overflow-y-auto p-4 space-y-4 text-sm" aria-label={t('recoveryHub.title')}>
        <details className="border rounded p-3"><summary className="cursor-pointer font-medium">{t('recovery.undoTitle')}</summary>
            <p className="my-2 text-xs">{t('recovery.undoScope')}</p>
            <AdjustmentHistoryPanel onVoiceCheck={onVoiceCheck} />
            <ul className="my-3 list-disc space-y-2 pl-5 text-xs">
                {(['nr', 'builtin', 'gain', 'profile', 'bundle', 'monitor'] as const).map(item => <li key={item}>{t(`recovery.undo.${item}`)}</li>)}
            </ul>
            {onVoiceCheck && <button type="button" className="border rounded p-2" onClick={onVoiceCheck}>{t('recovery.openVoice')}</button>}
        </details>
        <details className="border rounded p-3"><summary className="cursor-pointer font-medium">{t('recovery.checkedTitle')}</summary>
            <p className="my-2 text-xs">{t('recovery.checkedInstructions')}</p>
            <BroadcastBundlePanel checkedOnly onOperation={onOperation} />
        </details>
        <details className="border rounded p-3"><summary className="cursor-pointer font-medium">{t('recovery.failureTitle')}</summary>
            <p className="my-2 text-xs">{t('recovery.failureScope')}</p>
            <button type="button" className="border rounded p-2" disabled={busy || !eventsReady} onClick={() => void inspect()}>{t('recovery.inspect')}</button>
            <p role="status" className="my-2">{t(`recovery.state.${stream}`)}</p>
            {diagnostics.map((key, index) => <p key={index} className="text-xs text-warning">{t(key)}</p>)}
            <p className="text-xs">{t('recovery.receiverUnknown')}</p>
            {onSettings && <button type="button" className="border rounded p-2 mt-2" onClick={onSettings}>{t('recovery.openSettings')}</button>}
        </details>
    </section>;
}

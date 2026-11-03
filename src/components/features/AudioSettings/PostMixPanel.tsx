import { useEffect, useRef, useState } from 'react';
import { audioApi, type VstPlugin } from '@/api/audio';
import { postMixApi, type PostMixRequest, type PostMixSnapshot } from '@/api/postMix';
import { useMessages } from '@/i18n/LocaleProvider';

type Change = Exclude<PostMixRequest, { action: 'snapshot' }>;
type Action = Change extends infer C ? C extends Change ? Omit<C, 'expectedEpoch' | 'expectedRevision'> : never : never;
export function PostMixPanel({ mainRunning, hasMixing = true, disabled = false }: { mainRunning: boolean; hasMixing?: boolean; disabled?: boolean }) {
    const t = useMessages();
    const [open, setOpen] = useState(false);
    const [snapshot, setSnapshot] = useState<PostMixSnapshot | null>(null);
    const [busy, setBusy] = useState(false);
    const [stale, setStale] = useState(false);
    const [error, setError] = useState(false);
    const [resetConfirmed, setResetConfirmed] = useState(false);
    const [resetDone, setResetDone] = useState(false);
    const [available, setAvailable] = useState<VstPlugin[]>([]);
    const [path, setPath] = useState('');
    const [gains, setGains] = useState<Record<string, number>>({});
    const panel = useRef<HTMLDetailsElement>(null);
    const seq = useRef(0), busyRef = useRef(false), staleRef = useRef(false);
    const witness = useRef<{ epoch: string; revision: string } | null>(null);
    useEffect(() => () => { seq.current++; }, []);
    useEffect(() => {
        if (!open || !snapshot) return;
        let active = true, reading = false;
        const timer = setInterval(async () => {
            if (!active || reading || busyRef.current || document.hidden || !panel.current?.getClientRects().length) return;
            reading = true; const ticket = seq.current;
            try {
                const next = await postMixApi.request({ action: 'snapshot' });
                if (active && ticket === seq.current) {
                    if (witness.current && (witness.current.epoch !== next.epoch || witness.current.revision !== next.revision)) { staleRef.current = true; setStale(true); }
                    setSnapshot(next);
                }
            } catch { if (active && ticket === seq.current) setError(true); }
            finally { reading = false; }
        }, 1000);
        return () => { active = false; clearInterval(timer); };
    }, [open, !!snapshot]);
    async function run(action: Action | { action: 'snapshot' }) {
        if (busyRef.current || disabled || (action.action !== 'snapshot' && (!witness.current || staleRef.current))) return;
        if (mainRunning && ['enable', 'restore_saved', 'add', 'remove', 'reorder', 'reload', 'reset'].includes(action.action)) return;
        if (action.action === 'reset' && !resetConfirmed) return;
        const ticket = ++seq.current; busyRef.current = true; setBusy(true); setError(false); setResetDone(false);
        try {
            const request = action.action === 'snapshot' ? action : { ...action, expectedEpoch: witness.current!.epoch, expectedRevision: witness.current!.revision } as PostMixRequest;
            const next = await postMixApi.request(request);
            if (ticket !== seq.current) return;
            witness.current = { epoch: next.epoch, revision: next.revision }; staleRef.current = false; setStale(false); setSnapshot(next);
            if (['snapshot', 'reload', 'restore_saved', 'reset'].includes(action.action)) setGains(Object.fromEntries(next.plugins.map(plugin => [plugin.id, plugin.gain])));
            if (action.action === 'reset') { setResetConfirmed(false); setResetDone(true); setAvailable([]); setPath(''); }
        } catch { if (ticket === seq.current) setError(true); }
        finally { if (ticket === seq.current) { busyRef.current = false; setBusy(false); } }
    }
    async function scan() {
        if (busyRef.current || disabled || mainRunning) return;
        const ticket = ++seq.current; busyRef.current = true; setBusy(true); setError(false);
        try { const items = await audioApi.scanPlugins(); if (ticket === seq.current) { setAvailable(items); setPath(''); } }
        catch { if (ticket === seq.current) setError(true); }
        finally { if (ticket === seq.current) { busyRef.current = false; setBusy(false); } }
    }
    const editable = !disabled && !busy && !stale;
    const stopped = editable && !mainRunning;
    return <details ref={panel} className="space-y-3 rounded border border-border p-3" onToggle={e => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer font-semibold">{t('postMix.title')}</summary>
        <p className="text-sm">{t('postMix.scope')}</p>
        <button type="button" className="link-button" disabled={disabled || busy} onClick={() => void run({ action: 'snapshot' })}>{t('postMix.load')}</button>
        {snapshot && <div className="space-y-3 text-sm">
            {stale && <p role="alert">{t('postMix.stale')}</p>}
            <p>{t('postMix.transport', { frames: snapshot.transportLatencyFrames })}</p>
            <p>{t('postMix.declared', { frames: snapshot.declaredPluginLatencyFrames ?? t('postMix.unknown') })}</p>
            <p>{t('postMix.saved')}: {snapshot.savedPlugins.map(p => p.name).join(', ') || t('postMix.none')}</p>
            {!snapshot.restored && <p>{t('postMix.restoreNeeded')}</p>}
            <p>{t('postMix.stop')}</p>
            <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={!stopped} onClick={() => void run({ action: 'restore_saved' })}>{t('postMix.restore')}</button>{' '}
            <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={!stopped} onClick={() => void run({ action: 'reload' })}>{t('postMix.reload')}</button>
            <label className="block"><input type="checkbox" disabled={!stopped || (!snapshot.restored && !snapshot.enabled) || (!hasMixing && !snapshot.enabled)} checked={snapshot.enabled} onChange={e => void run({ action: 'enable', enabled: e.target.checked })} /> {t('postMix.enabled')}</label>
            <div><button type="button" className="border rounded p-2" disabled={!stopped} onClick={() => void scan()}>{t('postMix.scan')}</button>
                <label className="block">{t('postMix.select')}<select className="block w-full bg-background border rounded p-2" disabled={!stopped} value={path} onChange={e => setPath(e.target.value)}><option value="">{t('postMix.choose')}</option>{available.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}</select></label>
                <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={!stopped || !path} onClick={() => void run({ action: 'add', path })}>{t('postMix.add')}</button></div>
            <p>{t('postMix.current')}</p>
            {snapshot.plugins.map((plugin, index) => <fieldset key={plugin.id} className="space-y-2 border border-border rounded p-2"><legend>{plugin.name}</legend>
                <label><input type="checkbox" disabled={!editable} checked={!plugin.enabled} onChange={e => void run({ action: 'bypass', id: plugin.id, active: e.target.checked })} /> {t('postMix.bypass')}</label>{' '}
                <label><input type="checkbox" disabled={!editable} checked={plugin.muted} onChange={e => void run({ action: 'mute', id: plugin.id, active: e.target.checked })} /> {t('postMix.mute')}</label>{' '}
                <label>{t('postMix.gain')} <input type="number" min="0" max="2" step="0.01" className="w-20 bg-background border rounded" disabled={!editable} value={gains[plugin.id] ?? plugin.gain} onChange={e => setGains({ ...gains, [plugin.id]: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>{' '}
                <button type="button" className="border rounded p-1 disabled:opacity-50" disabled={!editable || !Number.isFinite(gains[plugin.id] ?? plugin.gain) || (gains[plugin.id] ?? plugin.gain) < 0 || (gains[plugin.id] ?? plugin.gain) > 2} onClick={() => void run({ action: 'gain', id: plugin.id, value: gains[plugin.id] ?? plugin.gain })}>{t('postMix.applyGain')}</button>{' '}
                <button type="button" className="border rounded p-1" disabled={!editable} onClick={() => void run({ action: 'editor', id: plugin.id })}>{t('postMix.editor')}</button>{' '}
                <button type="button" className="border rounded p-1" disabled={!stopped} onClick={() => void run({ action: 'remove', id: plugin.id })}>{t('postMix.remove')}</button>{' '}
                {([-1, 1] as const).map(delta => <button key={delta} type="button" className="border rounded p-1" disabled={!stopped || index + delta < 0 || index + delta >= snapshot.plugins.length} onClick={() => { const ids = snapshot.plugins.map(p => p.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]; void run({ action: 'reorder', ids }); }}>{t(delta < 0 ? 'postMix.up' : 'postMix.down')}</button>)}
            </fieldset>)}
            <button type="button" className="border rounded p-2" disabled={!editable || !snapshot.restored} onClick={() => void run({ action: 'save' })}>{t('postMix.save')}</button>
            <details className="space-y-2 border border-border rounded p-2"><summary>{t('postMix.recovery')}</summary><p>{t('postMix.recoveryHelp')}</p><label className="flex gap-2"><input type="checkbox" disabled={!stopped} checked={resetConfirmed} onChange={e => setResetConfirmed(e.target.checked)} />{t('postMix.recoveryConfirm')}</label><button type="button" className="border rounded p-2" disabled={!stopped || !resetConfirmed} onClick={() => void run({ action: 'reset' })}>{t('postMix.reset')}</button>{resetDone && <p role="status">{t('postMix.resetDone')}</p>}</details>
        </div>}
        {(error || snapshot?.error) && <p role="alert" className="text-destructive-text text-sm">{t('postMix.error')}</p>}
    </details>;
}

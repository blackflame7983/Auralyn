import { useEffect, useRef, useState } from 'react';
import { audioApi, type AudioDevice } from '@/api/audio';
import { liveOutputApi } from '@/api/liveOutput';
import { mixingApi, type MixConfig, type MixLevels, type MixSnapshot } from '@/api/mixing';
import type { ProcessInputCandidate } from '@/lib/inputSource';
import { useMessages } from '@/i18n/LocaleProvider';

const initialLevels = (): MixLevels => ({ voice: { gain: 1, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 });

export function MixingPanel({ inputs, primaryInputId, primaryIsVoiceDevice, disabled = false, onBusyChange }: { inputs: AudioDevice[]; primaryInputId?: string; primaryIsVoiceDevice: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
    const t = useMessages();
    const [open, setOpen] = useState(false);
    const [snapshot, setSnapshot] = useState<MixSnapshot | null>(null);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const sequence = useRef(0);
    const witness = useRef<{ epoch: string; revision: string } | null>(null);
    const staleRef = useRef(false);
    const [stale, setStale] = useState(false);
    const panel = useRef<HTMLDetailsElement>(null);
    useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
    const [error, setError] = useState(false);
    const [kind, setKind] = useState<'device' | 'process'>('device');
    const [device, setDevice] = useState('');
    const [channels, setChannels] = useState<[number, number]>([0, 1]);
    const [apps, setApps] = useState<ProcessInputCandidate[]>([]);
    const [candidate, setCandidate] = useState('');
    const [route, setRoute] = useState('');
    const [levels, setLevels] = useState<MixLevels>(initialLevels);
    const [confirmed, setConfirmed] = useState(false);
    const [resetConfirmed, setResetConfirmed] = useState(false);
    const [resetSuccess, setResetSuccess] = useState(false);
    const selected = apps.find(a => a.id === candidate);
    const routes = selected?.routes ?? [];
    const devices = inputs.filter(d => d.host.toLowerCase() === 'wasapi' && d.id && d.id !== primaryInputId && d.channels > 0);
    const selectedDevice = devices.find(d => d.id === device);
    const validDevice = !!selectedDevice && channels.every(c => Number.isInteger(c) && c >= 0 && c < Math.min(selectedDevice.channels, 256));
    const validProcess = !!selected && !!route && routes.some(r => r.id === route && r.muted);
    const validLevels = [levels.voice.gain, levels.accompaniment.gain].every(n => Number.isFinite(n) && n >= 0 && n <= 2) && Number.isInteger(levels.offsetMs) && Math.abs(levels.offsetMs) <= 2000;
    const editable = !disabled && !busy;
    useEffect(() => () => { sequence.current++; }, []);
    useEffect(() => {
        if (!open || !snapshot) return;
        let active = true; let reading = false;
        const timer = setInterval(async () => {
            if (!active || reading || busyRef.current || document.hidden || !panel.current?.getClientRects().length) return;
            reading = true; const ticket = sequence.current;
            try {
                const next = await mixingApi.request({ action: 'snapshot' });
                if (active && ticket === sequence.current) {
                    if (witness.current && (next.epoch !== witness.current.epoch || next.revision !== witness.current.revision)) { staleRef.current = true; setStale(true); }
                    setSnapshot(next);
                }
            }
            catch { if (active && ticket === sequence.current) setError(true); }
            finally { reading = false; }
        }, 1000);
        return () => { active = false; clearInterval(timer); };
    }, [open, !!snapshot]);
    async function run(action: 'snapshot' | 'reload' | 'reset' | 'configure' | 'disable' | 'levels') {
        if (busyRef.current || disabled) return;
        const current = snapshot;
        if (action !== 'snapshot' && (!current || !witness.current || staleRef.current)) return;
        if (action === 'reset' && (!resetConfirmed || current?.running)) return;
        const ticket = ++sequence.current; busyRef.current = true; setBusy(true); setError(false); setResetSuccess(false);
        try {
            let next: MixSnapshot;
            if (action === 'snapshot') {
                const [mix, output] = await Promise.all([mixingApi.request({ action: 'snapshot' }), liveOutputApi.request()]);
                if (ticket !== sequence.current) return;
                next = mix; setReady(!!output.config.deviceId && !!output.config.splitProcessing);
            } else {
                const expected = { expectedEpoch: witness.current!.epoch, expectedRevision: witness.current!.revision };
                if (action === 'reload' || action === 'reset') next = await mixingApi.request({ action, ...expected });
                else if (action === 'levels') next = await mixingApi.request({ action, ...expected, levels });
                else {
                    const config: MixConfig | null = action === 'disable' ? null : { version: 1, levels, source: kind === 'device' ? { kind: 'device', config: { host: 'WASAPI', inputId: device, inputChannels: channels } } : { kind: 'process_loopback', config: { appKey: selected!.appKey, appName: selected!.name, rawEndpointId: route, purpose: 'music' } } };
                    next = await mixingApi.request({ action: 'configure', ...expected, config, ...(config?.source.kind === 'process_loopback' ? { candidateId: candidate } : {}) });
                }
            }
            if (ticket !== sequence.current) return;
            if (action === 'reset' && (next.config || next.savedConfig || next.error)) throw new Error('reset did not clear settings');
            witness.current = { epoch: next.epoch, revision: next.revision };
            staleRef.current = false; setStale(false);
            setSnapshot(next); setConfirmed(false);
            if (action === 'snapshot' || action === 'reload' || action === 'reset') {
                const source = (next.config ?? next.savedConfig)?.source;
                setLevels((next.config ?? next.savedConfig)?.levels ?? initialLevels());
                setKind(source?.kind === 'process_loopback' ? 'process' : 'device');
                setDevice(source?.kind === 'device' ? source.config.inputId : '');
                setChannels(source?.kind === 'device' ? source.config.inputChannels : [0, 1]);
                setCandidate(''); setRoute('');
                if (action === 'reset') { setApps([]); setResetConfirmed(false); setResetSuccess(true); }
            }
        } catch { if (ticket === sequence.current) setError(true); }
        finally { if (ticket === sequence.current) { busyRef.current = false; setBusy(false); } }
    }
    async function refreshApps() {
        if (busyRef.current) return;
        const ticket = ++sequence.current; busyRef.current = true; setBusy(true); setError(false);
        try {
            const result = await audioApi.processInputSources();
            if (ticket !== sequence.current) return;
            setApps(result);
            const old = apps.find(a => a.id === candidate);
            const same = result.find(a => a.id === candidate && a.appKey === old?.appKey && a.name === old?.name);
            if (!same) { setCandidate(''); setRoute(''); }
            else if (!same.routes.some(r => r.id === route && r.muted)) setRoute('');
        } catch { if (ticket === sequence.current) setError(true); }
        finally { if (ticket === sequence.current) { busyRef.current = false; setBusy(false); } }
    }
    const describe = (config: MixConfig | null) => {
        if (!config) return t('mixing.none');
        const source = config.source;
        return source.kind === 'device' ? devices.find(d => d.id === source.config.inputId)?.name ?? source.config.inputId : source.config.appName;
    };
    return <details ref={panel} className="rounded border border-border p-3 space-y-3" onToggle={e => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer font-semibold">{t('mixing.title')}</summary>
        <button type="button" className="link-button" disabled={!editable} onClick={() => void run('snapshot')}>{t('mixing.load')}</button>
        {snapshot && <div className="space-y-3 text-sm">
            <p>{ready ? t('mixing.ready') : t('mixing.notReady')}</p>
            {stale && <p role="alert">{t('mixing.stale')}</p>}
            {!primaryIsVoiceDevice && <p>{t('mixing.primary')}</p>}
            <p>{t('mixing.current')}: {describe(snapshot.config)}</p><p>{t('mixing.saved')}: {describe(snapshot.savedConfig)}</p>
            {JSON.stringify(snapshot.config) !== JSON.stringify(snapshot.savedConfig) && <p>{t('mixing.changed')}</p>}
            <button type="button" className="link-button" disabled={!editable || snapshot.running || stale} onClick={() => void run('reload')}>{t('mixing.reload')}</button>
            <details className="space-y-2 rounded border border-border p-2">
                <summary className="cursor-pointer font-medium">{t('mixing.recoveryTitle')}</summary>
                <p>{t('mixing.recoveryHelp')}</p>
                <label className="flex gap-2"><input type="checkbox" disabled={!editable || snapshot.running || stale} checked={resetConfirmed} onChange={e => setResetConfirmed(e.target.checked)} />{t('mixing.recoveryConfirm')}</label>
                <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={!editable || snapshot.running || stale || !resetConfirmed} onClick={() => void run('reset')}>{t('mixing.recoveryAction')}</button>
                {resetSuccess && <p role="status">{t('mixing.recoverySuccess')}</p>}
            </details>
            <p>{t('mixing.stopped')}</p>
            <fieldset disabled={!editable || snapshot.running} className="space-y-2">
                <label className="block">{t('mixing.source')}<select className="block w-full bg-background border rounded p-2" value={kind} onChange={e => { setKind(e.target.value as 'device' | 'process'); setConfirmed(false); }}><option value="device">{t('mixing.device')}</option><option value="process">{t('mixing.process')}</option></select></label>
                {kind === 'device' ? <><label className="block">{t('mixing.chooseDevice')}<select className="block w-full bg-background border rounded p-2" value={device} onChange={e => { setDevice(e.target.value); setChannels([0, 0]); setConfirmed(false); }}><option value="">{t('mixing.chooseDevice')}</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><fieldset><legend>{t('mixing.channels')}</legend>{([0, 1] as const).map(i => <label key={i}>{t(i ? 'mixing.right' : 'mixing.left')} <input type="number" min="0" max={Math.min((selectedDevice?.channels ?? 1) - 1, 255)} value={channels[i]} onChange={e => { const value = Number(e.target.value); setChannels(i === 0 ? [value, channels[1]] : [channels[0], value]); setConfirmed(false); }} className="w-20 bg-background border rounded" /> </label>)}</fieldset></> : <><p>{t('mixing.routeHelp')}</p><button type="button" className="border rounded p-2" onClick={() => void refreshApps()}>{t('mixing.refreshApps')}</button><label className="block">{t('mixing.chooseApp')}<select className="block w-full bg-background border rounded p-2" value={candidate} onChange={e => { setCandidate(e.target.value); setRoute(''); setConfirmed(false); }}><option value="">{t('mixing.chooseApp')}</option>{apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="block">{t('mixing.chooseRoute')}<select className="block w-full bg-background border rounded p-2" value={route} onChange={e => { setRoute(e.target.value); setConfirmed(false); }}><option value="">{t('mixing.chooseRoute')}</option>{routes.map(r => <option key={r.id} value={r.id}>{r.name} ({t(r.muted ? 'mixing.muted' : 'mixing.unmuted')})</option>)}</select></label></>}
                <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('mixing.confirm')}</label>
                <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={stale || !ready || !primaryIsVoiceDevice || !confirmed || !validLevels || !(kind === 'device' ? validDevice : validProcess)} onClick={() => void run('configure')}>{t('mixing.save')}</button>{' '}
                <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={stale} onClick={() => void run('disable')}>{t('mixing.disable')}</button>
            </fieldset>
            {(['voice', 'accompaniment'] as const).map(key => <fieldset key={key}><legend>{t(key === 'voice' ? 'mixing.voice' : 'mixing.accompaniment')}</legend><label>{t('mixing.gain')} <input type="number" min="0" max="2" step="0.01" className="w-20 bg-background border rounded" disabled={!editable} value={levels[key].gain} onChange={e => setLevels({ ...levels, [key]: { ...levels[key], gain: e.target.value === '' ? NaN : Number(e.target.value) } })} /></label>{' '}<label><input type="checkbox" disabled={!editable} checked={levels[key].muted} onChange={e => setLevels({ ...levels, [key]: { ...levels[key], muted: e.target.checked } })} /> {t('mixing.mute')}</label></fieldset>)}
            <label className="block"><input type="checkbox" disabled={!editable} checked={levels.monitorAccompaniment} onChange={e => setLevels({ ...levels, monitorAccompaniment: e.target.checked })} /> {t('mixing.monitor')}</label>
            <label className="block">{t('mixing.offset')} <input type="number" min="-2000" max="2000" step="1" className="w-24 bg-background border rounded" disabled={!editable} value={levels.offsetMs} onChange={e => setLevels({ ...levels, offsetMs: e.target.value === '' ? NaN : Number(e.target.value) })} /></label><p>{t('mixing.offsetHelp')}</p>
            <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={!editable || stale || !snapshot.config || !validLevels} onClick={() => void run('levels')}>{t('mixing.applyLevels')}</button>
            <p>{t('mixing.known', { frames: snapshot.knownVoiceProcessingFrames ?? t('mixing.unknown') })}</p><p>{t('mixing.manual', { ms: snapshot.config?.levels.offsetMs ?? 0 })}</p>
            <p>{t('mixing.meter')}: {t('mixing.voice')} {Math.max(...snapshot.voicePeak).toFixed(2)} / {t('mixing.accompaniment')} {Math.max(...snapshot.accompanimentPeak).toFixed(2)} / Mix {Math.max(...snapshot.mixPeak).toFixed(2)}</p>
            {snapshot.accompaniment?.failed ? <p role="alert">{t('mixing.accompanimentFailed')}</p> : snapshot.accompaniment?.waitingForAudio && <p role="status">{t('mixing.waiting')}</p>}
            {snapshot.pending && <p role="status">{t('mixing.pending')}</p>}{snapshot.failed && <p role="alert">{t('mixing.engineFailed')}</p>}
        </div>}
        {(error || snapshot?.error) && <p role="alert" className="text-destructive-text text-sm">{t('mixing.failed')}</p>}
    </details>;
}

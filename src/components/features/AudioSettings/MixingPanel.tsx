import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { useEffect, useId, useRef, useState } from 'react';
import { audioApi, type AudioDevice } from '@/api/audio';
import { liveOutputApi } from '@/api/liveOutput';
import { mixingApi, type MixConfig, type MixLevels } from '@/api/mixing';
import type { ProcessInputCandidate } from '@/lib/inputSource';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import { Button } from '@/components/ui/button';
import { GainControl, MixingError, framesToMs, mixingCard, useQueuedChange, useRevisionedResource } from './mixingUi';

const initialLevels = (): MixLevels => ({ voice: { gain: 1, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 });
const validMixLevels = (value: MixLevels) => [value.voice.gain, value.accompaniment.gain].every(n => Number.isFinite(n) && n >= 0 && n <= 2)
    && Number.isInteger(value.offsetMs) && Math.abs(value.offsetMs) <= 2000;
export function MixingPanel({ inputs, primaryInputId, primaryIsVoiceDevice, disabled = false, onBusyChange, onNavigate, initiallyOpen = false }: {
    inputs: AudioDevice[]; primaryInputId?: string; primaryIsVoiceDevice: boolean; disabled?: boolean;
    onBusyChange?: (busy: boolean) => void; onNavigate?: (target: 'output' | 'input') => void; initiallyOpen?: boolean;
}) {
    const t = useMessages(), reasonId = useId();
    const [open, setOpen] = useState(initiallyOpen), panel = useRef<HTMLDetailsElement>(null);
    const [ready, setReady] = useState(false);
    const resource = useRevisionedResource(async () => {
        const [mix, output] = await Promise.all([mixingApi.request({ action: 'snapshot' }), liveOutputApi.request()]);
        setReady(!!output.config.deviceId && !!output.config.splitProcessing); return mix;
    }, open, () => !!panel.current?.getClientRects().length);
    const { snapshot, busy, stale, error } = resource;
    useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
    const [kind, setKind] = useState<'device' | 'process'>('device'), [device, setDevice] = useState('');
    const [channels, setChannels] = useState<[number, number]>([0, 1]);
    const [apps, setApps] = useState<ProcessInputCandidate[]>([]), [candidate, setCandidate] = useState(''), [route, setRoute] = useState('');
    const [levels, setLevels] = useState<MixLevels>(initialLevels), levelsRef = useRef(levels); levelsRef.current = levels;
    const dirty = useRef(false), initialized = useRef(false), attempted = useRef(false);
    const [confirmedRoute, setConfirmedRoute] = useState(''), [resetConfirmed, setResetConfirmed] = useState(false), [resetSuccess, setResetSuccess] = useState(false);
    const selected = apps.find(a => a.id === candidate), routes = selected?.routes ?? [];
    const devices = inputs.filter(d => d.host.toLowerCase() === 'wasapi' && d.id && d.id !== primaryInputId && d.channels > 0);
    const selectedDevice = devices.find(d => d.id === device);
    const pairs = Array.from({ length: Math.ceil(Math.min(selectedDevice?.channels ?? 0, 256) / 2) }, (_, i): [number, number] => [i * 2, Math.min(i * 2 + 1, (selectedDevice?.channels ?? 1) - 1)]);
    const validDevice = !!selectedDevice && pairs.some(p => p[0] === channels[0] && p[1] === channels[1]);
    const validProcess = !!selected && !!route && routes.some(r => r.id === route && r.muted);
    const routeKey = JSON.stringify([primaryInputId, kind, kind === 'device' ? [device, channels] : [selected?.appKey, candidate, route]]);
    const confirmed = confirmedRoute === routeKey;
    const validLevels = validMixLevels(levels);
    const editable = !disabled && !busy;
    // 適用中の機器経路は確認済みとして扱い、同じ経路の再適用で確認を求めない。
    const draftFrom = (config: MixConfig | null, active = false) => {
        const source = config?.source; setLevels(config?.levels ?? initialLevels());
        setKind(source?.kind === 'process_loopback' ? 'process' : 'device');
        setDevice(source?.kind === 'device' ? source.config.inputId : ''); setChannels(source?.kind === 'device' ? source.config.inputChannels : [0, 1]);
        setCandidate(''); setRoute(''); dirty.current = false; initialized.current = true;
        setConfirmedRoute(active && source?.kind === 'device' ? JSON.stringify([primaryInputId, 'device', [source.config.inputId, source.config.inputChannels]]) : '');
    };
    async function read() { const next = await resource.run('mixingUi.read'); if (next && !dirty.current && !initialized.current) draftFrom(next.config ?? next.savedConfig, !!next.config); }
    useEffect(() => { if (open && !attempted.current && !disabled) { attempted.current = true; void read(); } return () => { attempted.current = false; }; }, [open, disabled]);
    async function run(action: 'reload' | 'reset' | 'configure' | 'disable' | 'levels', value = levelsRef.current) {
        if (disabled || (action === 'reset' && (!resetConfirmed || snapshot?.running)) || ((action === 'levels' || action === 'configure') && !validMixLevels(value))) return null;
        setResetSuccess(false);
        const operation: MessageKey = action === 'levels' ? 'mixingUi.levels' : action === 'configure' ? 'mixing.save' : action === 'disable' ? 'mixing.disable' : action === 'reset' ? 'mixing.recoveryAction' : 'mixing.reload';
        const next = await resource.run(operation, async witness => {
            const expected = { expectedEpoch: witness.epoch, expectedRevision: witness.revision };
            if (action === 'reload' || action === 'reset') {
                const result = await mixingApi.request({ action, ...expected });
                if (action === 'reset' && (result.config || result.savedConfig || result.error)) throw new Error('reset did not clear settings');
                return result;
            }
            if (action === 'levels') return mixingApi.request({ action, ...expected, levels: value });
            const config: MixConfig | null = action === 'disable' ? null : { version: 1, levels: value, source: kind === 'device' ? { kind: 'device', config: { host: 'WASAPI', inputId: device, inputChannels: channels } } : { kind: 'process_loopback', config: { appKey: selected!.appKey, appName: selected!.name, rawEndpointId: route, purpose: 'music' } } };
            return mixingApi.request({ action: 'configure', ...expected, config, ...(config?.source.kind === 'process_loopback' ? { candidateId: candidate } : {}) });
        });
        if (next && !next.error) {
            if (action === 'reload' || action === 'reset') draftFrom(next.config ?? next.savedConfig, !!next.config);
            if (action === 'reset') { setApps([]); setResetConfirmed(false); setResetSuccess(true); }
            window.dispatchEvent(new Event('mixing-settings-changed'));
        }
        return next?.error ? null : next;
    }
    const queue = useQueuedChange<MixLevels>(value => run('levels', value));
    useEffect(() => { if (stale || !open) queue.cancel(); }, [stale, open]);
    const changeLevels = (value: MixLevels) => {
        dirty.current = true; setLevels(value); levelsRef.current = value;
        // 時間差の編集中も下書きは保持し、不正な値を別の音量操作へ混ぜて送らない。
        if (snapshot?.config && !stale && validMixLevels(value)) queue.enqueue(value);
        else queue.cancel();
    };
    async function refreshApps() {
        try { const result = await audioApi.processInputSources(); setApps(result);
            const old = apps.find(a => a.id === candidate), same = result.find(a => a.id === candidate && a.appKey === old?.appKey && a.name === old?.name);
            if (!same) { setCandidate(''); setRoute(''); setConfirmedRoute(''); }
            else if (!same.routes.some(r => r.id === route && r.muted)) { setRoute(''); setConfirmedRoute(''); }
        } catch (e) { resource.report('mixing.refreshApps', e); }
    }
    const mark = () => { dirty.current = true; setConfirmedRoute(''); };
    const describe = (config: MixConfig | null) => !config ? t('mixing.none') : config.source.kind === 'device' ? inputs.find(d => d.id === (config.source.kind === 'device' ? config.source.config.inputId : ''))?.name ?? t('mixing.device') : config.source.config.appName;
    const reason: MessageKey | null = busy ? 'mixingUi.busy' : disabled ? 'mixingUi.busy' : !snapshot ? 'mixingUi.needsRead' : stale ? 'mixing.stale' : snapshot.running ? 'mixing.stopped' : !ready ? 'mixing.notReady' : !primaryIsVoiceDevice ? 'mixing.primary' : !validLevels ? 'mixingUi.invalidLevels' : kind === 'device' && !validDevice ? 'mixingUi.invalidDevice' : kind === 'process' && !selected ? 'mixingUi.chooseApp' : kind === 'process' && !validProcess ? 'mixingUi.routeMuted' : !confirmed ? 'mixingUi.confirmRoute' : null;
    const disableReason = busy || disabled ? 'mixingUi.busy' : stale ? 'mixing.stale' : snapshot?.running ? 'mixing.stopped' : null;
    return <details id="mixing-settings" ref={panel} open={open} className={mixingCard} onToggle={e => setOpen(e.currentTarget.open)}>
        <summary tabIndex={0} className="cursor-pointer text-ui-heading font-semibold">{t('mixing.title')}</summary>
        <Button  variant="outline" size="sm" disabled={!editable} onClick={() => void read()}>{t('mixing.load')}</Button>
        {snapshot && <div className="space-y-4 text-ui-support">
            {stale && <p role="alert">{t('mixing.stale')}</p>}
            {!ready && <div><p>{t('mixing.notReady')}</p><Button  variant="outline" size="sm" onClick={() => onNavigate?.('output')}>{t('mixingUi.openOutput')}</Button></div>}
            {!primaryIsVoiceDevice && <div><p>{t('mixing.primary')}</p><Button  variant="outline" size="sm" onClick={() => onNavigate?.('input')}>{t('mixingUi.openInput')}</Button></div>}
            <div className="rounded-control bg-muted/40 p-3"><h4 className="text-ui-control font-semibold">{t('mixingUi.active')}</h4><p>{t('mixing.current')}: {describe(snapshot.config)}</p>
                {JSON.stringify(snapshot.config) !== JSON.stringify(snapshot.savedConfig) && <p>{t('mixing.changed')} {t('mixing.saved')}: {describe(snapshot.savedConfig)}</p>}</div>
            <h4 className="text-ui-control font-semibold">{t('mixingUi.draft')}</h4>
            <Button variant="outline" size="sm" className="h-auto whitespace-normal" disabled={!editable || snapshot.running || stale} onClick={() => void run('reload')}>{t('mixing.reload')}</Button>
            {snapshot.running && <p>{t('mixing.stopped')}</p>}
            <fieldset disabled={!editable || snapshot.running} className="space-y-3">
                <Field label={t('mixing.source')}><Select  value={kind} onChange={e => { mark(); setKind(e.target.value as 'device' | 'process'); }}><option value="device">{t('mixing.device')}</option><option value="process">{t('mixing.process')}</option></Select></Field>
                {kind === 'device' ? <><Field label={t('mixing.chooseDevice')}><Select  value={device} onChange={e => { mark(); setDevice(e.target.value); const d = devices.find(d => d.id === e.target.value); setChannels([0, d && d.channels > 1 ? 1 : 0]); }}><option value="">{t('mixing.chooseDevice')}</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
                    <Field label={t('mixing.channels')}><Select  disabled={!selectedDevice} value={validDevice ? channels.join(',') : ''} onChange={e => { mark(); setChannels(e.target.value.split(',').map(Number) as [number, number]); }}>
                        {!validDevice && <option value="">{t('mixingUi.choosePair')}</option>}{pairs.map(p => <option key={p.join(',')} value={p.join(',')}>{p[0] === p[1] ? `${p[0] + 1}` : `${p[0] + 1}–${p[1] + 1}`}</option>)}</Select></Field></>
                : <><p className="text-ui-support text-muted-foreground">{t('mixing.routeHelp')}</p><Button  variant="outline" size="sm" onClick={() => void refreshApps()}>{t('mixing.refreshApps')}</Button>
                    <Field label={t('mixing.chooseApp')}><Select  value={candidate} onChange={e => { mark(); setCandidate(e.target.value); setRoute(''); }}><option value="">{t('mixing.chooseApp')}</option>{apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
                    <Field label={t('mixing.chooseRoute')}><Select  value={route} onChange={e => { mark(); setRoute(e.target.value); }}><option value="">{t('mixing.chooseRoute')}</option>{routes.map(r => <option key={r.id} value={r.id}>{r.name} ({t(r.muted ? 'mixing.muted' : 'mixing.unmuted')})</option>)}</Select></Field></>}
                {!confirmed && <label className="flex gap-2 text-ui-control"><Checkbox checked={false} onChange={e => setConfirmedRoute(e.target.checked ? routeKey : '')} />{t('mixing.confirm')}</label>}
            </fieldset>
            <div className="flex flex-wrap gap-2"><Button  disabled={!!reason} aria-describedby={reason ? reasonId : undefined} onClick={() => void run('configure')}>{t('mixing.save')}</Button>
                <Button variant="outline"  disabled={!!disableReason} aria-describedby={disableReason ? `${reasonId}-disable` : undefined} onClick={() => { queue.cancel(); void run('disable'); }}>{t('mixing.disable')}</Button></div>
            {reason && <p id={reasonId}>{t(reason)}</p>}{disableReason && <p id={`${reasonId}-disable`}>{t(disableReason)}</p>}
            {(['voice', 'accompaniment'] as const).map(key => <fieldset key={key} className="space-y-2"><legend className="text-ui-control font-semibold">{t(key === 'voice' ? 'mixing.voice' : 'mixing.accompaniment')}</legend>
                <GainControl settings label={t(key === 'voice' ? 'mixingUi.voiceVolume' : 'mixingUi.accompanimentVolume')} value={levels[key].gain} disabled={disabled || stale} onChange={gain => changeLevels({ ...levelsRef.current, [key]: { ...levelsRef.current[key], gain } })} />
                <label className="flex gap-2 text-ui-control"><Checkbox disabled={disabled || stale} checked={levels[key].muted} onChange={e => changeLevels({ ...levelsRef.current, [key]: { ...levelsRef.current[key], muted: e.target.checked } })} />{t('mixing.mute')}</label></fieldset>)}
            <label className="flex gap-2 text-ui-control"><Checkbox disabled={disabled || stale} checked={levels.monitorAccompaniment} onChange={e => changeLevels({ ...levelsRef.current, monitorAccompaniment: e.target.checked })} />{t('mixing.monitor')}</label>
            <Field label={t('mixing.offset')}><Input type="number" min="-2000" max="2000" step="1"  aria-invalid={!validLevels} aria-describedby={!validLevels ? `${reasonId}-levels` : undefined} disabled={disabled || stale} value={Number.isNaN(levels.offsetMs) ? '' : levels.offsetMs} onChange={e => changeLevels({ ...levelsRef.current, offsetMs: e.target.value === '' ? NaN : Number(e.target.value) })} /></Field>
            {!validLevels && <p id={`${reasonId}-levels`} role="alert">{t('mixingUi.invalidLevels')}</p>}<p className="text-ui-support text-muted-foreground">{t('mixing.offsetHelp')}</p>
            <p>{t('mixingUi.knownMs', { value: framesToMs(snapshot.knownVoiceProcessingFrames, snapshot.primaryClock?.outputRateHz) ?? t('mixing.unknown') })}</p>
            <p>{t('mixing.meter')}: {t('mixing.voice')} {Math.max(...snapshot.voicePeak).toFixed(2)} / {t('mixing.accompaniment')} {Math.max(...snapshot.accompanimentPeak).toFixed(2)} / {t('mixingUi.mix')} {Math.max(...snapshot.mixPeak).toFixed(2)}</p>
            {snapshot.accompaniment?.failed ? <p role="alert">{t('mixing.accompanimentFailed')}</p> : snapshot.accompaniment?.waitingForAudio && <p role="status">{t('mixing.waiting')}</p>}
            {snapshot.pending && <p role="status">{t('mixing.pending')}</p>}{snapshot.failed && <p role="alert">{t('mixing.engineFailed')}</p>}
            <details className="space-y-2 border-t border-border pt-3"><summary className="cursor-pointer">{t('mixing.recoveryTitle')}</summary><p>{t('mixing.recoveryHelp')}</p>
                <label className="flex gap-2 text-ui-control"><Checkbox disabled={!editable || snapshot.running || stale} checked={resetConfirmed} onChange={e => setResetConfirmed(e.target.checked)} />{t('mixing.recoveryConfirm')}</label>
                <Button variant="destructive" className="h-auto whitespace-normal" disabled={!editable || snapshot.running || stale || !resetConfirmed} onClick={() => { queue.cancel(); void run('reset'); }}>{t('mixing.recoveryAction')}</Button>{resetSuccess && <p role="status">{t('mixing.recoverySuccess')}</p>}</details>
        </div>}
        <MixingError error={error} />
    </details>;
}

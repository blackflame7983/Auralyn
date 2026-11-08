import { Checkbox } from '@/components/ui/Checkbox';
import { useEffect, useRef, useState } from 'react';
import { audioApi, type VstPlugin } from '@/api/audio';
import { mixingApi } from '@/api/mixing';
import { postMixApi, type PostMixRequest } from '@/api/postMix';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginList } from '@/components/features/PluginRack/PluginList';
import { PluginBrowserModal } from '@/components/features/PluginBrowser/PluginBrowserModal';
import { MixingError, ScopeDisclosure, framesToMs, mixingCard, useQueuedChange, useRevisionedResource } from './mixingUi';

type Change = Exclude<PostMixRequest, { action: 'snapshot' }>;
type Action = Change extends infer C ? C extends Change ? Omit<C, 'expectedEpoch' | 'expectedRevision'> : never : never;
export function PostMixPanel({ mainRunning, hasMixing, disabled = false }: { mainRunning: boolean; hasMixing?: boolean; disabled?: boolean }) {
    const t = useMessages(), panel = useRef<HTMLDetailsElement>(null);
    const [open, setOpen] = useState(false), attempted = useRef(false);
    const [mixConfigured, setMixConfigured] = useState(hasMixing ?? false), [primaryRunning, setPrimaryRunning] = useState(mainRunning);
    const isMainRunning = mainRunning || primaryRunning;
    const resource = useRevisionedResource(async () => {
        const [post, mix] = await Promise.all([postMixApi.request({ action: 'snapshot' }), mixingApi.request({ action: 'snapshot' })]);
        setMixConfigured(!!mix.config); setPrimaryRunning(mix.running); return post;
    }, open, () => !!panel.current?.getClientRects().length);
    const { snapshot, busy, stale, error } = resource;
    const [resetConfirmed, setResetConfirmed] = useState(false), [resetDone, setResetDone] = useState(false);
    const [available, setAvailable] = useState<VstPlugin[]>([]), [browser, setBrowser] = useState(false), [scanning, setScanning] = useState(false);
    const [gains, setGains] = useState<Record<string, number>>({});
    useEffect(() => { if (open && !attempted.current && !disabled) { attempted.current = true; void resource.run('mixingUi.read'); } return () => { attempted.current = false; }; }, [open, disabled]);
    async function run(action: Action) {
        if (disabled || (isMainRunning && ['enable', 'restore_saved', 'add', 'remove', 'reorder', 'reload', 'reset'].includes(action.action)) || (action.action === 'reset' && !resetConfirmed)) return null;
        const keys: Record<Action['action'], MessageKey> = { enable: 'postMix.enabled', restore_saved: 'postMix.restore', add: 'postMix.add', remove: 'postMix.remove', reorder: 'mixingUi.reorder', reload: 'postMix.reload', reset: 'postMix.reset', save: 'postMix.save', bypass: 'mixingUi.enablePlugin', mute: 'postMix.mute', gain: 'mixingUi.levels', editor: 'postMix.editor' };
        setResetDone(false);
        const next = await resource.run(keys[action.action], witness => postMixApi.request({ ...action, expectedEpoch: witness.epoch, expectedRevision: witness.revision } as PostMixRequest));
        if (next && !next.error) {
            if (['reload', 'restore_saved', 'reset'].includes(action.action)) setGains({});
            if (action.action === 'reset') { setResetConfirmed(false); setResetDone(true); }
            window.dispatchEvent(new Event('mixing-settings-changed'));
        }
        return next?.error ? null : next;
    }
    // 別のVSTの操作をまとめて捨てないよう、音量の要求をIDごとに直列化する。
    const gainQueue = useQueuedChange<Record<string, number>>(async changes => {
        for (const [id, value] of Object.entries(changes)) { if (!await run({ action: 'gain', id, value })) return null; if (pendingGains.current[id] === value) delete pendingGains.current[id]; }
        return true;
    });
    const pendingGains = useRef<Record<string, number>>({});
    useEffect(() => { if (stale || !open) { gainQueue.cancel(); pendingGains.current = {}; } }, [stale, open]);
    async function scan() { if (scanning || disabled || isMainRunning) return; setScanning(true); try { setAvailable(await audioApi.scanPlugins()); } catch (e) { resource.report('postMix.scan', e); } finally { setScanning(false); } }
    const editable = !disabled && !busy && !stale, stopped = editable && !isMainRunning;
    const gainDifferences = snapshot?.plugins.filter(p => gains[p.id] !== undefined && gains[p.id] !== p.gain).map(p => [p.id, gains[p.id]] as const) ?? [];
    const enableReason = !(hasMixing ?? mixConfigured) ? 'mixingUi.postNeedsMix' : !snapshot?.restored ? 'postMix.restoreNeeded' : isMainRunning ? 'postMix.stop' : stale ? 'postMix.stale' : null;
    return <details ref={panel} className={mixingCard} onToggle={e => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-ui-heading font-semibold">{t('postMix.title')}</summary>
        <ScopeDisclosure settings summary="mixingUi.postScope" detail="postMix.scope" />
        <Button  variant="outline" size="sm" disabled={disabled || busy} onClick={() => void resource.run('mixingUi.read')}>{t('postMix.load')}</Button>
        {snapshot && <div className="space-y-3 text-ui-support">
            {stale && <p role="alert">{t('postMix.stale')}</p>}
            <p>{t('mixingUi.transportMs', { value: framesToMs(snapshot.transportLatencyFrames, snapshot.sampleRate) ?? t('postMix.unknown') })}</p>
            <p>{t('mixingUi.declaredMs', { value: framesToMs(snapshot.declaredPluginLatencyFrames, snapshot.sampleRate) ?? t('postMix.unknown') })}</p>
            <p>{t('postMix.saved')}: {snapshot.savedPlugins.map(p => p.name).join(', ') || t('postMix.none')}</p>
            {!snapshot.restored && <p>{t('postMix.restoreNeeded')}</p>}{isMainRunning && <p>{t('postMix.stop')}</p>}
            <div className="flex flex-wrap gap-2"><Button  variant="outline" size="sm" disabled={!stopped} onClick={() => void run({ action: 'restore_saved' })}>{t('postMix.restore')}</Button><Button  variant="outline" size="sm" disabled={!stopped} onClick={() => void run({ action: 'reload' })}>{t('postMix.reload')}</Button></div>
            <label className="flex items-center gap-2 text-ui-control"><Switch aria-label={t('postMix.enabled')} aria-describedby={enableReason ? 'post-enable-reason' : undefined} disabled={!stopped || (!snapshot.enabled && !!enableReason)} checked={snapshot.enabled} onCheckedChange={enabled => void run({ action: 'enable', enabled })} />{t('postMix.enabled')}</label>
            {enableReason && <p id="post-enable-reason">{t(enableReason)}</p>}
            <PluginList rackKind="broadcast" structureDisabled={!stopped} disabled={!editable} audioReady
                plugins={snapshot.plugins.map(p => ({ ...p, gain: gains[p.id] ?? p.gain, vendor: '', version: '', hasEditor: true }))}
                onAddClick={() => { setBrowser(true); void scan(); }} onOpenPresets={() => {}} onOpenTemplates={() => {}}
                onToggle={(id, enabled) => void run({ action: 'bypass', id, active: !enabled })}
                onMute={(id, active) => void run({ action: 'mute', id, active })}
                onGainChange={(id, value) => { setGains(old => ({ ...old, [id]: value })); pendingGains.current = { ...pendingGains.current, [id]: value }; gainQueue.enqueue(pendingGains.current); }}
                onRemove={id => void run({ action: 'remove', id })} onEdit={id => void run({ action: 'editor', id })}
                onReorder={plugins => void run({ action: 'reorder', ids: plugins.map(p => p.id) })} />
            {gainDifferences.length > 0 && <div role="status" className="space-y-2"><p id="post-save-gain-reason">{t('mixingUi.gainUnapplied')}</p>{!busy && <Button  variant="outline" disabled={!editable} onClick={() => gainQueue.enqueue(Object.fromEntries(gainDifferences))}>{t('mixingUi.retryGain')}</Button>}</div>}
            <Button  variant="outline" disabled={!editable || !snapshot.restored || gainDifferences.length > 0} aria-describedby={gainDifferences.length ? "post-save-gain-reason" : undefined} onClick={() => void run({ action: 'save' })}>{t('postMix.save')}</Button>
            <details className="space-y-2 border-t border-border pt-3"><summary className="cursor-pointer">{t('postMix.recovery')}</summary><p>{t('postMix.recoveryHelp')}</p><label className="flex gap-2 text-ui-control"><Checkbox disabled={!stopped} checked={resetConfirmed} onChange={e => setResetConfirmed(e.target.checked)} />{t('postMix.recoveryConfirm')}</label><Button variant="destructive" className="h-auto whitespace-normal" disabled={!stopped || !resetConfirmed} onClick={() => { gainQueue.cancel(); void run({ action: 'reset' }); }}>{t('postMix.reset')}</Button>{resetDone && <p role="status">{t('postMix.resetDone')}</p>}</details>
        </div>}
        <MixingError error={error} />
        <PluginBrowserModal isOpen={browser} onClose={() => setBrowser(false)} plugins={available} isLoading={scanning} onScan={() => void scan()} addedPaths={snapshot?.plugins.map(p => p.path)} onPluginSelect={p => { setBrowser(false); void run({ action: 'add', path: p.path }); }} />
    </details>;
}

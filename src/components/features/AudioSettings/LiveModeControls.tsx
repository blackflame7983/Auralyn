import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { MdMusicNote, MdMic, MdCheckCircle, MdSave } from 'react-icons/md';
import { presetApi, type ProfileMeta } from '@/api/presets';
import { SavePurposeHelp } from '../Presets/SavePurposeHelp';

function Content({ model, onAdjust }: { model: LiveModesModel; onAdjust?: (mode: 'singing' | 'talk') => void }) {
    const t = useMessages();
    const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
    const [profileError, setProfileError] = useState(false);
    const [profileReload, setProfileReload] = useState(0);
    const [selection, setSelection] = useState<Partial<Record<'singing' | 'talk', string>>>({});
    useEffect(() => { let active = true; setProfileError(false); void presetApi.listProfiles().then(items => { if (active) setProfiles(items.filter(item => item.hasPlugins && !item.isBackup)); }).catch(() => { if (active) setProfileError(true); }); return () => { active = false; }; }, [profileReload]);
    const [confirmReverb, setConfirmReverb] = useState(false);
    const [nextMode, setNextMode] = useState<'singing' | 'talk' | null>(null);
    const name = (mode: 'singing' | 'talk' | null) => mode === 'singing' ? t('settings.LiveModeControls.212') : mode === 'talk' ? t('settings.LiveModeControls.213') : t('settings.LiveModeControls.214');
    useEffect(() => model.activate(), [model.activate]);
    const { snapshot: value, error } = model;
    const busy = model.busy || model.changesBlocked;
    const save = async (mode: 'singing' | 'talk', disableReverb = false) => {
        setNextMode(null);
        setConfirmReverb(false);
        const result = await model.saveApplied(mode, disableReverb);
        setConfirmReverb(result === 'reverb');
        if (result === true) setNextMode(mode === 'singing' ? 'talk' : 'singing');
    };
    const sameSettings = value?.definitions.singing && value.definitions.talk
        && JSON.stringify(value.definitions.singing) === JSON.stringify(value.definitions.talk);
    return <div className="space-y-3 p-3 text-sm">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <p>{t('settings.mode.registerHintNew')}</p>
            <SavePurposeHelp />
        </div>
        {profileError && <div className="space-y-2" role="alert"><p>{t('liveTransaction.profilesFailed')}</p><button type="button" onClick={() => setProfileReload(n => n + 1)} className="rounded-md border border-border px-3 py-1.5 text-xs">{t('liveTransaction.retryProfiles')}</button></div>}
        <div className="divide-y divide-border">
            {(['singing', 'talk'] as const).map(mode => {
                const Icon = mode === 'singing' ? MdMusicNote : MdMic;
                const saved = Boolean(value?.definitions[mode]);
                const bound = value?.definitions.profiles?.[mode]?.name ?? '';
                const selected = selection[mode] ?? bound;
                return <div key={mode} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex flex-wrap items-center gap-2"><Icon aria-hidden="true" className="h-5 w-5 text-primary" />
                        <span className="font-semibold">{name(mode)}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{saved && <MdCheckCircle aria-hidden="true" className="h-4 w-4 text-success" />}{t(!value ? 'settings.LiveModeControls.216' : saved ? 'settings.LiveModeControls.232' : 'settings.LiveModeControls.233')}</span>
                        {saved && <span className="text-xs text-muted-foreground">{t('settings.mode.savedSummary', { voice: value!.definitions[mode]!.active ? 'ON' : 'OFF', reverb: value!.definitions[mode]!.reverb?.enabled ? 'ON' : 'OFF' })}</span>}
                    </div>
                    <div className="basis-full space-y-2">
                        <label className="block text-xs" htmlFor={`profile-${mode}`}>{t('liveTransaction.profileLabel', { mode: name(mode) })}</label>
                        <select id={`profile-${mode}`} disabled={busy || !saved || profileError} value={selected} onChange={event => setSelection(old => ({ ...old, [mode]: event.target.value }))} className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                            <option value="">{t('liveTransaction.builtinOnly')}</option>
                            {bound && !profiles.some(profile => profile.name === bound) && <option value={bound}>{bound}</option>}
                            {profiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
                        </select>
                        <p className="text-xs text-muted-foreground">{t('liveTransaction.bound', { name: bound || t('liveTransaction.builtinOnly') })}</p>
                        {selected && selection[mode] !== undefined && <p className="text-xs text-warning">{t('liveTransaction.warning')}</p>}
                        <button type="button" disabled={busy || !saved || profileError || (selected === bound && !selected)} onClick={() => void model.bindProfile(mode, selected || null).then(ok => { if (ok) setSelection(old => { const next = { ...old }; delete next[mode]; return next; }); })} className="rounded-md border border-border px-3 py-1.5 text-xs">{t('liveTransaction.saveBinding', { mode: name(mode) })}</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                    {onAdjust && <button type="button" onClick={() => onAdjust(mode)} aria-label={t('settings.mode.adjustNamed', { mode: name(mode) })}
                        className="rounded-md border border-border px-3 py-2 text-xs hover:bg-muted">{t('settings.mode.adjust')}</button>}
                    <button type="button" disabled={busy || !value} onClick={() => void save(mode)} aria-label={t('settings.mode.save', { mode: name(mode) })}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"><MdSave aria-hidden="true" />{t('settings.mode.registerAction')}</button>
                    </div>
                </div>;
            })}
        </div>
        {confirmReverb && <div className="space-y-2 rounded-md border border-border p-3" role="group" aria-label={t('settings.mode.reverbConfirm')}>
            <p>{t('settings.mode.reverbConfirm')}</p>
            <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void save('talk', true)} className="rounded-md border border-border px-3 py-2 text-xs">{t('settings.mode.registerWithoutReverb')}</button>
                <button type="button" disabled={busy} onClick={() => setConfirmReverb(false)} className="rounded-md border border-border px-3 py-2 text-xs">{t('settings.mode.cancelRegistration')}</button>
            </div>
        </div>}
        {nextMode && onAdjust && <button type="button" onClick={() => { setNextMode(null); onAdjust(nextMode); }} className="rounded-md border border-border px-3 py-2 text-xs">{t('settings.mode.adjustOther', { mode: name(nextMode) })}</button>}
        {sameSettings && <p className="text-xs text-muted-foreground">{t('settings.mode.sameSettings')}</p>}
        <p role="status">{!value ? t('settings.LiveModeControls.216') : value.phase === 'partial' ? t('liveOutput.partial') : value.phase === 'custom' ? t('settings.LiveModeControls.217')
            : !value.running || value.phase === 'stopped' ? t('settings.LiveModeControls.218', { arg0: name(value.target) })
            : value.phase === 'settled' ? t('settings.LiveModeControls.219', { arg0: name(value.target), arg1: name(value.applied) })
            : t('settings.LiveModeControls.220', { arg0: name(value.target), arg1: value.acceptedRevision === value.revision ? t('settings.LiveModeControls.221') : t('settings.LiveModeControls.222') })}</p>
        {value?.naturalTail && <p>{t('settings.LiveModeControls.223')}</p>}
        <details className="space-y-3 rounded-lg bg-muted/20 p-3"><summary className="cursor-pointer text-xs font-medium">{t('settings.mode.advanced')}</summary>
        <div className="flex flex-wrap gap-2">{(['singing', 'talk'] as const).map(mode => <button key={mode} type="button" disabled={busy || !value?.definitions[mode]} onClick={() => void model.select(mode)} className="rounded-md border px-3 py-2 disabled:opacity-50">{t('settings.mode.select', { mode: name(mode) })}</button>)}</div>
        {value && <p>{t('settings.LiveModeControls.225')}{value.armed ? t('settings.LiveModeControls.226') : t('settings.LiveModeControls.227')}{t('settings.LiveModeControls.228')}</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={value?.armed ?? false} disabled={busy || !value} onChange={event => void model.protect(event.target.checked)} />{t('settings.LiveModeControls.229')}</label>
        </details>
        <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('settings.mode.troubleshoot')}</summary>
            <button type="button" disabled={busy} onClick={() => void model.refresh()} className="mt-2 rounded border border-border px-3 py-1.5 text-xs">{t('settings.LiveModeControls.236')}</button>
        </details>
        {(error || value?.error) && <div className="space-y-2"><p role="alert">{error || t('liveNotices.operationFailed')}</p>
            <button type="button" disabled={busy} onClick={() => void model.refresh()} className="rounded-md border border-border px-3 py-1.5 text-xs">{t('settings.LiveModeControls.236')}</button>
            {(model.errorDetail || value?.error) && <details><summary className="cursor-pointer text-xs">{t('settings.mode.errorDetails')}</summary><p className="mt-2 break-words text-xs text-muted-foreground">{model.errorDetail || value?.error}</p></details>}
        </div>}
    </div>;
}
export function LiveModeControls({ model, initiallyOpen = false, onAdjust }: { model: LiveModesModel; initiallyOpen?: boolean; onAdjust?: (mode: 'singing' | 'talk') => void }) {
    const t = useMessages();
    const [open, setOpen] = useState(initiallyOpen);
    useEffect(() => { if (initiallyOpen) setOpen(true); }, [initiallyOpen]);
    return <details id="live-mode-settings" open={open} className="mb-3 rounded-xl border border-border" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary tabIndex={0} className="cursor-pointer p-3 font-semibold">{t('settings.mode.registration')}</summary>
        {open && <Content model={model} onAdjust={onAdjust} />}
    </details>;
}

import { Field } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { MdMusicNote, MdMic, MdCheckCircle, MdSave } from 'react-icons/md';
import { presetApi, type ProfileMeta } from '@/api/presets';
import { SavePurposeHelp } from '../Presets/SavePurposeHelp';
import { InfoPopover } from '@/components/ui/InfoPopover';

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
    // 登録前の正常時には操作を重複させない。登録がなくても保護の解除と復旧中の状態は残す。
    const showModeActions = Boolean(value && (value.definitions.singing || value.definitions.talk || value.armed || value.transaction));
    const save = async (mode: 'singing' | 'talk', disableReverb = false) => {
        setNextMode(null);
        setConfirmReverb(false);
        const result = await model.saveApplied(mode, disableReverb);
        setConfirmReverb(result === 'reverb');
        if (result === true) setNextMode(mode === 'singing' ? 'talk' : 'singing');
    };
    const sameSettings = value?.definitions.singing && value.definitions.talk
        && JSON.stringify(value.definitions.singing) === JSON.stringify(value.definitions.talk);
    return <div className="space-y-3 p-3 text-ui-support">
        <div className="flex items-center gap-1 text-ui-support text-muted-foreground">
            <SavePurposeHelp />
        </div>
        {profileError && <div className="space-y-2" role="alert"><p>{t('liveTransaction.profilesFailed')}</p><Button type="button" onClick={() => setProfileReload(n => n + 1)} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('liveTransaction.retryProfiles')}</Button></div>}
        <div className="grid gap-3 sm:grid-cols-2">
            {(['singing', 'talk'] as const).map(mode => {
                const Icon = mode === 'singing' ? MdMusicNote : MdMic;
                const saved = Boolean(value?.definitions[mode]);
                const bound = value?.definitions.profiles?.[mode]?.name ?? '';
                const selected = selection[mode] ?? bound;
                // 状態と保存内容を別の行にし、隣のカードと行高を共有する。名前や説明が折り返しても操作位置を揃える。
                return <section key={mode} aria-label={name(mode)} className="grid min-w-0 row-span-5 grid-rows-subgrid gap-3 rounded-card border border-border p-3">
                    <div className="flex items-center gap-2"><Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
                        <span className="text-ui-control font-semibold">{name(mode)}</span>
                    </div>
                    <p data-mode-registration-status className="flex items-center gap-1 text-ui-support text-muted-foreground">{saved && <MdCheckCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />}{t(!value ? 'settings.LiveModeControls.216' : saved ? 'settings.LiveModeControls.232' : 'settings.LiveModeControls.233')}</p>
                    <p data-mode-saved-summary className="text-ui-support text-muted-foreground">{saved && t('settings.mode.savedSummary', { voice: value!.definitions[mode]!.active ? 'ON' : 'OFF', reverb: value!.definitions[mode]!.reverb?.enabled ? 'ON' : 'OFF' })}</p>
                    <div className="flex flex-wrap gap-2">
                    {onAdjust && <Button type="button" onClick={() => onAdjust(mode)} aria-label={t('settings.mode.adjustNamed', { mode: name(mode) })}
                        variant="outline" className="h-auto min-h-10 whitespace-normal">{t('settings.mode.adjust')}</Button>}
                    <Button type="button" disabled={busy || !value} onClick={() => void save(mode)} aria-label={t('settings.mode.save', { mode: name(mode) })}
                        variant="outline" className="h-auto min-h-10 whitespace-normal gap-2"><MdSave aria-hidden="true" />{t('settings.mode.registerAction')}</Button>
                    </div>
                    <details className="space-y-2">
                        <summary className="cursor-pointer text-ui-support">{t('liveTransaction.bindingDetails')}</summary>
                        <div className="flex items-center gap-1"><label className="block text-ui-control" htmlFor={`profile-${mode}`}>{t('liveTransaction.profileLabel', { mode: name(mode) })}</label><InfoPopover label={t('liveTransaction.bindingDetails')}>{t('liveTransaction.bindingHelp')}</InfoPopover></div>
                        <Field id={`profile-${mode}`} label={null}><Select id={`profile-${mode}`} disabled={busy || !saved || profileError} value={selected} onChange={event => setSelection(old => ({ ...old, [mode]: event.target.value }))} >
                            <option value="">{t('liveTransaction.builtinOnly')}</option>
                            {bound && !profiles.some(profile => profile.name === bound) && <option value={bound}>{bound}</option>}
                            {profiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
                        </Select></Field>
                        <p className="text-ui-support text-muted-foreground">{t('liveTransaction.bound', { name: bound || t('liveTransaction.builtinOnly') })}</p>
                        {value?.definitions.profiles?.[mode]?.snapshot && <p className="text-ui-support text-muted-foreground">{t('bundle.live.savedBinding')}</p>}
                        {selected && selection[mode] !== undefined && <p className="text-ui-support text-warning">{t('liveTransaction.warning')}</p>}
                        <Button type="button" aria-label={t('liveTransaction.saveBindingNamed', { mode: name(mode) })} disabled={busy || !saved || profileError || (selected === bound && !selected)} onClick={() => void model.bindProfile(mode, selected || null).then(ok => { if (ok) setSelection(old => { const next = { ...old }; delete next[mode]; return next; }); })} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('liveTransaction.saveBinding')}</Button>
                    </details>
                </section>;
            })}
        </div>
        {confirmReverb && <div className="space-y-2 rounded-control border border-border p-3" role="group" aria-label={t('settings.mode.reverbConfirm')}>
            <p>{t('settings.mode.reverbConfirm')}</p>
            <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => void save('talk', true)} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.mode.registerWithoutReverb')}</Button>
                <Button type="button" disabled={busy} onClick={() => setConfirmReverb(false)} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.mode.cancelRegistration')}</Button>
            </div>
        </div>}
        {nextMode && onAdjust && <Button type="button" onClick={() => { setNextMode(null); onAdjust(nextMode); }} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.mode.adjustOther', { mode: name(nextMode) })}</Button>}
        {sameSettings && <p className="text-ui-support text-muted-foreground">{t('settings.mode.sameSettings')}</p>}
        <p role="status" className="text-ui-support">{!value ? t('settings.LiveModeControls.216') : value.phase === 'partial' ? t('liveOutput.partial') : value.phase === 'custom' ? t('settings.LiveModeControls.217')
            : !value.running || value.phase === 'stopped' ? t('settings.LiveModeControls.218', { arg0: name(value.target) })
            : value.phase === 'settled' ? t('settings.LiveModeControls.219', { arg0: name(value.target), arg1: name(value.applied) })
            : t('settings.LiveModeControls.220', { arg0: name(value.target), arg1: value.acceptedRevision === value.revision ? t('settings.LiveModeControls.221') : t('settings.LiveModeControls.222') })}</p>
        {value?.naturalTail && <p>{t('settings.LiveModeControls.223')}</p>}
        {showModeActions && <details className="space-y-3 rounded-card bg-muted/20 p-3"><summary className="cursor-pointer text-ui-support font-medium">{t('settings.mode.advanced')}</summary>
        <div className="flex flex-wrap gap-2">{(['singing', 'talk'] as const).map(mode => <Button key={mode} type="button" disabled={busy || !value?.definitions[mode]} onClick={() => void model.select(mode)} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('settings.mode.select', { mode: name(mode) })}</Button>)}</div>
        {value && <p>{t('settings.LiveModeControls.225')}{value.armed ? t('settings.LiveModeControls.226') : t('settings.LiveModeControls.227')}{t('settings.LiveModeControls.228')}</p>}
        <label className="flex items-center gap-2 text-ui-control"><Checkbox checked={value?.armed ?? false} disabled={busy || !value} onChange={event => void model.protect(event.target.checked)} />{t('settings.LiveModeControls.229')}</label>
        </details>}
        {(error || value?.error) && <div className="space-y-2"><p role="alert">{error || t('liveNotices.operationFailed')}</p>
            <Button type="button" disabled={busy} onClick={() => void model.refresh()} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.LiveModeControls.236')}</Button>
            {(model.errorDetail || value?.error) && <details><summary className="cursor-pointer text-ui-support">{t('settings.mode.errorDetails')}</summary><p className="mt-2 break-words text-ui-support text-muted-foreground">{model.errorDetail || value?.error}</p></details>}
        </div>}
    </div>;
}
export function LiveModeControls({ model, onAdjust }: { model: LiveModesModel; initiallyOpen?: boolean; onAdjust?: (mode: 'singing' | 'talk') => void }) {
    const t = useMessages();
    return <section id="live-mode-settings" tabIndex={-1} className="mb-3 rounded-card border border-border">
        <h3 tabIndex={-1} className="p-3 text-ui-heading font-semibold">{t('settings.mode.registration')}</h3>
        <Content model={model} onAdjust={onAdjust} />
    </section>;
}

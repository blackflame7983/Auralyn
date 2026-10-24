import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import type { LiveModesModel } from '@/hooks/useLiveModes';

function Content({ model }: { model: LiveModesModel }) {
    const t = useMessages();
    const name = (mode: 'singing' | 'talk' | null) => mode === 'singing' ? t('settings.LiveModeControls.212') : mode === 'talk' ? t('settings.LiveModeControls.213') : t('settings.LiveModeControls.214');
    useEffect(() => model.activate(), [model.activate]);
    const { snapshot: value, busy, error } = model;
    return <div className="space-y-3 p-3 text-sm">
        <p>{t('settings.LiveModeControls.215')}</p>
        <p role="status">{!value ? t('settings.LiveModeControls.216') : value.phase === 'custom' ? t('settings.LiveModeControls.217')
            : !value.running || value.phase === 'stopped' ? t('settings.LiveModeControls.218', { arg0: name(value.target) })
            : value.phase === 'settled' ? t('settings.LiveModeControls.219', { arg0: name(value.target), arg1: name(value.applied) })
            : t('settings.LiveModeControls.220', { arg0: name(value.target), arg1: value.acceptedRevision === value.revision ? t('settings.LiveModeControls.221') : t('settings.LiveModeControls.222') })}</p>
        {value?.naturalTail && <p>{t('settings.LiveModeControls.223')}</p>}
        <div className="flex flex-wrap gap-2">{(['singing', 'talk'] as const).map(mode => <button key={mode} type="button" disabled={busy || !value} onClick={() => void model.select(mode)} className="rounded border px-3 py-2 disabled:opacity-50">{t('settings.mode.select', { mode: name(mode) })}</button>)}</div>
        {value && <p>{t('settings.LiveModeControls.225')}{value.armed ? t('settings.LiveModeControls.226') : t('settings.LiveModeControls.227')}{t('settings.LiveModeControls.228')}</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={value?.armed ?? false} disabled={busy || !value} onChange={event => void model.protect(event.target.checked)} />{t('settings.LiveModeControls.229')}</label>
        <details><summary>{t('settings.LiveModeControls.230')}</summary><div className="space-y-2 pt-2">
            <p>{t('settings.LiveModeControls.231')}</p>
            {(['singing', 'talk'] as const).map(mode => <div key={mode}><span>{name(mode)}：{value?.definitions[mode] ? t('settings.LiveModeControls.232') : t('settings.LiveModeControls.233')} </span><button type="button" disabled={busy || !value} onClick={() => void model.saveApplied(mode)} className="underline">{t('settings.mode.save', { mode: name(mode) })}</button></div>)}
        </div></details>
        <button type="button" disabled={busy} onClick={() => void model.refresh()} className="underline">{t('settings.LiveModeControls.236')}</button>
        {(error || value?.error) && <p role="alert">{error || value?.error}</p>}
    </div>;
}
export function LiveModeControls({ model }: { model: LiveModesModel }) {
    const t = useMessages();
    const [open, setOpen] = useState(false);
    return <details className="mb-3 rounded-xl border border-border" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer p-3 font-semibold">{t('settings.LiveModeControls.237')}</summary>
        {open && <Content model={model} />}
    </details>;
}

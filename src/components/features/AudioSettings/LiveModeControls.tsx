import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { MdMusicNote, MdMic, MdCheckCircle, MdSave } from 'react-icons/md';
import { InfoPopover } from '@/components/ui/InfoPopover';

function Content({ model }: { model: LiveModesModel }) {
    const t = useMessages();
    const name = (mode: 'singing' | 'talk' | null) => mode === 'singing' ? t('settings.LiveModeControls.212') : mode === 'talk' ? t('settings.LiveModeControls.213') : t('settings.LiveModeControls.214');
    useEffect(() => model.activate(), [model.activate]);
    const { snapshot: value, busy, error } = model;
    return <div className="space-y-3 p-3 text-sm">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <p>{t('settings.mode.registerHint')}</p>
            <InfoPopover label={t('settings.mode.scope')}><p>{t('settings.LiveModeControls.215')}</p></InfoPopover>
        </div>
        {/* 登録を二重の折りたたみに隠さない。保存条件は実行ボタンより先に伝える。 */}
        <p className="text-xs text-muted-foreground">{t('settings.mode.registrationScope')}</p>
        <div className="divide-y divide-border">
            {(['singing', 'talk'] as const).map(mode => {
                const Icon = mode === 'singing' ? MdMusicNote : MdMic;
                const saved = Boolean(value?.definitions[mode]);
                return <div key={mode} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-2"><Icon aria-hidden="true" className="h-5 w-5 text-primary" />
                        <span className="font-semibold">{name(mode)}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{saved && <MdCheckCircle aria-hidden="true" className="h-4 w-4 text-success" />}{t(!value ? 'settings.LiveModeControls.216' : saved ? 'settings.LiveModeControls.232' : 'settings.LiveModeControls.233')}</span>
                    </div>
                    <button type="button" disabled={busy || !value} onClick={() => void model.saveApplied(mode)} aria-label={t('settings.mode.save', { mode: name(mode) })}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"><MdSave aria-hidden="true" />{t('settings.mode.registerAction')}</button>
                </div>;
            })}
        </div>
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
        {(error || value?.error) && <p role="alert">{error || value?.error}</p>}
    </div>;
}
export function LiveModeControls({ model, initiallyOpen = false }: { model: LiveModesModel; initiallyOpen?: boolean }) {
    const t = useMessages();
    const [open, setOpen] = useState(initiallyOpen);
    useEffect(() => { if (initiallyOpen) setOpen(true); }, [initiallyOpen]);
    return <details id="live-mode-settings" open={open} className="mb-3 rounded-xl border border-border" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary tabIndex={0} className="cursor-pointer p-3 font-semibold">{t('settings.mode.registration')}</summary>
        {open && <Content model={model} />}
    </details>;
}

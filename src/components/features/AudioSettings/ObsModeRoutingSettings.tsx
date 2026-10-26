import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';
import { readLiveRouting, saveLiveRouting, useRackRestoreBusy, type LiveRouting } from '@/lib/liveRouting';

export function ObsModeRoutingSettings() {
    const t = useMessages();
    const [initial] = useState(readLiveRouting);
    const [strategy, setStrategy] = useState<LiveRouting['strategy']>(initial?.strategy ?? 'preset');
    const [enabled, setEnabled] = useState(initial?.explicitEnabled ?? false);
    const [rows, setRows] = useState(() => Object.entries(initial?.mappings ?? {}).map(([scene, mode]) => ({ scene, mode })));
    const [message, setMessage] = useState<SettingsNotice>('');
    const busy = useRackRestoreBusy();
    const save = () => {
        const names = rows.map(row => row.scene.trim());
        if (names.some(name => !name) || new Set(names).size !== names.length) { setMessage(notice('settings.ObsModeRoutingSettings.308')); return; }
        try {
            saveLiveRouting({ version: 1, strategy, explicitEnabled: enabled && strategy !== 'none', mappings: Object.fromEntries(rows.map((row, i) => [names[i], row.mode])) });
            setMessage(notice('settings.ObsModeRoutingSettings.309'));
        } catch { setMessage(notice('settings.ObsModeRoutingSettings.310')); }
    };
    return <section aria-label={t('settings.ObsModeRoutingSettings.311')} className="rounded border border-border p-3 space-y-3 text-sm">
        <h3 className="font-bold">{t('settings.ObsModeRoutingSettings.312')}</h3>
        <p>{t('settings.ObsModeRoutingSettings.313')}</p>
        <fieldset disabled={busy} className="space-y-2"><legend className="sr-only">{t('settings.ObsModeRoutingSettings.314')}</legend>
            <label>{t('settings.ObsModeRoutingSettings.315')}<select aria-label={t('settings.ObsModeRoutingSettings.316')} value={strategy} onChange={event => setStrategy(event.target.value as LiveRouting['strategy'])} className="block w-full rounded border bg-background p-2">
                <option value="none">{t('settings.ObsModeRoutingSettings.317')}</option><option value="preset">{t('settings.ObsModeRoutingSettings.318')}</option><option value="mode">{t('settings.ObsModeRoutingSettings.319')}</option>
            </select></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={strategy === 'none'} onChange={event => setEnabled(event.target.checked)} />{t('settings.ObsModeRoutingSettings.320')}</label>
            {strategy === 'mode' && <div className="space-y-2"><p>{t('settings.ObsModeRoutingSettings.321')}</p>
                {rows.map((row, index) => <div key={index} className="flex flex-wrap gap-2"><label>{t('settings.ObsModeRoutingSettings.322')}<input aria-label={t('settings.ObsModeRoutingSettings.323', { arg0: index + 1 })} value={row.scene} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, scene: event.target.value } : value))} className="block rounded border bg-background p-2" /></label>
                    <label>{t('settings.ObsModeRoutingSettings.324')}<select aria-label={t('settings.ObsModeRoutingSettings.325', { arg0: index + 1 })} value={row.mode} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, mode: event.target.value as 'singing' | 'talk' } : value))} className="block rounded border bg-background p-2"><option value="singing">{t('settings.ObsModeRoutingSettings.326')}</option><option value="talk">{t('settings.ObsModeRoutingSettings.327')}</option></select></label>
                    <button type="button" onClick={() => setRows(previous => previous.filter((_, i) => i !== index))}>{t('settings.ObsModeRoutingSettings.328', { n: index + 1 })}</button></div>)}
                <button type="button" className="link-button" onClick={() => setRows(previous => [...previous, { scene: '', mode: 'singing' }])}>{t('settings.ObsModeRoutingSettings.329')}</button>
            </div>}
            <button type="button" onClick={save} className="rounded border px-3 py-2">{t('settings.ObsModeRoutingSettings.330')}</button>
        </fieldset>
        {message && <p role="status">{renderNotice(t, message)}</p>}
    </section>;
}

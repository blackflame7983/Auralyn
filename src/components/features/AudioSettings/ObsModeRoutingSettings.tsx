import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
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
    return <section aria-label={t('settings.ObsModeRoutingSettings.311')} className="rounded-control border border-border p-3 space-y-3 text-ui-support">
        <h3 className="text-ui-heading font-semibold">{t('settings.ObsModeRoutingSettings.312')}</h3>
        <p>{t('settings.ObsModeRoutingSettings.313')}</p>
        <fieldset disabled={busy} className="space-y-2"><legend className="sr-only">{t('settings.ObsModeRoutingSettings.314')}</legend>
            <Field label={t('settings.ObsModeRoutingSettings.315')}><Select aria-label={t('settings.ObsModeRoutingSettings.316')} value={strategy} onChange={event => setStrategy(event.target.value as LiveRouting['strategy'])} >
                <option value="none">{t('settings.ObsModeRoutingSettings.317')}</option><option value="preset">{t('settings.ObsModeRoutingSettings.318')}</option><option value="mode">{t('settings.ObsModeRoutingSettings.319')}</option>
            </Select></Field>
            <label className="flex items-center gap-2 text-ui-control"><Checkbox checked={enabled} disabled={strategy === 'none'} onChange={event => setEnabled(event.target.checked)} />{t('settings.ObsModeRoutingSettings.320')}</label>
            {strategy === 'mode' && <div className="space-y-2"><p>{t('settings.ObsModeRoutingSettings.321')}</p>
                {rows.map((row, index) => <div key={index} className="flex flex-wrap gap-2"><Field label={t('settings.ObsModeRoutingSettings.322')}><Input aria-label={t('settings.ObsModeRoutingSettings.323', { arg0: index + 1 })} value={row.scene} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, scene: event.target.value } : value))} /></Field>
                    <Field label={t('settings.ObsModeRoutingSettings.324')}><Select aria-label={t('settings.ObsModeRoutingSettings.325', { arg0: index + 1 })} value={row.mode} onChange={event => setRows(previous => previous.map((value, i) => i === index ? { ...value, mode: event.target.value as 'singing' | 'talk' } : value))} ><option value="singing">{t('settings.ObsModeRoutingSettings.326')}</option><option value="talk">{t('settings.ObsModeRoutingSettings.327')}</option></Select></Field>
                    <Button variant="ghost" className="h-auto min-h-10 whitespace-normal" type="button" onClick={() => setRows(previous => previous.filter((_, i) => i !== index))}>{t('settings.ObsModeRoutingSettings.328', { n: index + 1 })}</Button></div>)}
                <Button type="button" variant="link" size="sm" className="h-auto min-h-9 whitespace-normal" onClick={() => setRows(previous => [...previous, { scene: '', mode: 'singing' }])}>{t('settings.ObsModeRoutingSettings.329')}</Button>
            </div>}
            <Button type="button" onClick={save} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('settings.ObsModeRoutingSettings.330')}</Button>
        </fieldset>
        {message && <p role="status">{renderNotice(t, message)}</p>}
    </section>;
}

import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { readUpdatePolicy, saveUpdatePolicy } from '@/hooks/useUpdates';
import { desktopApi } from '@/api/desktop';

export function UpdatePreferences() {
    const t = useMessages();
    const [policy, setPolicy] = useState(readUpdatePolicy);
    const [standalone, setStandalone] = useState(false);
    useEffect(() => { let active = true; desktopApi.getDistribution().then(d => { if (active) setStandalone(d === 'standalone'); }).catch(() => {}); return () => { active = false; }; }, []);
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">{t('settings.UpdatePreferences.434')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.UpdatePreferences.435')}</p>
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={!standalone} checked={policy.automatic} onChange={e => { const next = { ...policy, automatic: e.target.checked }; saveUpdatePolicy(next); setPolicy(next); }} />{t('settings.UpdatePreferences.436')}</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={!standalone || !policy.automatic} checked={policy.download} onChange={e => { const next = { ...policy, download: e.target.checked }; saveUpdatePolicy(next); setPolicy(next); }} />{t('settings.UpdatePreferences.437')}</label>
        <p className="text-xs text-muted-foreground">{t('settings.UpdatePreferences.438')}</p>
    </section>;
}

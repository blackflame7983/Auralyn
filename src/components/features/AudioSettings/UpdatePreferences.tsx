import { Checkbox } from '@/components/ui/Checkbox';
import { useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';
import { readUpdatePolicy, saveUpdatePolicy } from '@/hooks/useUpdates';
import { useStandaloneDistribution } from '@/hooks/useStandaloneDistribution';
import { InfoPopover } from '@/components/ui/InfoPopover';

export function UpdatePreferences() {
    const t = useMessages();
    const [policy, setPolicy] = useState(readUpdatePolicy);
    const standalone = useStandaloneDistribution();
    const downloadDisabled = !standalone || !policy.automatic;
    return <section className="space-y-3 rounded-card border border-border p-4">
        <div className="flex items-center gap-1"><h3 className="text-ui-control font-semibold">{t('settings.UpdatePreferences.434')}</h3>
            <InfoPopover label={t('settings.UpdatePreferences.434')}>{t('settings.UpdatePreferences.435')}</InfoPopover>
        </div>
        <label className="flex gap-2 text-ui-control"><Checkbox disabled={!standalone} checked={policy.automatic} onChange={e => { const next = { ...policy, automatic: e.target.checked }; saveUpdatePolicy(next); setPolicy(next); }} />{t('settings.UpdatePreferences.436')}</label>
        <label className="flex gap-2 text-ui-control"><Checkbox disabled={downloadDisabled} aria-describedby={standalone && !policy.automatic ? 'update-download-reason' : undefined} checked={policy.download} onChange={e => { const next = { ...policy, download: e.target.checked }; saveUpdatePolicy(next); setPolicy(next); }} />{t('settings.UpdatePreferences.437')}</label>
        {standalone && !policy.automatic && <p id="update-download-reason" className="text-ui-support text-muted-foreground">{t('settings.update.downloadNeedsCheck', { check: t('settings.UpdatePreferences.436') })}</p>}
        {!standalone && <p className="text-ui-support text-muted-foreground">{t('settings.UpdatePreferences.438')}</p>}
    </section>;
}

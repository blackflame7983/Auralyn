import { Button } from '@/components/ui/button';
import { useOutputDeviceName } from '@/hooks/useOutputDeviceName';
import type { LiveOutputConfig } from '@/api/liveOutput';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';

export function RouteSummary({ routing, output, onSettings, resolvedName }: { routing: LiveOutputConfig; output?: string; onSettings: () => void; resolvedName?: string | null }) {
    const t = useMessages();
    const id = routing.deviceId;
    const fetchedName = useOutputDeviceName(resolvedName === undefined ? id : undefined);
    const name = resolvedName ?? fetchedName ?? t('flow.unknown');
    return <div className="rounded-control border border-border p-3 text-ui-support space-y-1 break-words" aria-label={t('flow.routes')}>
        <p>{t('flow.monitorDestination', { device: output ? deviceDisplayName(output) : t('master.unset') })}</p>
        <p>{t('flow.broadcastDestination', { device: id ? name : t('flow.noBranch'), processing: t(routing.splitProcessing ? 'flow.separateProcessing' : 'flow.sharedProcessing') })}</p>
        <p className="text-muted-foreground">{t('flow.trimScope')}</p>
        <Button variant="link" size="sm" type="button" onClick={onSettings}>{t('flow.routeDetails')}</Button>
    </div>;
}

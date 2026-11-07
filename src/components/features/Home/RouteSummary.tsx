import { useOutputDeviceName } from '@/hooks/useOutputDeviceName';
import type { LiveOutputConfig } from '@/api/liveOutput';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';

export function RouteSummary({ routing, output, onSettings, resolvedName }: { routing: LiveOutputConfig; output?: string; onSettings: () => void; resolvedName?: string | null }) {
    const t = useMessages();
    const id = routing.deviceId;
    const fetchedName = useOutputDeviceName(resolvedName === undefined ? id : undefined);
    const name = resolvedName ?? fetchedName ?? t('flow.unknown');
    return <div className="rounded border border-border p-3 text-xs space-y-1 break-words" aria-label={t('flow.routes')}>
        <p>{t('flow.monitorDestination', { device: output ? deviceDisplayName(output) : t('master.unset') })}</p>
        <p>{t('flow.broadcastDestination', { device: id ? name : t('flow.noBranch'), processing: t(routing.splitProcessing ? 'flow.separateProcessing' : 'flow.sharedProcessing') })}</p>
        <p className="text-muted-foreground">{t('flow.trimScope')}</p>
        <button type="button" onClick={onSettings} className="underline underline-offset-2">{t('flow.routeDetails')}</button>
    </div>;
}

// 畳んだホームでは、配信用の出力と受け側、自分用の分岐を同じ行で示す。
export function RouteLine({ output, broadcastName, split, receiver, local = false }: { output?: string; broadcastName?: string | null; split: boolean; receiver: string; local?: boolean }) {
    const t = useMessages();
    const monitor = output ? deviceDisplayName(output) : t('master.unset');
    return <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 break-words text-ui-support">
        <span>{local && !split ? t('flow.monitorDestination', { device: monitor }) : t('flow.routeLine', { device: split ? broadcastName ?? t('flow.unknown') : monitor, receiver })}</span>
        {split && <span>{t('flow.monitorDestination', { device: monitor })}</span>}
    </span>;
}

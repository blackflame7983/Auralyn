import { useEffect, useState } from 'react';
import { audioApi } from '@/api/audio';
import type { LiveOutputConfig } from '@/api/liveOutput';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';

export function RouteSummary({ routing, output, onSettings }: { routing: LiveOutputConfig; output?: string; onSettings: () => void }) {
    const t = useMessages();
    const id = routing.deviceId;
    const [resolved, setResolved] = useState<{ id: string; name: string } | null>(null);
    useEffect(() => {
        let current = true;
        if (!id) return;
        // 配信用Sinkは主経路がASIOでもWASAPI。安定IDを機器名として出さない。選択が変わったときだけ既存一覧を取得する。
        void audioApi.getDevices().then(devices => {
            const matches = devices.outputs.filter(device => device.id === id && device.host.toLowerCase().includes('wasapi'));
            if (current) setResolved(matches.length === 1 ? { id, name: matches[0].name } : null);
        }).catch(() => { if (current) setResolved(null); });
        return () => { current = false; };
    }, [id]);
    const name = resolved?.id === id ? resolved.name : t('flow.unknown');
    return <div className="rounded border border-border p-3 text-xs space-y-1 break-words" aria-label={t('flow.routes')}>
        <p>{t('flow.monitorDestination', { device: output ? deviceDisplayName(output) : t('master.unset') })}</p>
        <p>{t('flow.broadcastDestination', { device: id ? name : t('flow.noBranch'), processing: t(routing.splitProcessing ? 'flow.separateProcessing' : 'flow.sharedProcessing') })}</p>
        <p className="text-muted-foreground">{t('flow.trimScope')}</p>
        <button type="button" onClick={onSettings} className="underline underline-offset-2">{t('flow.routeDetails')}</button>
    </div>;
}

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useMessages } from '@/i18n/LocaleProvider';
import { useRuntimeStats } from '@/hooks/useRuntimeStats';

// ラックを閉じている間も、統計を購読している側で停止を一度だけ知らせる。
// 知らせた停止は id ごとに token と isolationSeq で覚える。統計の欠測（null）や
// カードの付け直しでは消さない。世代が変わったときだけ、正常な統計を挟まなくても知らせる。
function noticeKey(entry: { token?: number; isolationSeq?: number }): string {
    return `${entry.token ?? 0}:${entry.isolationSeq ?? 0}`;
}

export function usePluginHealthNotices(plugins: readonly { id: string; name: string }[]) {
    const stats = useRuntimeStats();
    const t = useMessages();
    const announced = useRef(new Map<string, string>());
    useEffect(() => {
        if (stats == null) return;
        const isolated = new Map<string, string>();
        for (const entry of stats.pluginHealth ?? []) {
            if (entry.state !== 'isolated') continue;
            isolated.set(entry.id, noticeKey(entry));
        }
        for (const id of [...announced.current.keys()]) {
            if (announced.current.get(id) !== isolated.get(id)) announced.current.delete(id);
        }
        for (const [id, key] of isolated) {
            if (announced.current.get(id) === key) continue;
            const name = plugins.find(plugin => plugin.id === id)?.name;
            if (!name) continue;
            announced.current.set(id, key);
            toast.warning(t('rack.card.isolatedToast', { arg0: name }));
        }
    }, [stats, plugins, t]);
}

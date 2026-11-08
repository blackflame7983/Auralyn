import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useMessages } from '@/i18n/LocaleProvider';
import { useRuntimeStats } from '@/hooks/useRuntimeStats';

// ラックを閉じている間も、統計を購読している側で停止を一度だけ知らせる。
// 統計の欠測（null）では通知済みを消さない。再開・削除・token 変更で
// 実スナップショットからその停止が消えたときだけ、次の停止を新しいものとして扱う。
export function usePluginHealthNotices(plugins: readonly { id: string; name: string }[]) {
    const stats = useRuntimeStats();
    const t = useMessages();
    const announced = useRef(new Set<string>());
    useEffect(() => {
        if (stats == null) return;
        const isolated = new Set(
            (stats.pluginHealth ?? []).filter(entry => entry.state === 'isolated').map(entry => entry.id),
        );
        for (const id of [...announced.current]) {
            if (!isolated.has(id)) announced.current.delete(id);
        }
        for (const id of isolated) {
            if (announced.current.has(id)) continue;
            const name = plugins.find(plugin => plugin.id === id)?.name;
            if (!name) continue;
            announced.current.add(id);
            toast.warning(t('rack.card.isolatedToast', { arg0: name }));
        }
    }, [stats, plugins, t]);
}

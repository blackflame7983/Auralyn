import { useEffect, useState } from 'react';
import { readUpdatePolicy, saveUpdatePolicy } from '@/hooks/useUpdates';
import { desktopApi } from '@/api/desktop';

export function UpdatePreferences() {
    const [policy, setPolicy] = useState(readUpdatePolicy);
    const [standalone, setStandalone] = useState(false);
    useEffect(() => { let active = true; desktopApi.getDistribution().then(d => { if (active) setStandalone(d === 'standalone'); }).catch(() => {}); return () => { active = false; }; }, []);
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">アップデートの確認</h3>
        <p className="text-xs text-muted-foreground">通常版は起動後と約1日ごとに確認します。ダウンロードしても、適用操作を行うまで音声の停止や再起動はしません。Store版はStoreの設定に従います。</p>
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={!standalone} checked={policy.automatic} onChange={e => { const next = { ...policy, automatic: e.target.checked }; saveUpdatePolicy(next); setPolicy(next); }} />起動時・定期的に更新を確認</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={!standalone || !policy.automatic} checked={policy.download} onChange={e => { const next = { ...policy, download: e.target.checked }; saveUpdatePolicy(next); setPolicy(next); }} />インストール版の更新を自動ダウンロード</label>
        <p className="text-xs text-muted-foreground">Portable版・インストール先が不明な場合は配布ページから更新します。数日間の試験中は、更新の自動確認をOFFにして同じ版を使ってください。</p>
    </section>;
}

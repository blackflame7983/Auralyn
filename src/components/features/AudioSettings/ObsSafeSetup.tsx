import { useEffect, useRef, useState } from 'react';
import { obsApi, type ObsSetupPlan, type ObsSetupHistory } from '@/api/obs';

const valueLabel = (value: unknown): string => {
    if (value === null) return 'なし';
    if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
    if (value === 'OBS_MONITORING_TYPE_NONE') return 'モニターOFF';
    if (value === 'OBS_MONITORING_TYPE_MONITOR_ONLY') return 'モニターのみ';
    if (value === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') return 'モニターと出力';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

export function ObsSafeSetup({ disabled, onBusyChange, onOpenGuide }: { disabled: boolean; onBusyChange: (busy: boolean) => void; onOpenGuide?: () => void }) {
    const [plan, setPlan] = useState<ObsSetupPlan | null>(null);
    const [history, setHistory] = useState<ObsSetupHistory[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef(false);
    useEffect(() => {
        let active = true;
        obsApi.setupHistory().then(items => { if (active) setHistory(current => [...items.filter(item => !current.some(h => h.id === item.id)), ...current]); }).catch(e => { if (active) setError(String(e)); });
        return () => { active = false; };
    }, []);
    useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
    const run = async (action: () => Promise<void>) => {
        if (inFlight.current || disabled) return;
        inFlight.current = true;
        setBusy(true); setError(null);
        try { await action(); } catch (e) { setError(String(e)); }
        finally { inFlight.current = false; setBusy(false); }
    };
    const preview = (source?: string) => run(async () => {
        setPlan(null);
        setPlan(await obsApi.previewSetup(source));
    });
    const buttonClass = 'rounded border border-border px-3 py-2 hover:bg-muted disabled:opacity-50';
    return <section aria-label="OBS の変更確認と復元" className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">現在の設定と変更予定を確認してから適用します。配信・録画を停止してご利用ください。音量・フィルターは変更しません。</p>
        <button type="button" className={buttonClass} disabled={busy || disabled} onClick={() => void preview()}>変更予定を確認する</button>
        {onOpenGuide && <button type="button" className={buttonClass} disabled={busy} onClick={onOpenGuide}>手動の接続手順を開く</button>}
        {error && <p role="alert" className="text-amber-500 break-words">{error} 適用中の通信エラーの場合は、履歴を再取得して状態を確認してください。</p>}
        {plan && <div className="rounded border border-border p-3 space-y-3" aria-label="OBS の変更予定">
            {plan.message && <p>{plan.message}</p>}
            {plan.changes.length > 0 ? <ul className="space-y-2">{plan.changes.map((c, i) => <li key={i} className="break-words">
                <strong>{c.source}：{c.label}</strong>
                <p className="text-xs text-muted-foreground">{c.beforeDisplay ?? valueLabel(c.before)} → {c.afterDisplay ?? valueLabel(c.after)}</p>
            </li>)}</ul> : plan.supported && <p>変更が必要な項目はありません。</p>}
            {plan.supported && plan.changes.length > 0 && <button type="button" className={buttonClass} disabled={busy || disabled} onClick={() => void run(async () => {
                const result = await obsApi.applySetup(plan.id);
                setHistory(items => [...items, result]); setPlan(null);
            })}>この変更を適用する</button>}
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setPlan(null)}>キャンセル</button>
            {plan.supported && plan.duplicateMicSources.length > 0 && <div className="space-y-2">
                <p>他のマイクも有効です。二重取りの可能性があります。</p>
                {plan.duplicateMicSources.map(name => <button key={name} type="button" className={`${buttonClass} block break-all`} disabled={busy || disabled} onClick={() => void preview(name)}>「{name}」のミュート予定を確認</button>)}
            </div>}
        </div>}
        <p className="text-xs text-muted-foreground">履歴は今回の接続中のみ保持します。再接続・切断・アプリ終了で消えます。同じソースは新しい履歴から復元し、後から変更された値は上書きしません。</p>
        <button type="button" className={buttonClass} disabled={busy || disabled} onClick={() => void run(async () => { setHistory(await obsApi.setupHistory()); setPlan(null); })}>履歴を再取得</button>
        {history.length > 0 && <ol className="space-y-3" aria-label="OBS の変更履歴">{[...history].reverse().map(h => <li key={h.id} className="rounded border border-border p-3 space-y-2">
            <p>変更 #{h.id}</p>
            <ul>{h.changes.map((c, i) => <li key={i} className="break-words">{c.source}：{c.label} — {h.results[i]}</li>)}</ul>
            <button type="button" className={buttonClass} disabled={busy || disabled} onClick={() => void run(async () => {
                setPlan(null);
                const result = await obsApi.restoreSetup(h.id);
                setHistory(items => items.map(item => item.id === result.id ? result : item));
            })}>変更 #{h.id} を元に戻す</button>
        </li>)}</ol>}
    </section>;
}

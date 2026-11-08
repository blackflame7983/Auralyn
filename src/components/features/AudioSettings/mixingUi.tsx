import { useEffect, useRef, useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

export const mixingCard = 'min-w-0 space-y-3 rounded-card border border-border bg-card p-4';
export const framesToMs = (frames: number | null | undefined, rate: number | null | undefined) =>
    frames != null && rate && rate > 0 ? `${(frames * 1000 / rate).toFixed(1)} ms` : null;

// 連続操作は最後の値へまとめ、処理中の要求の後に直列で送る。失敗後は自動再試行しない。
export function useQueuedChange<T>(send: (value: T) => Promise<unknown>, delay = 120) {
    const latest = useRef(send); latest.current = send;
    const pending = useRef<{ value: T } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const active = useRef(true), running = useRef(false), generation = useRef(0);
    const cancel = () => { generation.current++; pending.current = null; if (timer.current) clearTimeout(timer.current); timer.current = null; };
    const flush = async () => {
        timer.current = null;
        if (!active.current || running.current || !pending.current) return;
        const value = pending.current.value, ticket = generation.current; pending.current = null; running.current = true;
        try { const result = await latest.current(value); if (ticket === generation.current && (result === null || result === false)) cancel(); }
        catch { if (ticket === generation.current) cancel(); }
        finally { running.current = false; if (active.current && pending.current) timer.current = setTimeout(() => void flush(), delay); }
    };
    useEffect(() => { active.current = true; return () => { active.current = false; cancel(); }; }, []);
    return { cancel, enqueue: (value: T) => { pending.current = { value }; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), delay); } };
}

type Versioned = { epoch: string; revision: string; error: string | null };
export function useRevisionedResource<T extends Versioned>(read: () => Promise<T>, open: boolean, visible: () => boolean) {
    const [snapshot, setSnapshot] = useState<T | null>(null);
    const [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
    const [error, setError] = useState<{ operation: MessageKey; raw: string } | null>(null);
    const state = useRef({ sequence: 0, busy: false, stale: false, witness: null as T | null });
    const latestRead = useRef(read); latestRead.current = read;
    const latestVisible = useRef(visible); latestVisible.current = visible;
    useEffect(() => () => { state.current.sequence++; state.current.busy = false; }, []);
    const run = async (operation: MessageKey, work?: (witness: T) => Promise<T>): Promise<T | null> => {
        const current = state.current;
        if (current.busy || (work && (!current.witness || current.stale))) return null;
        const ticket = ++current.sequence; current.busy = true; setBusy(true); setError(null);
        try {
            const next = await (work ? work(current.witness!) : latestRead.current());
            if (ticket !== current.sequence) return null;
            current.witness = next; current.stale = false; setStale(false); setSnapshot(next);
            if (next.error) setError({ operation, raw: next.error });
            return next;
        } catch (e) {
            if (ticket === current.sequence) { setError({ operation, raw: String(e) }); current.stale = true; setStale(true); }
            return null;
        } finally { if (ticket === current.sequence) { current.busy = false; setBusy(false); } }
    };
    useEffect(() => {
        if (!open || !snapshot) return;
        let disposed = false, reading = false;
        const timer = setInterval(async () => {
            if (reading || state.current.busy || document.hidden || !latestVisible.current()) return;
            reading = true; const ticket = state.current.sequence;
            try {
                const next = await latestRead.current();
                if (!disposed && ticket === state.current.sequence) {
                    const witness = state.current.witness;
                    if (witness && (next.epoch !== witness.epoch || next.revision !== witness.revision)) { state.current.stale = true; setStale(true); }
                    setSnapshot(next);
                    if (next.error) setError({ operation: 'mixingUi.read', raw: next.error });
                }
            } catch (e) { if (!disposed && ticket === state.current.sequence) setError({ operation: 'mixingUi.read', raw: String(e) }); }
            finally { reading = false; }
        }, 1000);
        return () => { disposed = true; clearInterval(timer); };
    }, [open, !!snapshot]);
    return { snapshot, busy, stale, error, run, report: (operation: MessageKey, e: unknown) => setError({ operation, raw: String(e) }) };
}

export function MixingError({ error, draftRetained = true }: { draftRetained?: boolean; error: { operation: MessageKey; raw: string } | null }) {
    const t = useMessages();
    if (!error) return null;
    const category: MessageKey = /stale|revision|epoch|conflict|changed|競合|設定が変わ|外部.*変更|世代|リビジョン/i.test(error.raw) ? 'mixingUi.conflict'
        : /not found|missing|見つか|存在し|不在|見当た|がありません/i.test(error.raw) ? 'mixingUi.missing'
        : /corrupt|parse|invalid.*file|破損|decode|解析|形式が|JSON|unexpected.*EOF/i.test(error.raw) ? 'mixingUi.corrupt'
        : /unsupported|not supported|unknown command|unknown variant|非対応|対応してい/i.test(error.raw) ? 'mixingUi.unsupported' : 'mixingUi.unavailable';
    return <div role="alert" className={`space-y-2 ${draftRetained ? 'text-ui-support' : 'text-sm'} text-destructive-text`}>
        <p>{t(draftRetained ? 'mixingUi.failure' : 'mixingUi.runtimeFailure', { operation: t(error.operation), cause: t(category) })}</p>
        <details><summary className="cursor-pointer">{t('mixingUi.details')}</summary><p className="break-all whitespace-pre-wrap">{error.raw}</p></details>
    </div>;
}

export function GainControl({ label, value, disabled, onChange, settings = false }: { label: string; value: number; disabled?: boolean; onChange: (value: number) => void; settings?: boolean }) {
    const percent = `${Math.round(value * 100)}%`;
    return <div className="flex min-w-0 items-center gap-3 py-2"><span className={settings ? 'text-ui-control' : 'text-sm'}>{label}</span>
        <Slider aria-label={label} aria-valuetext={percent} disabled={disabled} value={[value]} min={0} max={2} step={0.01} onValueChange={v => onChange(v[0])} className="min-w-12 flex-1" />
        <output className={`w-12 text-right ${settings ? 'text-ui-support' : 'text-sm'} tabular-nums`}>{percent}</output></div>;
}

export function ScopeDisclosure({ summary, detail, settings = false }: { summary: MessageKey; detail: MessageKey; settings?: boolean }) {
    const t = useMessages();
    return <div className={`space-y-1 ${settings ? 'text-ui-support' : 'text-xs'} text-muted-foreground`}><p>{t(summary)}</p><details><summary className="cursor-pointer">{t('mixingUi.scope')}</summary><p className="mt-2">{t(detail)}</p></details></div>;
}

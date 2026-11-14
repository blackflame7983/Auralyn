import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { Switch } from '@/components/ui/switch';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { useEffect, useId, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { peakProtectionApi, type PeakConfig, type PeakStatus } from '@/api/peakProtection';
import { useMessages } from '@/i18n/LocaleProvider';

export function PeakProtectionPanel({ onPendingChange, hideApplyNote = false, numericDetails = false }: {
    onPendingChange?: (pending: boolean) => void;
    hideApplyNote?: boolean;
    /** 「数値の詳細を表示」が ON のときは、詳しい設定を開く。 */
    numericDetails?: boolean;
} = {}) {
    const t = useMessages();
    const headingId = useId();
    const [status, setStatus] = useState<PeakStatus | null>(null);
    const [ceiling, setCeiling] = useState(-1);
    const [release, setRelease] = useState(100);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(numericDetails);
    const alive = useRef(false);
    const version = useRef(0);
    const writing = useRef(false);
    const edited = useRef(false);
    useEffect(() => {
        alive.current = true; let active = true; let reading = false;
        const read = async () => {
            if (reading || writing.current || isAppHidden()) return;
            reading = true; const serial = version.current;
            try {
                const next = await peakProtectionApi.request();
                if (active && serial === version.current) { setStatus(next); setFailed(false); if (!edited.current) { setCeiling(next.config.ceilingDb); setRelease(next.config.releaseMs); } }
            } catch { if (active && serial === version.current) { setStatus(null); setFailed(true); } }
            finally { reading = false; }
        };
        const invalidate = () => { version.current++; setStatus(null); void read(); };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'].map(e => listen(e, invalidate));
        const visible = () => { if (!isAppHidden()) void read(); };
        addAppVisibilityListener(visible);
        void read(); const timer = setInterval(() => { void read(); }, 500);
        return () => { active = false; alive.current = false; version.current++; clearInterval(timer); removeAppVisibilityListener(visible); subscriptions.forEach(p => { void p.then(fn => fn()).catch(() => {}); }); };
    }, []);
    // 数値の詳細を出したときは、天井と復帰時間を開く。利用者が閉じても、設定が ON のあいだは開き直さない。
    useEffect(() => { if (numericDetails) setDetailsOpen(true); }, [numericDetails]);
    const write = async (config: PeakConfig) => {
        if (!status || writing.current || isAppHidden()) return;
        writing.current = true; setBusy(true); setFailed(false); const serial = ++version.current;
        try {
            const next = await peakProtectionApi.request(config);
            if (alive.current && serial === version.current) { setStatus(next); window.dispatchEvent(new Event('preparation-external-change')); }
        } catch { if (alive.current && serial === version.current) { setStatus(null); setFailed(true); } }
        finally { writing.current = false; if (alive.current) setBusy(false); }
    };
    // ON はいまの天井と復帰時間で適用する。OFF は保存済みの数値のまま止める。
    const setEnabled = (enabled: boolean) => {
        if (!status) return;
        void write(enabled ? { enabled, ceilingDb: ceiling, releaseMs: release } : { ...status.config, enabled });
    };
    // 数値の適用は ON と OFF を変えない。
    const applyValues = () => {
        if (!status) return;
        void write({ enabled: status.config.enabled, ceilingDb: ceiling, releaseMs: release });
    };
    const pending = status != null && (ceiling !== status.config.ceilingDb || release !== status.config.releaseMs);
    useEffect(() => {
        onPendingChange?.(pending);
        return () => onPendingChange?.(false);
    }, [pending, onPendingChange]);
    const valuesInvalid = !Number.isFinite(ceiling) || ceiling < -12 || ceiling > -0.1 || !Number.isFinite(release) || release < 20 || release > 1000;
    const enabled = status?.config.enabled ?? false;
    const applyDisabled = !status || busy || valuesInvalid;
    // 無効な数値のまま ON にはしない。OFF は保存済みの数値で止められる。
    const switchDisabled = !status || busy || (!enabled && valuesInvalid);
    return <section aria-label={t('peak.title')} className="p-4 rounded-card border space-y-3">
        <div className="flex items-center justify-between gap-3">
            <h3 id={headingId} className="text-ui-heading font-semibold">{t('peak.title')}</h3>
            <Switch checked={enabled} disabled={switchDisabled} onCheckedChange={setEnabled} aria-labelledby={headingId} />
        </div>
        <p className="text-ui-support text-muted-foreground">{t('peak.lead')}</p>
        <p className="text-ui-support text-muted-foreground">{t('peak.scope')}</p>
        {!hideApplyNote && <p className="text-ui-support text-muted-foreground">{t('settings.apply.protectionDraft')}</p>}
        <p role="status" className="text-ui-support">{!status ? t('peak.unknown') : t(status.config.enabled ? 'peak.on' : 'peak.off')}
            {status?.config.enabled && ` · ${status.config.ceilingDb.toFixed(1)} dBFS / ${status.config.releaseMs} ms`}
            {status?.pending && ` · ${t('peak.pending')}`}
            {status && !status.running && ` · ${t('peak.stopped')}`}
        </p>
        {status && <p className="text-ui-support">{t('peak.reduction', { db: Math.max(0, status.reductionDb).toFixed(1) })}</p>}
        <details open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)} className="text-ui-support">
            <summary className="cursor-pointer text-ui-control font-semibold">{t('peak.details')}</summary>
            <div className="mt-3 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                    <Field label={t('peak.ceiling')}><Input type="number"  min={-12} max={-0.1} step={0.1} value={ceiling} onChange={e => { edited.current = true; setCeiling(e.target.valueAsNumber); }} /></Field>
                    <Field label={t('peak.release')}><Input type="number"  min={20} max={1000} step={10} value={release} onChange={e => { edited.current = true; setRelease(e.target.valueAsNumber); }} /></Field>
                </div>
                <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={applyDisabled} onClick={applyValues}>{t('peak.apply')}</Button>
            </div>
        </details>
        <details className="text-ui-support text-muted-foreground"><summary className="cursor-pointer">{t('peak.limitsTitle')}</summary><p className="mt-2">{t('peak.limits')}</p></details>
        {failed && <p role="alert" className="text-ui-support">{t('peak.failed')}</p>}
    </section>;
}

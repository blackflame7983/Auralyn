import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { peakProtectionApi, type PeakStatus } from '@/api/peakProtection';
import { useMessages } from '@/i18n/LocaleProvider';

export function PeakProtectionPanel() {
    const t = useMessages();
    const [status, setStatus] = useState<PeakStatus | null>(null);
    const [ceiling, setCeiling] = useState(-1);
    const [release, setRelease] = useState(100);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
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
    const apply = async (enabled: boolean) => {
        if (!status || writing.current || isAppHidden()) return;
        writing.current = true; setBusy(true); setFailed(false); const serial = ++version.current;
        try {
            const next = await peakProtectionApi.request(enabled ? { enabled, ceilingDb: ceiling, releaseMs: release } : { ...status.config, enabled });
            if (alive.current && serial === version.current) { setStatus(next); window.dispatchEvent(new Event('preparation-external-change')); }
        } catch { if (alive.current && serial === version.current) { setStatus(null); setFailed(true); } }
        finally { writing.current = false; if (alive.current) setBusy(false); }
    };
    return <section aria-label={t('peak.title')} className="p-4 rounded-xl border space-y-3">
        <h3 className="text-ui-heading font-semibold">{t('peak.title')}</h3>
        <p className="text-ui-support text-muted-foreground">{t('peak.scope')}</p>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <label className="text-ui-control">{t('peak.ceiling')}<input type="number" className="block w-full border rounded bg-background p-2" min={-12} max={-0.1} step={0.1} value={ceiling} onChange={e => { edited.current = true; setCeiling(e.target.valueAsNumber); }} /></label>
            <label className="text-ui-control">{t('peak.release')}<input type="number" className="block w-full border rounded bg-background p-2" min={20} max={1000} step={10} value={release} onChange={e => { edited.current = true; setRelease(e.target.valueAsNumber); }} /></label>
        </div>
        <p role="status" className="text-sm">{!status ? t('peak.unknown') : t(status.config.enabled ? 'peak.on' : 'peak.off')}
            {status?.config.enabled && ` · ${status.config.ceilingDb.toFixed(1)} dBFS / ${status.config.releaseMs} ms`}
            {status?.pending && ` · ${t('peak.pending')}`}
            {status && !status.running && ` · ${t('peak.stopped')}`}
        </p>
        {status && <p className="text-ui-support">{t('peak.reduction', { db: Math.max(0, status.reductionDb).toFixed(1) })}</p>}
        <button type="button" className="border rounded px-3 py-2 disabled:opacity-50 text-ui-control" disabled={!status || busy || !Number.isFinite(ceiling) || ceiling < -12 || ceiling > -0.1 || !Number.isFinite(release) || release < 20 || release > 1000} onClick={() => void apply(true)}>{t(status?.config.enabled ? 'peak.apply' : 'peak.enable')}</button>
        <button type="button" className="border rounded px-3 py-2 ml-2 disabled:opacity-50 text-ui-control" disabled={!status?.config.enabled || busy} onClick={() => void apply(false)}>{t('peak.disable')}</button>
        <details className="text-ui-support text-muted-foreground"><summary className="cursor-pointer">{t('peak.limitsTitle')}</summary><p className="mt-2">{t('peak.limits')}</p></details>
        {failed && <p role="alert" className="text-sm">{t('peak.failed')}</p>}
    </section>;
}

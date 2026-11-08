import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { broadcastTruePeakApi, type BroadcastTruePeakStatus } from '@/api/broadcastTruePeak';
import { useMessages } from '@/i18n/LocaleProvider';

export function BroadcastTruePeakPanel() {
    const t = useMessages();
    const [status, setStatus] = useState<BroadcastTruePeakStatus | null>(null);
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
                const next = await broadcastTruePeakApi.request();
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
            const next = await broadcastTruePeakApi.request(enabled ? { enabled, ceilingDb: ceiling, releaseMs: release } : { ...status.config, enabled });
            if (alive.current && serial === version.current) { setStatus(next); window.dispatchEvent(new Event('preparation-external-change')); }
        } catch { if (alive.current && serial === version.current) { setStatus(null); setFailed(true); } }
        finally { writing.current = false; if (alive.current) setBusy(false); }
    };
    return <section aria-label={t('truePeak.title')} className="p-4 rounded-card border space-y-3">
        <h3 className="text-ui-heading font-semibold">{t('truePeak.title')}</h3>
        <p className="text-ui-support text-muted-foreground">{t('truePeak.scope')}</p>
        <div className="grid sm:grid-cols-2 gap-3 text-ui-support">
            <Field label={t('truePeak.ceiling')}><Input type="number" min={-12} max={-0.1} step={0.1} value={ceiling} onChange={e => { edited.current = true; setCeiling(e.target.valueAsNumber); }} /></Field>
            <Field label={t('truePeak.release')}><Input type="number" min={20} max={1000} step={10} value={release} onChange={e => { edited.current = true; setRelease(e.target.valueAsNumber); }} /></Field>
        </div>
        <p role="status" className="text-ui-support">{!status ? t('truePeak.unknown') : t(status.config.enabled ? 'truePeak.on' : 'truePeak.off')}
            {status?.config.enabled && ` · ${status.config.ceilingDb.toFixed(1)} dBFS / ${status.config.releaseMs} ms`}
            {status?.pending && ` · ${t('truePeak.pending')}`}
            {status && !status.running && ` · ${t('truePeak.stopped')}`}
        </p>
        {status && <p className="text-ui-support">{t('truePeak.reduction', { db: Math.max(0, status.reductionDb).toFixed(1) })}</p>}
        {status && <p className="text-ui-support">{t('truePeak.latency', { samples: String(status.addedLatencySamples) })}</p>}
        <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={!status || busy || !Number.isFinite(ceiling) || ceiling < -12 || ceiling > -0.1 || !Number.isFinite(release) || release < 20 || release > 1000} onClick={() => void apply(true)}>{t(status?.config.enabled ? 'truePeak.apply' : 'truePeak.enable')}</Button>
        <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={!status?.config.enabled || busy} onClick={() => void apply(false)}>{t('truePeak.disable')}</Button>
        <details className="text-ui-support text-muted-foreground"><summary className="cursor-pointer">{t('truePeak.limitsTitle')}</summary><p className="mt-2">{t('truePeak.limits')}</p></details>
        {failed && <p role="alert" className="text-ui-support">{t('truePeak.failed')}</p>}
    </section>;
}

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sessionMode } from '@/lib/temporarySession';
import { useMessages } from '@/i18n/LocaleProvider';

export function TemporarySessionPanel() {
    const t = useMessages();
    const mode = sessionMode();
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    return <details className="rounded border p-3 space-y-2">
        <summary className="cursor-pointer font-medium">{t(mode.temporary ? 'temporary.active' : 'temporary.title')}</summary>
        <p className="text-sm">{t('temporary.scope')}</p>
        <p className="text-sm text-muted-foreground">{t('temporary.outside')}</p>
        <p className="text-sm">{t(mode.temporary ? 'temporary.exitScope' : 'temporary.startScope')}</p>
        {mode.directory && <p className="break-all text-xs">{t('temporary.directory', { path: mode.directory })}</p>}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />{t('temporary.acknowledge')}</label>
        <button type="button" className="border rounded px-3 py-2 disabled:opacity-50" disabled={!acknowledged || busy} onClick={async () => {
            setBusy(true); setFailed(false);
            try { await invoke('restart_temporary_session', { temporary: !mode.temporary }); }
            catch { setFailed(true); setBusy(false); }
        }}>{t(mode.temporary ? 'temporary.finish' : 'temporary.start')}</button>
        {busy && <p role="status">{t('temporary.restarting')}</p>}
        {failed && <p role="alert">{t('temporary.failed')}</p>}
    </details>;
}

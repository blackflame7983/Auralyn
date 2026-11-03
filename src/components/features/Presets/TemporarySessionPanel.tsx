import { ScopeDisclosure } from '@/components/features/AudioSettings/mixingUi';
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
    const [preserveRuntime, setPreserveRuntime] = useState(false);
    const [detail, setDetail] = useState('');
    return <details className="rounded border p-3 space-y-2">
        <summary className="cursor-pointer font-medium">{t(mode.temporary ? 'temporary.active' : 'temporary.title')}</summary>
        <p className="text-sm">{t('temporary.scope')}</p>
        <p className="text-sm text-muted-foreground">{t('temporary.outside')}</p>
        {!mode.temporary && preserveRuntime ? <ScopeDisclosure summary="temporary.checkpointSummary" detail="temporary.checkpointScope" /> : <p className="text-sm">{t(mode.temporary ? 'temporary.exitScope' : 'temporary.startScope')}</p>}
        {mode.directory && <p className="break-all text-xs">{t('temporary.directory', { path: mode.directory })}</p>}
        {!mode.temporary && <label className="flex gap-2 text-sm"><input type="checkbox" checked={preserveRuntime} disabled={busy}
            onChange={e => { setPreserveRuntime(e.target.checked); setAcknowledged(false); setFailed(false); }} />{t('temporary.preserveRuntime')}</label>}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />{t('temporary.acknowledge')}</label>
        <button type="button" className="border rounded px-3 py-2 disabled:opacity-50" disabled={!acknowledged || busy} onClick={async () => {
            setBusy(true); setFailed(false); setDetail('');
            try { await invoke('restart_temporary_session', { temporary: !mode.temporary, ...(preserveRuntime ? { preserveRuntime: true } : {}) }); }
            catch (error) { setFailed(true); setBusy(false); setDetail(typeof error === 'string' ? error : error instanceof Error ? error.message : ''); }
        }}>{t(mode.temporary ? 'temporary.finish' : 'temporary.start')}</button>
        {busy && <p role="status">{t('temporary.restarting')}</p>}
        {failed && <p role="alert">{t('temporary.failed')}</p>}
        {failed && detail && <p className="text-xs break-all">{t('temporary.errorOriginal', { detail })}</p>}
    </details>;
}

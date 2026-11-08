import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
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
    return <details className="rounded-control border p-3 space-y-2">
        <summary className="cursor-pointer font-medium">{t(mode.temporary ? 'temporary.active' : 'temporary.title')}</summary>
        <p className="text-ui-support">{t('temporary.scope')}</p>
        <p className="text-ui-support text-muted-foreground">{t('temporary.outside')}</p>
        {!mode.temporary && preserveRuntime ? <ScopeDisclosure summary="temporary.checkpointSummary" detail="temporary.checkpointScope" /> : <p className="text-ui-support">{t(mode.temporary ? 'temporary.exitScope' : 'temporary.startScope')}</p>}
        {mode.directory && <p className="break-all text-ui-support">{t('temporary.directory', { path: mode.directory })}</p>}
        {!mode.temporary && <label className="flex gap-2 text-ui-support"><Field label={null}><Checkbox type="checkbox" checked={preserveRuntime} disabled={busy}
            onChange={e => { setPreserveRuntime(e.target.checked); setAcknowledged(false); setFailed(false); }} /></Field>{t('temporary.preserveRuntime')}</label>}
        <label className="flex gap-2 text-ui-support"><Field label={null}><Checkbox type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} /></Field>{t('temporary.acknowledge')}</label>
        <Button variant="outline" type="button"  disabled={!acknowledged || busy} onClick={async () => {
            setBusy(true); setFailed(false); setDetail('');
            try { await invoke('restart_temporary_session', { temporary: !mode.temporary, ...(preserveRuntime ? { preserveRuntime: true } : {}) }); }
            catch (error) { setFailed(true); setBusy(false); setDetail(typeof error === 'string' ? error : error instanceof Error ? error.message : ''); }
        }}>{t(mode.temporary ? 'temporary.finish' : 'temporary.start')}</Button>
        {busy && <p role="status">{t('temporary.restarting')}</p>}
        {failed && <p role="alert">{t('temporary.failed')}</p>}
        {failed && detail && <p className="text-ui-support break-all">{t('temporary.errorOriginal', { detail })}</p>}
    </details>;
}

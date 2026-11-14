import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
import { useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';
import { Modal } from '../ui/modal';
import type { AvailableUpdate } from '@/hooks/useUpdates';

export function AvailableUpdateDialog({ update, downloaded, busy, onClose, onDownload, onInstall }: {
    update: AvailableUpdate; downloaded: boolean; busy: boolean; onClose: () => void;
    onDownload: () => Promise<void>; onInstall: () => Promise<void>;
}) {
    const t = useMessages();
    const [confirmed, setConfirmed] = useState(false);
    return <Modal title={t('updates.title')} onClose={() => { if (!busy) onClose(); }}>
        <div className="modal-overlay-base"><div className="modal-surface-base flex max-h-[calc(85vh/var(--ui-zoom))] w-full max-w-lg flex-col">
            <h2 className="modal-header-base shrink-0 font-bold">{t('updates.versionTitle', { version: update.version })}</h2>
            <div className="modal-body-base space-y-4 text-ui-support">
                {update.body && <p className="text-ui-support text-muted-foreground">{t('updates.releaseNotes')}</p>}
                <p className="whitespace-pre-wrap break-words">{update.body || t('updates.noReleaseNotes')}</p>
                {update.canInstall ? <>
                    <p>{downloaded ? t('updates.downloaded') : t('updates.duringDownload')}</p>
                    <label className="flex gap-2"><Field label={null}><Checkbox type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /></Field>{t('updates.confirmInstall')}</label>
                </> : <p>{t('updates.portable')}</p>}
                <a className="underline" href="https://github.com/blackflame7983/Auralyn-Releases/releases" target="_blank" rel="noreferrer">{t('updates.openReleasePage')}</a>
            </div>
            <div className="modal-footer-base flex shrink-0 flex-wrap gap-2">
                <Button variant="outline" disabled={busy}  onClick={onClose}>{t('updates.later')}</Button>
                {update.canInstall && !downloaded && <Button variant="outline" disabled={busy}  onClick={() => void onDownload()}>{t('updates.download')}</Button>}
                {update.canInstall && downloaded && <Button variant="default" disabled={busy || !confirmed}  onClick={() => void onInstall()}>{t('updates.install')}</Button>}
            </div>
        </div></div>
    </Modal>;
}

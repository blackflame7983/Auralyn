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
        <div className="modal-overlay-base"><div className="modal-surface-base flex max-h-[85vh] w-full max-w-lg flex-col">
            <h2 className="modal-header-base shrink-0 font-bold">{t('updates.versionTitle', { version: update.version })}</h2>
            <div className="modal-body-base space-y-4 text-sm">
                {update.body && <p className="text-xs text-muted-foreground">{t('updates.releaseNotes')}</p>}
                <p className="whitespace-pre-wrap break-words">{update.body || t('updates.noReleaseNotes')}</p>
                {update.canInstall ? <>
                    <p>{downloaded ? t('updates.downloaded') : t('updates.duringDownload')}</p>
                    <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('updates.confirmInstall')}</label>
                </> : <p>{t('updates.portable')}</p>}
                <a className="underline" href="https://github.com/blackflame7983/Auralyn-Releases/releases" target="_blank" rel="noreferrer">{t('updates.openReleasePage')}</a>
            </div>
            <div className="modal-footer-base flex shrink-0 flex-wrap gap-2">
                <button disabled={busy} className="rounded border px-3 py-2" onClick={onClose}>{t('updates.later')}</button>
                {update.canInstall && !downloaded && <button disabled={busy} className="rounded border px-3 py-2" onClick={() => void onDownload()}>{t('updates.download')}</button>}
                {update.canInstall && downloaded && <button disabled={busy || !confirmed} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void onInstall()}>{t('updates.install')}</button>}
            </div>
        </div></div>
    </Modal>;
}

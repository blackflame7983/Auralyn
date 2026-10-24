import { useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';
import { desktopApi } from '../../api/desktop';
import { Modal } from '../ui/modal';
export { useUpdates as useAppUpdate } from '../../hooks/useUpdates';

export function UpdateGuide({ onClose }: { onClose: () => void }) {
    const t = useMessages();
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState(false);
    const openStore = async () => {
        setOpening(true);
        setError(false);
        try {
            await desktopApi.openSettings('storeUpdates');
        } catch {
            setError(true);
        } finally {
            setOpening(false);
        }
    };

    return (
        <Modal title={t('updates.msixTitle')} onClose={onClose}>
            <div className="modal-overlay-base">
                <div className="modal-surface-base w-full max-w-md max-h-[85vh] flex flex-col">
                    <div className="modal-header-base shrink-0 font-bold">{t('updates.msixTitle')}</div>
                    <div className="modal-body-base space-y-4 text-sm">
                        <p>{t('updates.storeInstructions')}</p>
                        <button className="px-3 py-2 rounded-md bg-primary text-primary-foreground" disabled={opening} onClick={() => void openStore()}>
                            {t('updates.openStore')}
                        </button>
                        <p>{t('updates.directMsix')}</p>
                        {error && <p role="alert">{t('updates.storeFailed')}</p>}
                    </div>
                    <div className="modal-footer-base shrink-0">
                        <button className="px-3 py-2 rounded-md bg-muted" onClick={onClose}>{t('common.close')}</button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

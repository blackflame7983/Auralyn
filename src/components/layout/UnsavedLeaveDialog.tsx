import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { acceptLeave, cancelLeave, subscribeLeave } from './pageLeave';

/** 保存していない接続・ホットキーを、黙って捨てずに確認する。主操作はページに残ること。 */
export function UnsavedLeaveDialog() {
    const t = useMessages();
    const [open, setOpen] = useState(false);
    useEffect(() => subscribeLeave(setOpen), []);
    if (!open) return null;
    return <Modal title={t('settings.leave.title')} role="alertdialog" onClose={cancelLeave}>
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 p-4 gaming:bg-background/60">
            <div className="modal-surface-base w-full max-w-md space-y-4 p-6">
                <h2 className="text-ui-heading font-semibold text-foreground">{t('settings.leave.title')}</h2>
                <div className="flex flex-wrap justify-end gap-3">
                    <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={acceptLeave}>{t('settings.leave.discard')}</Button>
                    <Button type="button" className="h-auto min-h-10 whitespace-normal" onClick={cancelLeave}>{t('settings.leave.stay')}</Button>
                </div>
            </div>
        </div>
    </Modal>;
}

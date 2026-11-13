import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useMessages } from '@/i18n/LocaleProvider';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState } from 'react';
import { acceptLeave, cancelLeave, subscribeLeave } from './pageLeave';

/** 保存していない接続・ホットキーを、黙って捨てずに確認する。主操作はページに残ること。 */
export function UnsavedLeaveDialog() {
    const t = useMessages();
    const [open, setOpen] = useState(false);
    const stayRef = useRef<HTMLButtonElement>(null);
    const descriptionId = useId();
    useEffect(() => subscribeLeave(setOpen), []);
    if (!open) return null;
    // 初めの焦点は捨てない側に置き、Enter の押し間違いで変更を失わないようにする。
    return <Modal title={t('settings.leave.title')} titleInContent descriptionId={descriptionId} role="alertdialog" onClose={cancelLeave} initialFocusRef={stayRef}>
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 p-4">
            <div className="modal-surface-base w-full max-w-md space-y-4 p-6">
                <Dialog.Title asChild><h2 className="text-ui-heading font-semibold text-foreground">{t('settings.leave.title')}</h2></Dialog.Title>
                <p id={descriptionId} className="text-ui-support text-muted-foreground">{t('settings.leave.description')}</p>
                <div className="flex flex-wrap justify-end gap-3">
                    <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={acceptLeave}>{t('settings.leave.discard')}</Button>
                    <Button ref={stayRef} type="button" className="h-auto min-h-10 whitespace-normal" onClick={cancelLeave}>{t('settings.leave.stay')}</Button>
                </div>
            </div>
        </div>
    </Modal>;
}

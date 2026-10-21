import { useState } from 'react';
import { desktopApi } from '../../api/desktop';
import { Modal } from '../ui/modal';
export { useUpdates as useAppUpdate } from '../../hooks/useUpdates';

export function UpdateGuide({ onClose }: { onClose: () => void }) {
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
        <Modal title="MSIX版の更新方法" onClose={onClose}>
            <div className="modal-overlay-base">
                <div className="modal-surface-base w-full max-w-md max-h-[85vh] flex flex-col">
                    <div className="modal-header-base shrink-0 font-bold">MSIX版の更新方法</div>
                    <div className="modal-body-base space-y-4 text-sm">
                        <p>Microsoft Storeから入手した場合は、Storeの更新画面で更新してください。自動更新はStoreの設定に従います。</p>
                        <button className="px-3 py-2 rounded-md bg-primary text-primary-foreground" disabled={opening} onClick={() => void openStore()}>
                            Microsoft Storeの更新画面を開く
                        </button>
                        <p>試作版など、MSIXファイルからインストールした場合は、同じ配布元の新しいMSIXをご利用ください。Storeからは更新されません。</p>
                        {error && <p role="alert">Storeを開けませんでした。WindowsのスタートメニューからMicrosoft Storeを開き、更新を確認してください。</p>}
                    </div>
                    <div className="modal-footer-base shrink-0">
                        <button className="px-3 py-2 rounded-md bg-muted" onClick={onClose}>閉じる</button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

import { useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import { desktopApi, type Distribution } from '../../api/desktop';
import { Modal } from '../ui/modal';

export function useAppUpdate() {
    const [distribution, setDistribution] = useState<Distribution>('unknown');
    const [busy, setBusy] = useState(false);
    const [showGuide, setShowGuide] = useState(false);

    useEffect(() => {
        let active = true;
        desktopApi.getDistribution().then(value => {
            if (active) setDistribution(value);
        }).catch(() => { /* 判定失敗時は通常版の更新を許可しない。 */ });
        return () => { active = false; };
    }, []);

    const checkUpdates = async () => {
        if (busy) return;
        setBusy(true);
        // IPC取得の失敗を、通常配布版や「最新版」として扱わない。
        try {
            const current = await desktopApi.getDistribution();
            setDistribution(current);
            if (current === 'msix') {
                setShowGuide(true);
                return;
            }
            if (current !== 'standalone') {
                toast.error('更新方法を確認できませんでした', {
                    description: 'アプリを再起動してから、もう一度お試しください。',
                });
                return;
            }
            await checkStandaloneUpdate();
        } catch {
            toast.error('更新方法を確認できませんでした', {
                description: 'アプリを再起動してから、もう一度お試しください。',
            });
        } finally {
            setBusy(false);
        }
    };

    return {
        label: distribution === 'standalone' ? 'アップデートを確認' : '更新方法を確認',
        description: distribution === 'msix' ? 'MSIX版は配布元から更新します' : 'インストール形式に合う更新方法',
        busy,
        checkUpdates,
        showGuide,
        closeGuide: () => setShowGuide(false),
    };
}

async function checkStandaloneUpdate() {
    const toastId = toast.loading('アップデートを確認中...');
    try {
        const update = await check();
        if (update) {
            toast.info(`v${update.version} が利用可能です`, {
                description: '今すぐアップデートしますか？',
                duration: 15000,
                action: {
                    label: 'アップデート',
                    onClick: async () => {
                        const dlToast = toast.loading('ダウンロード中...');
                        try {
                            await update.downloadAndInstall();
                            toast.success('インストール完了。再起動します...');
                            await relaunch();
                        } catch (e) {
                            console.error('Update install failed:', e);
                            toast.error('アップデートに失敗しました');
                        } finally {
                            toast.dismiss(dlToast);
                        }
                    },
                },
            });
        } else {
            toast.success('最新バージョンです');
        }
    } catch {
        toast.info('自動更新情報を取得できませんでした', {
            description: 'ネットワークまたは配布状況を確認し、必要に応じて公式リリースページをご利用ください。',
            action: {
                label: 'GitHub',
                onClick: () => window.open('https://github.com/blackflame7983/Auralyn-Releases/releases', '_blank'),
            },
        });
    } finally {
        toast.dismiss(toastId);
    }
}

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

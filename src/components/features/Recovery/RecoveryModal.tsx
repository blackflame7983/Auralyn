import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
import { Modal } from '../../ui/modal';
import React, { useEffect, useState } from 'react';
import { MdWarning, MdRestore, MdStop, MdRefresh } from 'react-icons/md';

interface RecoveryModalProps {
    isOpen: boolean;
    onClose: () => void;
    onRecover: (safeMode: boolean, excludePath?: string) => Promise<void>;
    onWithoutPlugins: () => Promise<void>;
    onKeepStopped: () => Promise<void>;
    error: string | null;
}

export const RecoveryModal: React.FC<RecoveryModalProps> = ({ isOpen, onClose, onRecover, onWithoutPlugins, onKeepStopped, error }) => {
    const t = useMessages();
    const [pendingPlugin, setPendingPlugin] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [recoveryError, setRecoveryError] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setRecoveryError(false);
            // Prioritize the one captured at crash time, fallback to current pending
            const detected = localStorage.getItem('vst_host_detected_crash_plugin');
            const pending = localStorage.getItem('vst_host_pending_plugin');
            setPendingPlugin(detected || pending);
        } else {
            // Cleanup on close
            localStorage.removeItem('vst_host_detected_crash_plugin');
        }
    }, [isOpen]);

    const handleAction = async (action: () => Promise<void>) => {
        setRecoveryError(false);
        setIsLoading(true);
        try {
            await action();
            onClose();
        } catch {
            setRecoveryError(true);
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    // 再表示できない復旧画面は、待機中もEscで閉じない。
    return (
        <Modal title={t('recovery.title')} onClose={onClose} dismissible={false}>
        <div className="modal-overlay-base z-[9999] bg-overlay/80">
            <div className="modal-surface-base w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">

                <div className="p-6 text-center space-y-4">
                    <div className="inline-flex justify-center items-center w-16 h-16 rounded-full bg-destructive/20 text-destructive-text mb-2">
                        <MdWarning size={32} />
                    </div>

                    <h2 className="text-ui-heading font-bold text-destructive-text">{t('recovery.title')}</h2>
                    <p className="text-muted-foreground">
                        {t('recovery.description')}<br />
                        {t('recovery.unknown')}
                    </p>

                    {pendingPlugin && (
                        <div className="bg-destructive/10 p-3 rounded-card text-ui-support text-left border border-destructive-text/20 mt-4">
                            <div className="font-bold text-destructive-text mb-1 flex items-center gap-2">
                                <MdWarning /> {t('recovery.pending')}
                            </div>
                            <div className="font-mono text-ui-support break-all text-muted-foreground">{pendingPlugin}</div>
                        </div>
                    )}

                    {recoveryError && <p role="alert" className="text-ui-support text-destructive-text">{t('recovery.failed')}</p>}
                    {error && (
                        <div className="text-ui-support text-muted-foreground bg-muted p-2 rounded-control text-left font-mono break-all max-h-24 overflow-y-auto">
                            {error}
                        </div>
                    )}

                    <div className="flex flex-col gap-3 mt-6">
                        {pendingPlugin && (
                            <Button variant="default"
                                onClick={() => void handleAction(() => onRecover(true, pendingPlugin ?? undefined))}
                                disabled={isLoading}
                                className="w-full flex items-center justify-center gap-2"
                            >
                                <MdRestore size={20} />
                                {t('recovery.exclude')}
                            </Button>
                        )}

                        <Button variant={pendingPlugin ? "outline" : "default"}
                            onClick={() => void handleAction(() => onRecover(false, undefined))}
                            disabled={isLoading}
                            className="w-full gap-2"
                        >
                            <MdRefresh size={20} />
                            {t('recovery.reload')}
                        </Button>

                        <Button variant="outline"
                            onClick={() => void handleAction(onWithoutPlugins)}
                            disabled={isLoading}
                            className="w-full"
                        >
                            {t('recovery.empty')}
                        </Button>
                        <p className="text-ui-support text-muted-foreground">{t('recovery.safety')}</p>
                        <Button variant="ghost"
                            onClick={() => void handleAction(onKeepStopped)}
                            disabled={isLoading}
                            className="w-full flex items-center justify-center gap-2"
                        >
                            <MdStop /> {t('recovery.stop')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};

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
        <div className="modal-overlay-base z-[9999] bg-black/80">
            <div className="modal-surface-base w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto border-2 border-destructive/50 bg-background">

                <div className="p-6 text-center space-y-4">
                    <div className="inline-flex justify-center items-center w-16 h-16 rounded-full bg-destructive/20 text-destructive mb-2">
                        <MdWarning size={32} />
                    </div>

                    <h2 className="text-2xl font-bold text-destructive">{t('recovery.title')}</h2>
                    <p className="text-muted-foreground">
                        {t('recovery.description')}<br />
                        {t('recovery.unknown')}
                    </p>

                    {pendingPlugin && (
                        <div className="bg-destructive/10 p-3 rounded-lg text-sm text-left border border-destructive/20 mt-4">
                            <div className="font-bold text-destructive mb-1 flex items-center gap-2">
                                <MdWarning /> {t('recovery.pending')}
                            </div>
                            <div className="font-mono text-xs break-all opacity-80">{pendingPlugin}</div>
                        </div>
                    )}

                    {recoveryError && <p role="alert" className="text-sm text-destructive">{t('recovery.failed')}</p>}
                    {error && (
                        <div className="text-xs text-muted-foreground bg-muted p-2 rounded text-left font-mono break-all max-h-24 overflow-y-auto">
                            {error}
                        </div>
                    )}

                    <div className="flex flex-col gap-3 mt-6">
                        {pendingPlugin && (
                            <button
                                onClick={() => void handleAction(() => onRecover(true, pendingPlugin ?? undefined))}
                                disabled={isLoading}
                                className="w-full py-3 bg-primary text-primary-foreground font-bold rounded-lg hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                            >
                                <MdRestore size={20} />
                                {t('recovery.exclude')}
                            </button>
                        )}

                        <button
                            onClick={() => void handleAction(() => onRecover(false, undefined))}
                            disabled={isLoading}
                            className={`w-full py-3 font-bold rounded-lg transition-colors flex items-center justify-center gap-2 border-2 
                                ${pendingPlugin
                                    ? 'bg-transparent border-primary text-primary hover:bg-primary/10'
                                    : 'bg-primary text-primary-foreground hover:bg-primary/90 border-transparent'
                                }`}
                        >
                            <MdRefresh size={20} />
                            {t('recovery.reload')}
                        </button>

                        <button
                            onClick={() => void handleAction(onWithoutPlugins)}
                            disabled={isLoading}
                            className="w-full py-2 border border-border rounded-lg"
                        >
                            {t('recovery.empty')}
                        </button>
                        <p className="text-xs text-muted-foreground">{t('recovery.safety')}</p>
                        <button
                            onClick={() => void handleAction(onKeepStopped)}
                            disabled={isLoading}
                            className="w-full py-2 text-muted-foreground rounded-lg flex items-center justify-center gap-2"
                        >
                            <MdStop /> {t('recovery.stop')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};

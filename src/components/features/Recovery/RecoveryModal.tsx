import React, { useEffect, useState } from 'react';
import { MdWarning, MdRestore, MdDeleteSweep, MdRefresh } from 'react-icons/md';

interface RecoveryModalProps {
    isOpen: boolean;
    onClose: () => void;
    onRecover: (safeMode: boolean, excludePath?: string) => Promise<void>;
    onClear: () => void;
    error: string | null;
}

export const RecoveryModal: React.FC<RecoveryModalProps> = ({ isOpen, onClose, onRecover, onClear, error }) => {
    const [pendingPlugin, setPendingPlugin] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            // Prioritize the one captured at crash time, fallback to current pending
            const detected = localStorage.getItem('vst_host_detected_crash_plugin');
            const pending = localStorage.getItem('vst_host_pending_plugin');
            setPendingPlugin(detected || pending);
        } else {
            // Cleanup on close
            localStorage.removeItem('vst_host_detected_crash_plugin');
        }
    }, [isOpen]);

    const handleRecover = async (safeMode: boolean) => {
        setIsLoading(true);
        try {
            await onRecover(safeMode, safeMode && pendingPlugin ? pendingPlugin : undefined);
            onClose();
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 p-4">
            <div className="bg-destructive/10 border-2 border-destructive/50 rounded-xl w-full max-w-lg shadow-2xl relative overflow-hidden bg-background">

                <div className="p-6 text-center space-y-4">
                    <div className="inline-flex justify-center items-center w-16 h-16 rounded-full bg-destructive/20 text-destructive mb-2">
                        <MdWarning size={32} />
                    </div>

                    <h2 className="text-2xl font-bold text-destructive">オーディオエンジンが停止しました</h2>
                    <p className="text-muted-foreground">
                        予期せぬエラーによりオーディオエンジンが終了しました。<br />
                        直前の操作が原因の可能性があります。
                    </p>

                    {pendingPlugin && (
                        <div className="bg-destructive/10 p-3 rounded-lg text-sm text-left border border-destructive/20 mt-4">
                            <div className="font-bold text-destructive mb-1 flex items-center gap-2">
                                <MdWarning /> 推定される原因:
                            </div>
                            <div className="font-mono text-xs break-all opacity-80">{pendingPlugin}</div>
                        </div>
                    )}

                    {error && (
                        <div className="text-xs text-muted-foreground bg-muted p-2 rounded text-left font-mono break-all max-h-24 overflow-y-auto">
                            {error}
                        </div>
                    )}

                    <div className="flex flex-col gap-3 mt-6">
                        {pendingPlugin && (
                            <button
                                onClick={() => handleRecover(true)}
                                disabled={isLoading}
                                className="w-full py-3 bg-primary text-primary-foreground font-bold rounded-lg hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                            >
                                <MdRestore size={20} />
                                原因のプラグインを除外して復旧 (推奨)
                            </button>
                        )}

                        <button
                            onClick={() => handleRecover(false)}
                            disabled={isLoading}
                            className={`w-full py-3 font-bold rounded-lg transition-colors flex items-center justify-center gap-2 border-2 
                                ${pendingPlugin
                                    ? 'bg-transparent border-primary text-primary hover:bg-primary/10'
                                    : 'bg-primary text-primary-foreground hover:bg-primary/90 border-transparent'
                                }`}
                        >
                            <MdRefresh size={20} />
                            全セッションを再読み込み
                        </button>

                        <button
                            onClick={() => {
                                onClear();
                                onClose();
                            }}
                            disabled={isLoading}
                            className="w-full py-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                            <MdDeleteSweep />
                            セッションを破棄して開始
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

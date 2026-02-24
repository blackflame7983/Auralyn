import React, { useState, useCallback, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { MdWarning } from 'react-icons/md';

interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
    onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    title,
    description,
    confirmLabel = '確認',
    cancelLabel = 'キャンセル',
    variant = 'default',
    onConfirm,
    onCancel,
}) => {
    const confirmRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (isOpen) {
            // Focus confirm button when dialog opens
            setTimeout(() => confirmRef.current?.focus(), 100);
        }
    }, [isOpen]);

    // Handle Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, onCancel]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/60 backdrop-blur-sm animate-in fade-in duration-150">
            <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200 space-y-4">
                <div className="flex items-start gap-4">
                    <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                        variant === 'destructive' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
                    )}>
                        <MdWarning className="w-5 h-5" />
                    </div>
                    <div className="space-y-1.5">
                        <h3 className="font-bold text-foreground text-lg leading-tight">{title}</h3>
                        {description && (
                            <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
                        )}
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        ref={confirmRef}
                        onClick={onConfirm}
                        className={cn(
                            "px-4 py-2 text-sm font-bold rounded-lg transition-colors",
                            variant === 'destructive'
                                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                                : 'bg-primary text-primary-foreground hover:bg-primary/90'
                        )}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
};

/**
 * Hook to use a confirm dialog imperatively (replacing window.confirm).
 *
 * Usage:
 *   const { confirm, ConfirmDialogComponent } = useConfirmDialog();
 *   // Render <ConfirmDialogComponent /> somewhere in JSX
 *   // Then call: const ok = await confirm({ title: "..." });
 */
export function useConfirmDialog() {
    const [state, setState] = useState<{
        isOpen: boolean;
        title: string;
        description?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        variant?: 'default' | 'destructive';
        resolve?: (value: boolean) => void;
    }>({ isOpen: false, title: '' });

    const confirm = useCallback((opts: {
        title: string;
        description?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        variant?: 'default' | 'destructive';
    }): Promise<boolean> => {
        return new Promise((resolve) => {
            setState({ isOpen: true, ...opts, resolve });
        });
    }, []);

    const handleConfirm = useCallback(() => {
        state.resolve?.(true);
        setState(prev => ({ ...prev, isOpen: false }));
    }, [state.resolve]);

    const handleCancel = useCallback(() => {
        state.resolve?.(false);
        setState(prev => ({ ...prev, isOpen: false }));
    }, [state.resolve]);

    const ConfirmDialogComponent = useCallback(() => (
        <ConfirmDialog
            isOpen={state.isOpen}
            title={state.title}
            description={state.description}
            confirmLabel={state.confirmLabel}
            cancelLabel={state.cancelLabel}
            variant={state.variant}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
        />
    ), [state.isOpen, state.title, state.description, state.confirmLabel, state.cancelLabel, state.variant, handleConfirm, handleCancel]);

    return { confirm, ConfirmDialogComponent };
}

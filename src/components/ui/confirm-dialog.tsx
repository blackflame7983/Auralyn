import { Button } from '@/components/ui/button';
import React, { useState, useCallback, useId } from 'react';
import { cn } from '@/lib/utils';
import { Modal } from './modal';
import * as Dialog from '@radix-ui/react-dialog';
import { MdWarning } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';

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
    confirmLabel,
    cancelLabel,
    variant = 'default',
    onConfirm,
    onCancel,
}) => {
    const t = useMessages();
    const descriptionId = useId();
    if (!isOpen) return null;

    return (
        <Modal title={title} titleInContent role="alertdialog"
            descriptionId={description ? descriptionId : undefined} onClose={onCancel}>
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90">
            <div className="modal-surface-base p-6 w-full max-w-md space-y-4">
                <div className="flex items-start gap-4">
                    <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                        variant === 'destructive' ? 'bg-destructive/10 text-destructive-text' : 'bg-primary/10 text-primary'
                    )}>
                        <MdWarning className="w-5 h-5" />
                    </div>
                    <div className="space-y-1.5">
                        <Dialog.Title asChild>
                            <h3 className="font-bold text-foreground text-ui-heading leading-tight">{title}</h3>
                        </Dialog.Title>
                        {description && (
                            <p id={descriptionId} className="text-ui-support text-muted-foreground leading-relaxed">{description}</p>
                        )}
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <Button variant="ghost" size="sm"
                        onClick={onCancel}

                    >
                        {cancelLabel ?? t('commonDialog.cancel')}
                    </Button>
                    <Button variant={variant === 'destructive' ? 'destructive' : 'default'} size="sm"
                        onClick={onConfirm}

                    >
                        {confirmLabel ?? t('commonDialog.confirm')}
                    </Button>
                </div>
            </div>
        </div>
        </Modal>
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

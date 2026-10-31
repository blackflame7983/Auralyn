import { cloneElement, useCallback, useRef, type ReactElement, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

// 画面の置き換えでも、消えたボタンから元の入口まで復帰先をたどれるようにする。
const focusChains = new WeakMap<Element, readonly HTMLElement[]>();
let closingFocusChain: readonly HTMLElement[] = [];

function captureFocusChain(): readonly HTMLElement[] {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return closingFocusChain;
    const dialog = active.closest('[role="dialog"]');
    return [active, ...(dialog ? focusChains.get(dialog) ?? [] : [])];
}

interface ModalProps {
    title: string;
    onClose: () => void;
    children: ReactElement<{ children?: ReactNode }>;
    dismissible?: boolean;
    initialFocusRef?: { readonly current: HTMLElement | null };
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

// 既存の見た目を保ち、入れ子の確認画面も含めてフォーカスと背景操作を管理する。
// 各画面は開いている間だけマウントする。
export function Modal({ title, onClose, children, dismissible = true, initialFocusRef, onEscapeKeyDown }: ModalProps) {
    const returnFocus = useRef(captureFocusChain());
    const contentRef = useCallback((element: HTMLDivElement | null) => {
        if (element) focusChains.set(element, returnFocus.current);
        // 遅延読み込みの画面が来るまでの、フォーカスがbodyへ移る隙間も引き継ぐ。
        else closingFocusChain = returnFocus.current;
    }, []);
    return (
        <Dialog.Root open onOpenChange={open => { if (!open && dismissible) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Content
                    ref={contentRef}
                    asChild
                    className="app-dialog text-foreground"
                    aria-modal="true"
                    aria-describedby={undefined}
                    onPointerDownOutside={event => event.preventDefault()}
                    onEscapeKeyDown={event => { onEscapeKeyDown?.(event); if (!dismissible) event.preventDefault(); }}
                    onOpenAutoFocus={event => {
                        const target = initialFocusRef?.current;
                        if (target) {
                            event.preventDefault();
                            target.focus({ preventScroll: true });
                        }
                    }}
                    onCloseAutoFocus={event => {
                        event.preventDefault();
                        const activeDialog = Array.from(document.querySelectorAll('[role="dialog"][data-state="open"]')).pop();
                        const target = returnFocus.current.find(element => element.isConnected
                            && !element.matches(':disabled')
                            && (!activeDialog || activeDialog.contains(element)));
                        target?.focus();
                        if (closingFocusChain === returnFocus.current) closingFocusChain = [];
                    }}
                >
                    {cloneElement(children, {}, <>
                        <Dialog.Title asChild><span className="sr-only">{title}</span></Dialog.Title>
                        {children.props.children}
                    </>)}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const SlotContext = createContext<HTMLElement | null>(null);
const SetSlotContext = createContext<((element: HTMLElement | null) => void) | null>(null);

/** 中央のページを、ホームの代わりに差し込む場所。 */
export function PageSlotProvider({ children }: { children: ReactNode }) {
    const [element, setElement] = useState<HTMLElement | null>(null);
    return <SetSlotContext.Provider value={setElement}><SlotContext.Provider value={element}>{children}</SlotContext.Provider></SetSlotContext.Provider>;
}

export function PageSlot({ className }: { className?: string }) {
    const setElement = useContext(SetSlotContext);
    return <div ref={setElement ?? undefined} className={className} />;
}

export function usePageSlot() { return useContext(SlotContext); }

/** スロットがあるときは中央へ出し、試験のように枠がないときはその場に出す。
 *  差し込み先ができるまでは出さない。先に文書の末尾へ出すと、焦点が下へずれて窓が動く。 */
export function PagePortal({ children }: { children: ReactNode }) {
    const slot = usePageSlot();
    const setSlot = useContext(SetSlotContext);
    if (setSlot && !slot) return null;
    if (!slot) return children;
    return createPortal(children, slot);
}

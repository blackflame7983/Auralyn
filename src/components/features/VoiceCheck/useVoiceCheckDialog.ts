import { useEffect, useRef, useState, type RefObject } from 'react';

/** 開いた直後、録音開始が押せるようになったときだけ焦点を当てる。 */
export function useFocusWhenEnabled(node: RefObject<HTMLButtonElement | null>, active: boolean, enabled: boolean): void {
    const focused = useRef(false);
    useEffect(() => {
        if (!active) {
            focused.current = false;
            return;
        }
        if (focused.current || !enabled) return;
        focused.current = true;
        node.current?.focus({ preventScroll: true });
    }, [active, enabled, node]);
}

/** 確認が必要になったら開く。開いたあとは、閉じる操作を残す。 */
export function useOpenWhen(needed: boolean): [boolean, (open: boolean) => void] {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (needed) setOpen(true);
    }, [needed]);
    return [open, setOpen];
}

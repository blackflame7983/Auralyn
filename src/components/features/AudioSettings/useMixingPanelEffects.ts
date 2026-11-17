import { useEffect, useRef } from 'react';

/** 開いた直後と、設定を閉じたあと（disabled が戻ったとき）に読み直す。 */
export function useReadWhenOpened(open: boolean, disabled: boolean, read: () => void): void {
    const readRef = useRef(read);
    readRef.current = read;
    const attempted = useRef(false);
    useEffect(() => {
        if (open && !attempted.current && !disabled) {
            attempted.current = true;
            readRef.current();
        }
        return () => { attempted.current = false; };
    }, [open, disabled]);
}

/** 閉じたときと、外部の世代変更のあとに、溜めた変更を捨てる。 */
export function useCancelWhenStale(open: boolean, stale: boolean, cancel: () => void): void {
    const cancelRef = useRef(cancel);
    cancelRef.current = cancel;
    useEffect(() => {
        if (stale || !open) cancelRef.current();
    }, [stale, open]);
}

export function useReportBusy(busy: boolean, onBusyChange: ((busy: boolean) => void) | undefined): void {
    const report = useRef(onBusyChange);
    report.current = onBusyChange;
    useEffect(() => { report.current?.(busy); }, [busy]);
}

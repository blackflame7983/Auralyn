import { useEffect, useRef } from 'react';

// 取り外したあとに届いた応答は、いまの入力へ書き戻さない。
export function useStaleGuard() {
    const revision = useRef(0);
    useEffect(() => () => { revision.current += 1; }, []);
    return revision;
}

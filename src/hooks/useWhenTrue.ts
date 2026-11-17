import { useEffect, useRef } from 'react';

/** 条件が真になった（または真のまま始まった）ときに1回だけ動かす。呼ぶ関数は常に直近の描画のもの。 */
export function useWhenTrue(condition: boolean, run: () => void): void {
    const latest = useRef(run);
    latest.current = run;
    useEffect(() => {
        if (condition) latest.current();
    }, [condition]);
}

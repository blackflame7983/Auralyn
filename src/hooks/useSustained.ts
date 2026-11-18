import { useEffect, useState } from 'react';
import { delay } from './internal/afterFrame';

/** 条件が `ms` ミリ秒続いたときだけ true を返す。途中で偽になれば数え直し、そのあいだは false のまま。 */
export function useSustained(condition: boolean, ms: number): boolean {
    const [elapsed, setElapsed] = useState(false);
    useEffect(() => {
        if (!condition) return;
        const cancel = delay(ms, () => setElapsed(true));
        return () => {
            cancel();
            setElapsed(false);
        };
    }, [condition, ms]);
    return condition && elapsed;
}

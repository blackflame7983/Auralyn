import { useEffect, useSyncExternalStore } from 'react';
import { clearEngineInputSource, readEngineInputSource, subscribeEngineInputSource } from '@/lib/engineInputSource';
import type { InputSource } from '@/lib/inputSource';

/**
 * 動いているエンジンが実際に使っている入力元。止まっているあいだは undefined。
 * 値は既存の状態確認の応答から得るので、この hook は問い合わせを増やさない。
 * 止まったときに前回の値を捨て、再開後は最初の応答が来るまで未確認として扱う。
 */
export function useEngineInputSource(running: boolean): InputSource | undefined {
    const source = useSyncExternalStore(subscribeEngineInputSource, readEngineInputSource);
    useEffect(() => { if (!running) clearEngineInputSource(); }, [running]);
    return running ? source : undefined;
}

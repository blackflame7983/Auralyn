import { useEffect, useState } from 'react';
import type { EngineRuntimeStats } from '@/api/audio';

// 停止したら、前の稼働の統計を右の列へ残さない。
export function useClearedRuntimeStats(isEngineRunning: boolean) {
    const [stats, setStats] = useState<EngineRuntimeStats | null>(null);
    useEffect(() => { setStats(null); }, [isEngineRunning]);
    return [stats, setStats] as const;
}

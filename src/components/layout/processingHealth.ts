import type { ProcessingHealthSnapshot } from '@/api/audio';

// processing_watch.rs の LATE_WARN / UNDERFLOW_WARN と同じ境界。
export const RECENT_LATE_WARN = 10;
export const RECENT_UNDERFLOW_WARN = 3;

export function recentAnomalyWarning(health: ProcessingHealthSnapshot | null | undefined): boolean {
    return !!health && (health.recentLate >= RECENT_LATE_WARN || health.recentUnderflow >= RECENT_UNDERFLOW_WARN);
}

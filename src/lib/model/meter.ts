export type Pair = [number, number];
export type MeterState = 'waiting' | 'live' | 'silent' | 'stale' | 'stopped';
export interface MeterReading { levels: Pair; peak: Pair; clipped: boolean; clipSecondsAgo?: number | null; state: MeterState; resetClip: () => void }
export const METER_TIMEOUT_MS = 1000;
export const CLIP_LEVEL = 1;
export const WARNING_LEVEL = Math.pow(10, -6 / 20);
export const METER_FLOOR_DB = -60;
export const toDbfs = (level: number) => level > 0 && Number.isFinite(level) ? 20 * Math.log10(level) : -Infinity;

export function meterPosition(level: number): number {
    const db = toDbfs(level);
    if (!Number.isFinite(db) || db <= METER_FLOOR_DB) return 0;
    if (db >= 0) return 1;
    return (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

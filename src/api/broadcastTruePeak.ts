import { invoke } from '@tauri-apps/api/core';
export interface BroadcastTruePeakConfig { enabled: boolean; ceilingDb: number; releaseMs: number }
export interface BroadcastTruePeakStatus {
    config: BroadcastTruePeakConfig; running: boolean; pending: boolean; revision: string;
    reductionDb: number; addedLatencySamples: number;
}
export const broadcastTruePeakApi = { request: async (config?: BroadcastTruePeakConfig): Promise<BroadcastTruePeakStatus> => {
    const result = await invoke<BroadcastTruePeakStatus>('broadcast_true_peak', { config });
    const c = result?.config;
    const latency = result?.addedLatencySamples;
    if (!c || typeof c.enabled !== 'boolean' || !Number.isFinite(c.ceilingDb) || c.ceilingDb < -12 || c.ceilingDb > -0.1
        || !Number.isFinite(c.releaseMs) || c.releaseMs < 20 || c.releaseMs > 1000 || typeof result.running !== 'boolean'
        || typeof result.pending !== 'boolean' || typeof result.revision !== 'string' || !Number.isFinite(result.reductionDb)
        || result.reductionDb < 0 || !Number.isInteger(latency) || latency < 0 || latency > 4294967295) {
        throw new Error('Broadcast true-peak state unavailable');
    }
    return result;
} };

import { invoke } from '@tauri-apps/api/core';
export interface PeakConfig { enabled: boolean; ceilingDb: number; releaseMs: number }
export interface PeakStatus { config: PeakConfig; running: boolean; pending: boolean; revision: string; reductionDb: number; addedLatencySamples: number }
export const peakProtectionApi = { request: async (config?: PeakConfig): Promise<PeakStatus> => {
    const result = await invoke<PeakStatus>('peak_protection', { config });
    const c = result?.config;
    if (!c || typeof c.enabled !== 'boolean' || !Number.isFinite(c.ceilingDb) || c.ceilingDb < -12 || c.ceilingDb > -0.1
        || !Number.isFinite(c.releaseMs) || c.releaseMs < 20 || c.releaseMs > 1000 || typeof result.running !== 'boolean'
        || typeof result.pending !== 'boolean' || typeof result.revision !== 'string' || !Number.isFinite(result.reductionDb)
        || result.reductionDb < 0 || result.addedLatencySamples !== 0) throw new Error('Peak protection state unavailable');
    return result;
} };

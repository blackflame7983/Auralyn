import { invoke } from '@tauri-apps/api/core';

export interface NoiseMeasurementConditions {
    engineEpoch: string; streamAttempt: string; inputRevision: string;
    host: string; input: string; inputId: string; channels: [number, number];
    inputGain: number; analysisRate: number; backend: string; model: string; analysisVersion: number;
}
export interface NoiseMeasurementSnapshot {
    epoch: string; generation: string; state: 'idle' | 'capturing' | 'review' | 'approved' | 'invalid' | 'stale';
    usable: boolean; reason: string | null; conditions: NoiseMeasurementConditions | null;
    capturedAtUnixMs: number | null; progress: number; measuredFrames: number;
    rms: number; peak: number; variationRatio: number; quality: string[];
    recommendedMix: number; appliedMix: number; previousAvailable: boolean;
    previous: { generation: string; conditions: NoiseMeasurementConditions; capturedAtUnixMs: number | null; rms: number; appliedMix: number } | null;
}
export type NoiseMeasurementRequest = { action: 'snapshot' | 'invalidate' }
    | { action: 'start' | 'cancel'; epoch: string; generation: string }
    | { action: 'approve'; epoch: string; generation: string; acknowledgedQuiet: boolean };
const validConditions = (c: NoiseMeasurementConditions | null | undefined): c is NoiseMeasurementConditions => !!c
    && [c.engineEpoch, c.streamAttempt, c.inputRevision, c.host, c.input, c.inputId, c.backend, c.model].every(v => typeof v === 'string' && v.length > 0)
    && Array.isArray(c.channels) && c.channels.length === 2 && c.channels.every(v => Number.isSafeInteger(v) && v >= 0 && v <= 65535)
    && Number.isFinite(c.inputGain) && c.inputGain >= 0 && c.inputGain <= 2
    && Number.isSafeInteger(c.analysisRate) && c.analysisRate >= 8000 && c.analysisRate <= 384000 && c.analysisVersion === 1;
const validTime = (value: number | null) => value === null || (Number.isSafeInteger(value) && value > 0);
export const noiseMeasurementApi = {
    request: async (request: NoiseMeasurementRequest): Promise<NoiseMeasurementSnapshot> => {
        const result = await invoke<NoiseMeasurementSnapshot>('noise_measurement', { request });
        if (!result || typeof result.epoch !== 'string' || !result.epoch || typeof result.generation !== 'string' || !['idle', 'capturing', 'review', 'approved', 'invalid', 'stale'].includes(result.state)
            || typeof result.usable !== 'boolean' || !Array.isArray(result.quality)
            || ![result.progress, result.rms, result.peak, result.variationRatio, result.recommendedMix, result.appliedMix].every(Number.isFinite)
            || result.quality.some(v => typeof v !== 'string') || !Number.isSafeInteger(result.measuredFrames) || result.measuredFrames < 0
            || result.progress < 0 || result.progress > 1 || !validTime(result.capturedAtUnixMs)
            || [result.rms, result.peak, result.variationRatio].some(v => v < 0)
            || [result.recommendedMix, result.appliedMix].some(v => v < 0 || v > 1)
            || (result.conditions !== null && !validConditions(result.conditions))
            || (['capturing', 'review', 'approved'].includes(result.state) && !validConditions(result.conditions))
            || (result.previous && (!validConditions(result.previous.conditions) || !validTime(result.previous.capturedAtUnixMs) || !Number.isFinite(result.previous.rms) || !Number.isFinite(result.previous.appliedMix)))
            || (result.usable && (result.state !== 'approved' || !result.conditions))) throw Error('Measurement state unavailable');
        return result;
    },
};

import type { NoiseMeasurementSnapshot } from '@/api/noiseMeasurement';
export const noiseMeasurementFixture = (state: NoiseMeasurementSnapshot['state'] = 'idle', generation = '0'): NoiseMeasurementSnapshot => ({
    epoch: 'measurement-engine', generation, state, usable: state === 'approved', reason: null,
    conditions: ['capturing', 'review', 'approved'].includes(state) ? { engineEpoch: 'measurement-engine', streamAttempt: '1', inputRevision: '1', host: 'WASAPI', input: 'Mic', inputId: 'mic-fixture-id', channels: [0, 1], inputGain: 1, analysisRate: 48000, backend: 'nnnoiseless-0.5.2', model: 'bundled-e6de5fbfadf7ec91', analysisVersion: 1 } : null,
    capturedAtUnixMs: ['review', 'approved'].includes(state) ? 1700000000000 : null,
    progress: 0, measuredFrames: 0, rms: .01, peak: .02, variationRatio: 1, quality: [],
    recommendedMix: .68, appliedMix: .6, previousAvailable: false, previous: null,
});

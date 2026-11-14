import type { NoiseControlMode } from '@/api/audio';
import type { MessageKey } from '@/i18n/messages';

/** 統計から読めるノイズ低減のモード。無い・知らない値は不明。 */
export type NoiseModeReading = NoiseControlMode | 'unknown';

const knownModes = ['low', 'high', 'smart', 'venue'] as const;

/** 統計のモード文字列を、小文字の既知値か「不明」にそろえる。ホームと音づくりで共用する。 */
export function readNoiseMode(mode: string | null | undefined): NoiseModeReading {
    const value = mode?.trim().toLowerCase();
    return (knownModes as readonly string[]).includes(value ?? '') ? value as NoiseControlMode : 'unknown';
}

/** 既知のモードの表示名。不明は状態が読めない旨にする。 */
export function noiseModeLabelKey(mode: NoiseModeReading): MessageKey {
    if (mode === 'high') return 'master.nrHigh';
    if (mode === 'smart') return 'master.nrLearn';
    if (mode === 'venue') return 'master.nrVenue';
    if (mode === 'low') return 'master.nrLow';
    return 'flow.unknown';
}

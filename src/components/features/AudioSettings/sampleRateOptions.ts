import type { AudioDevice } from '@/api/audio';

type Ranges = [number, number][] | undefined;
function validRanges(value: unknown): Ranges {
    if (!Array.isArray(value) || !value.every(range => Array.isArray(range) && range.length === 2 &&
        range.every(n => Number.isSafeInteger(n) && n > 0) && range[0] <= range[1])) return undefined;
    return value as [number, number][];
}
function contains(ranges: Ranges, rate: number) {
    return ranges === undefined || ranges.some(([min, max]) => rate >= min && rate <= max);
}

export const formatSampleRate = (rate: number) => (rate / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');

export function sampleRateOptions(input: AudioDevice | undefined, output: AudioDevice | undefined, isAsio: boolean, selected: number, current?: number) {
    const inputRanges = isAsio ? validRanges(input?.sample_rate_ranges) : undefined;
    const outputRanges = validRanges(output?.sample_rate_ranges);
    const relevant = isAsio ? [inputRanges, outputRanges] : [outputRanges];
    const endpoints = relevant.flatMap(ranges => ranges?.flat() ?? []);
    const rates = [44100, 48000, 88200, 96000, 192000, selected, current, ...endpoints]
        .filter((rate): rate is number => typeof rate === 'number' && Number.isSafeInteger(rate) && rate > 0);
    return {
        options: [...new Set(rates)].sort((a, b) => a - b).map(rate => ({ rate, supported: relevant.every(ranges => contains(ranges, rate)) })),
        inputUnknown: isAsio && inputRanges === undefined,
        outputUnknown: outputRanges === undefined,
    };
}

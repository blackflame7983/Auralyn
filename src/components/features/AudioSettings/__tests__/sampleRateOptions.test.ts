import { expect, it } from 'vitest';
import type { AudioDevice } from '@/api/audio';
import { formatSampleRate, sampleRateOptions } from '../sampleRateOptions';

const device = (ranges?: [number, number][]) => ({ sample_rate_ranges: ranges } as AudioDevice);
const option = (result: ReturnType<typeof sampleRateOptions>, rate: number) => result.options.find(item => item.rate === rate);

it('ASIOは入力・出力の共通範囲だけを候補として有効にし、範囲端と現在値を残す', () => {
    const result = sampleRateOptions(device([[32000, 96000], [176400, 192000]]), device([[44100, 88200], [192000, 192000]]), true, 176400, 12345);
    expect(option(result, 44100)?.supported).toBe(true);
    expect(option(result, 88200)?.supported).toBe(true);
    expect(option(result, 96000)?.supported).toBe(false);
    expect(option(result, 192000)?.supported).toBe(true);
    expect(option(result, 32000)?.supported).toBe(false);
    expect(option(result, 176400)?.supported).toBe(false);
    expect(option(result, 12345)?.supported).toBe(false);
    expect(result.inputUnknown || result.outputUnknown).toBe(false);
});

it('片側未取得は未確認と示し、取得済みの側の範囲外は選べない', () => {
    const result = sampleRateOptions(device(), device([[48000, 96000]]), true, 48000);
    expect(result.inputUnknown).toBe(true);
    expect(result.outputUnknown).toBe(false);
    expect(option(result, 44100)?.supported).toBe(false);
    expect(option(result, 88200)?.supported).toBe(true);
});

it('WASAPIは入力レートと無関係に出力の範囲を使う', () => {
    const result = sampleRateOptions(device([[44100, 44100]]), device([[48000, 96000]]), false, 48000);
    expect(result.inputUnknown).toBe(false);
    expect(option(result, 48000)?.supported).toBe(true);
    expect(option(result, 44100)?.supported).toBe(false);
});

it('空の範囲は対応なし、不正な範囲は未確認として扱う', () => {
    const empty = sampleRateOptions(device([]), device([[44100, 96000]]), true, 48000);
    expect(empty.inputUnknown).toBe(false);
    expect(empty.options.every(item => !item.supported)).toBe(true);
    const invalid = sampleRateOptions(device([[96000, 48000]]), device([[44100, 96000]]), true, 48000);
    expect(invalid.inputUnknown).toBe(true);
    expect(option(invalid, 48000)?.supported).toBe(true);
});

it('端点を丸めて別のレートとして表示しない', () => {
    expect(formatSampleRate(44101)).toBe('44.101');
    expect(formatSampleRate(48000)).toBe('48.0');
});

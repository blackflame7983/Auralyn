/**
 * audio API レイヤーのユニットテスト
 * Tauri の invoke をモック化し、APIの呼び出しパラメータを検証
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi } from '../../api/audio';

// invoke のモック型アサーション
const mockedInvoke = vi.mocked(invoke);

describe('audioApi', () => {
    beforeEach(() => {
        mockedInvoke.mockReset();
    });

    describe('start', () => {
        it('正しいパラメータで invoke を呼ぶ', async () => {
            const mockResponse = { sample_rate: 48000, buffer_size: 512 };
            mockedInvoke.mockResolvedValue(mockResponse);

            const result = await audioApi.start('WASAPI', 'Microphone', 'Speakers', 512, 48000);

            expect(mockedInvoke).toHaveBeenCalledWith('start_audio', {
                host: 'WASAPI',
                input: 'Microphone',
                output: 'Speakers',
                bufferSize: 512,
                sampleRate: 48000,
                inputId: undefined,
                outputId: undefined,
            });
            expect(result).toEqual(mockResponse);
        });

        it('オプショナル引数なしでも動作する', async () => {
            mockedInvoke.mockResolvedValue({ sample_rate: 48000, buffer_size: 512 });

            await audioApi.start('WASAPI');

            expect(mockedInvoke).toHaveBeenCalledWith('start_audio', expect.objectContaining({
                host: 'WASAPI',
            }));
        });

        it('invoke がエラーを投げた場合、例外を伝播する', async () => {
            mockedInvoke.mockRejectedValue(new Error('デバイスが見つかりません'));

            await expect(audioApi.start('WASAPI', 'Unknown'))
                .rejects.toThrow('デバイスが見つかりません');
        });
    });

    describe('getDevices', () => {
        it('デバイス一覧を取得する', async () => {
            const mockDevices = {
                inputs: [{ name: 'Mic', host: 'WASAPI', is_input: true, index: 0, is_default: true, channels: 2 }],
                outputs: [{ name: 'Speakers', host: 'WASAPI', is_input: false, index: 0, is_default: true, channels: 2 }],
            };
            mockedInvoke.mockResolvedValue(mockDevices);

            const result = await audioApi.getDevices();

            expect(mockedInvoke).toHaveBeenCalledWith('get_audio_devices', { forceRefresh: false });
            expect(result.inputs).toHaveLength(1);
            expect(result.outputs).toHaveLength(1);
        });
    });

    describe('stop', () => {
        it('エンジン停止コマンドを送信する', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await audioApi.stop();

            expect(mockedInvoke).toHaveBeenCalledWith('stop_audio');
        });
    });

    describe('setNoiseReduction', () => {
        it('ノイズ抑制の状態とモードを送信する', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await audioApi.setNoiseReduction(true, 'high');

            expect(mockedInvoke).toHaveBeenCalledWith('set_noise_reduction', {
                active: true,
                mode: 'high',
            });
        });
    });

    describe('engine tuning', () => {
        it('チューニング設定の取得/設定コマンドを送信する', async () => {
            const cfg = {
                enableAffinityPinning: true,
                affinityMask: '0xff',
                enableRealtimePriority: false,
                enableTimeCriticalAudioThreads: true,
            };
            mockedInvoke.mockResolvedValue(cfg);

            await audioApi.getEngineTuningConfig();
            expect(mockedInvoke).toHaveBeenCalledWith('get_engine_tuning_config');

            mockedInvoke.mockResolvedValue(undefined);
            await audioApi.setEngineTuningConfig(cfg);
            expect(mockedInvoke).toHaveBeenCalledWith('set_engine_tuning_config', { config: cfg });
        });

        it('エンジン統計の取得コマンドを送信する', async () => {
            mockedInvoke.mockResolvedValue({
                activePluginCount: 1,
                enabledPluginCount: 1,
                pendingUnloadCount: 0,
                burnedLibraryCount: 2,
                globalBypass: false,
                maxJitterUs: 0,
                glitchCount: 0,
                totalPluginLatencySamples: 0,
                totalPluginLatencyMs: 0,
                noiseReductionLatencySamples: 0,
                noiseReductionLatencyMs: 0,
                totalChainLatencySamples: 0,
                totalChainLatencyMs: 0,
                noiseReductionEnabled: false,
                noiseReductionActive: false,
                noiseReductionMode: 'low',
            });

            await audioApi.getEngineRuntimeStats();

            expect(mockedInvoke).toHaveBeenCalledWith('get_engine_runtime_stats');
        });
    });
});

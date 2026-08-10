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

            await audioApi.setNoiseReduction(true, 'smart');

            expect(mockedInvoke).toHaveBeenCalledWith('set_noise_reduction', {
                active: true,
                mode: 'smart',
            });
        });

        it('AIノイズ制御の学習と詳細設定を送信する', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await audioApi.startNoiseLearning(3000);
            expect(mockedInvoke).toHaveBeenCalledWith('start_noise_learning', {
                durationMs: 3000,
            });

            await audioApi.setNoiseControlConfig({
                active: true,
                mode: 'venue',
                strength: 0.85,
                voiceGuard: true,
            });
            expect(mockedInvoke).toHaveBeenCalledWith('set_noise_control_config', {
                active: true,
                mode: 'venue',
                strength: 0.85,
                voiceGuard: true,
            });
        });

        it('内蔵エフェクト設定を送信する', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await audioApi.setBuiltInEffects({
                active: true,
                preset: 'broadcast',
                amount: 0.7,
            });

            expect(mockedInvoke).toHaveBeenCalledWith('set_built_in_effects', {
                active: true,
                preset: 'broadcast',
                amount: 0.7,
            });
        });
    });

    describe('voice check', () => {
        it('ボイスチェック関連コマンドを正しいパラメータで送信する', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await audioApi.startVoiceCheck(8000);
            expect(mockedInvoke).toHaveBeenCalledWith('start_voice_check', { maxMs: 8000 });

            await audioApi.stopVoiceCheck();
            expect(mockedInvoke).toHaveBeenCalledWith('stop_voice_check');

            await audioApi.playVoiceCheck('raw', false);
            expect(mockedInvoke).toHaveBeenCalledWith('play_voice_check', {
                source: 'raw',
                loopPlayback: false,
            });

            await audioApi.stopVoiceCheckPlayback();
            expect(mockedInvoke).toHaveBeenCalledWith('stop_voice_check_playback');

            await audioApi.exportVoiceCheck('C:\\temp\\test.wav', 'processed');
            expect(mockedInvoke).toHaveBeenCalledWith('export_voice_check', {
                path: 'C:\\temp\\test.wav',
                source: 'processed',
            });

            await audioApi.exportVoiceCheckWav('raw');
            expect(mockedInvoke).toHaveBeenCalledWith('export_voice_check_wav', {
                source: 'raw',
            });
        });

        it('品質チェック分析コマンドを呼ぶ', async () => {
            const mockReport = {
                clip: { count: 0, ratio: 0, positionsMs: [] },
                dropouts: { count: 0, positionsMs: [] },
                noiseFloorDb: { raw: -60, processed: -65 },
                snrImprovementDb: 5,
                bandDeltaDb: [{ bandHz: 1000, deltaDb: -1 }],
                loudness: { rmsDb: -18, peakDb: -6 },
                verdict: 'good',
                advices: [],
            };
            mockedInvoke.mockResolvedValue(mockReport);

            const result = await audioApi.analyzeVoiceCheck();

            expect(mockedInvoke).toHaveBeenCalledWith('analyze_voice_check');
            expect(result.verdict).toBe('good');
            expect(result.snrImprovementDb).toBe(5);
        });
    });

    describe('routing diagnostics', () => {
        it('テストトーン/ループバック/ルーティング診断コマンドを送信する', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await audioApi.playTestTone(1000, 1500, -20);
            expect(mockedInvoke).toHaveBeenCalledWith('play_test_tone', {
                freqHz: 1000,
                durationMs: 1500,
                levelDb: -20,
            });

            await audioApi.stopTestTone();
            expect(mockedInvoke).toHaveBeenCalledWith('stop_test_tone');

            const probeResult = { detected: true, levelDb: -30, unavailable: null };
            mockedInvoke.mockResolvedValue(probeResult);
            const probe = await audioApi.probeLoopback('CABLE Output', 1500, 1000);
            expect(mockedInvoke).toHaveBeenCalledWith('probe_loopback', {
                inputDevice: 'CABLE Output',
                durationMs: 1500,
                freqHz: 1000,
            });
            expect(probe.detected).toBe(true);

            const routingReport = {
                devices: [],
                engineSampleRateHz: 48000,
                sampleRateMismatches: [],
                defaultCommsRenderIsVirtual: false,
                defaultCommsRenderName: null,
                warnings: [],
            };
            mockedInvoke.mockResolvedValue(routingReport);
            const routing = await audioApi.getRoutingDiagnostics();
            expect(mockedInvoke).toHaveBeenCalledWith('get_routing_diagnostics');
            expect(routing.engineSampleRateHz).toBe(48000);
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
                noiseLearningState: 'idle',
                noiseLearningProgress: 0,
                noiseProfileAvailable: false,
                noiseProfileRms: 0,
                recommendedNoiseMix: 0.6,
                speechDetected: false,
                noiseVoiceGuard: true,
                builtInEffectsEnabled: false,
                builtInEffectsPreset: 'broadcast',
            });

            await audioApi.getEngineRuntimeStats();

            expect(mockedInvoke).toHaveBeenCalledWith('get_engine_runtime_stats');
        });
    });
});

import { audioApi } from '@/api/audio';
import { liveModesApi } from '@/api/liveModes';
import type { AudioPreferences } from './audioPreferences';
import { FixedClientError } from './clientError';
import { channelRoutingFor } from './audioChannelRouting';

export class HomeAudioStartError extends Error {
    constructor(readonly started: boolean, readonly cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
    }
}

// 設定の変更ではなく再開する入口。本番保護中は復旧処理と同じく保持中の経路を使う。
export async function startHomeAudio(saved: AudioPreferences, persist: (config: AudioPreferences) => Promise<void>) {
    let started = false;
    try {
        const mode = await liveModesApi.request({ action: 'snapshot' });
        let config = saved;
        if (mode.armed) {
            const actual = (await audioApi.getAudioState()).config;
            if (!actual?.host || !actual.input || !actual.output || !actual.input_id || !actual.output_id || !actual.sample_rate || !actual.buffer_size) {
                throw new FixedClientError('home.protectedConfigUnverified');
            }
            config = { ...saved, host: actual.host, input: actual.input, output: actual.output, inputId: actual.input_id,
                outputId: actual.output_id, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size };
        }
        const result = mode.armed
            ? await audioApi.start(config.host, config.input, config.output, config.bufferSize, config.sampleRate, config.inputId, config.outputId)
            : await audioApi.start(config.host, config.input, config.output, config.bufferSize, config.sampleRate, config.inputId, config.outputId, undefined, channelRoutingFor(config), ...(config.inputSource ? [{ source: config.inputSource }] as const : []));
        started = true;
        // 保護中に古いUIのチャンネル選択を再適用しない。
        if (!mode.armed) {
            const routing = result.routing ?? channelRoutingFor(config);
            await persist({ ...config, sampleRate: result.sample_rate, bufferSize: result.buffer_size,
                inputChannels: routing.inputChannels ?? [0, 1], outputRouting: routing.outputRouting });
        }
    } catch (error) { throw new HomeAudioStartError(started, error); }
}

import { afterEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { liveModesApi, type LiveModeSnapshot } from '@/api/liveModes';
import { HomeAudioStartError, startHomeAudio } from '@/lib/startHomeAudio';
import { FixedClientError, renderClientError } from '@/lib/clientError';
import { message } from '@/i18n/messages';

afterEach(() => vi.restoreAllMocks());
const config = { host: 'ASIO', input: 'Saved mic', output: 'Saved out', inputId: 'saved-in', outputId: 'saved-out', inputChannels: [6, 7] as [number, number], sampleRate: 48000, bufferSize: 512 };
function setup(armed = false) {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue({ armed } as LiveModeSnapshot);
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 96000, buffer_size: 256, channels: 2 });
    const channels = vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
    return { start, channels, persist: vi.fn().mockResolvedValue(undefined) };
}

it('通常の開始は機器IDとASIO入力ペアを保ち、実際のレートとバッファを保存する', async () => {
    const { start, channels, persist } = setup();
    await startHomeAudio(config, persist);
    expect(start).toHaveBeenCalledWith('ASIO', 'Saved mic', 'Saved out', 512, 48000, 'saved-in', 'saved-out');
    expect(channels).toHaveBeenCalledWith(6, 7);
    expect(persist).toHaveBeenCalledWith({ ...config, sampleRate: 96000, bufferSize: 256 });
});

it('本番保護中は保持済み機器で再開し、古いUIの入力ペアを再適用しない', async () => {
    const { start, channels, persist } = setup(true);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: {
        host: 'ASIO', input: 'Actual mic', output: 'Actual out', input_id: 'actual-in', output_id: 'actual-out', sample_rate: 44100, buffer_size: 128,
    } });
    await startHomeAudio(config, persist);
    expect(start).toHaveBeenCalledWith('ASIO', 'Actual mic', 'Actual out', 128, 44100, 'actual-in', 'actual-out');
    expect(channels).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
});

it('保護中に実際の機器設定を確認できなければ開始しない', async () => {
    const { start, persist } = setup(true);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    await expect(startHomeAudio(config, persist)).rejects.toMatchObject({ started: false,
        cause: expect.objectContaining({ messageKey: 'clientErrors.homeProtectedConfigUnverified' }) });
    expect(start).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('保護中の確認失敗は原因の翻訳キーを保持する (%s)', locale => {
    const cause = new FixedClientError('home.protectedConfigUnverified');
    const error = new HomeAudioStartError(false, cause);
    expect(error.message).toBe(cause.message);
    expect(error.cause).toBe(cause);
    expect(renderClientError((key, args) => message(locale, key, args), error.cause))
        .toBe(message(locale, 'clientErrors.homeProtectedConfigUnverified'));
});

it.each(['start', 'channels', 'persist'])('開始と開始後の部分失敗を区別する: %s', async stage => {
    const { start, channels, persist } = setup();
    ({ start, channels, persist })[stage as 'start' | 'channels' | 'persist'].mockRejectedValueOnce(new Error('injected'));
    await expect(startHomeAudio(config, persist)).rejects.toMatchObject({ started: stage !== 'start', message: 'injected' });
    await expect(startHomeAudio(config, persist)).resolves.toBeUndefined();
});

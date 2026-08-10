/**
 * obs API レイヤーのユニットテスト
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { obsApi } from '../../api/obs';

const mockedInvoke = vi.mocked(invoke);

describe('obsApi', () => {
    beforeEach(() => {
        mockedInvoke.mockReset();
    });

    describe('setupAuralynSource', () => {
        it('obs_setup_auralyn_source を呼ぶ', async () => {
            const mockResult = {
                created: true,
                deviceBound: true,
                duplicateMicSources: ['Desktop Mic'],
            };
            mockedInvoke.mockResolvedValue(mockResult);

            const result = await obsApi.setupAuralynSource();

            expect(mockedInvoke).toHaveBeenCalledWith('obs_setup_auralyn_source');
            expect(result).toEqual(mockResult);
        });
    });

    describe('muteSource', () => {
        it('名前とミュート状態を渡す', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await obsApi.muteSource('Desktop Mic', true);

            expect(mockedInvoke).toHaveBeenCalledWith('obs_mute_source', {
                name: 'Desktop Mic',
                muted: true,
            });
        });
    });

    describe('checkAudioReach', () => {
        it('デフォルト durationMs で呼ぶ', async () => {
            mockedInvoke.mockResolvedValue({ reached: true, peakDb: -25 });

            const result = await obsApi.checkAudioReach();

            expect(mockedInvoke).toHaveBeenCalledWith('obs_check_audio_reach', {
                durationMs: 1500,
            });
            expect(result.reached).toBe(true);
        });

        it('カスタム durationMs を渡す', async () => {
            mockedInvoke.mockResolvedValue({ reached: false, peakDb: -80 });

            await obsApi.checkAudioReach(3000);

            expect(mockedInvoke).toHaveBeenCalledWith('obs_check_audio_reach', {
                durationMs: 3000,
            });
        });

        it('unsupported を返せる', async () => {
            mockedInvoke.mockResolvedValue({ reached: 'unsupported' });

            const result = await obsApi.checkAudioReach();

            expect(result.reached).toBe('unsupported');
        });
    });
});

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

    it('現在の接続状態を再接続せずに取得する', async () => {
        mockedInvoke.mockResolvedValue(true);
        expect(await obsApi.connectionStatus()).toBe(true);
        expect(mockedInvoke).toHaveBeenCalledExactlyOnceWith('obs_connection_status');
    });

    describe('previewSetup', () => {
        it('変更なしで予定だけを取得する', async () => {
            const mockResult = {
                created: true,
                deviceBound: true,
                duplicateMicSources: ['Desktop Mic'],
            };
            mockedInvoke.mockResolvedValue(mockResult);

            const result = await obsApi.previewSetup();

            expect(mockedInvoke).toHaveBeenCalledWith('obs_preview_setup', { muteSource: null });
            expect(result).toEqual(mockResult);
        });
    });

    describe('安全な適用と復元', () => {
        it('重複マイクも予定の取得から始める', async () => {
            mockedInvoke.mockResolvedValue(undefined);

            await obsApi.previewSetup('Desktop Mic');

            expect(mockedInvoke).toHaveBeenCalledWith('obs_preview_setup', { muteSource: 'Desktop Mic' });
        });
        it('適用と復元はサーバー上の予定・履歴のIDだけを渡す', async () => {
            await obsApi.applySetup(3);
            expect(mockedInvoke).toHaveBeenLastCalledWith('obs_apply_setup', { id: 3 });
            await obsApi.restoreSetup(3);
            expect(mockedInvoke).toHaveBeenLastCalledWith('obs_restore_setup', { id: 3 });
            await obsApi.setupHistory();
            expect(mockedInvoke).toHaveBeenLastCalledWith('obs_setup_history');
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

import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bundleApi, BundleClientError } from '../bundles';
beforeEach(() => { vi.mocked(invoke).mockReset(); });
it('上書き許可は既定falseで、明示trueだけをbackendへ渡す', async () => {
    vi.mocked(invoke).mockResolvedValue({type: 'saved'});
    const categories = {includePlugins: true, includeAudioConfig: false, includeNoiseControl: false, includeBuiltinFx: false};
    await bundleApi.save('Live', categories, null);
    expect(invoke).toHaveBeenLastCalledWith('broadcast_bundle', {request: {action: 'save', name: 'Live', categories, obs: null, overwrite: false}});
    await bundleApi.save('Live', categories, null, true);
    expect(invoke).toHaveBeenLastCalledWith('broadcast_bundle', {request: {action: 'save', name: 'Live', categories, obs: null, overwrite: true}});
});
it('結果不明の適用は旧profile/OBS APIへfallbackせず、元の失敗を伝える', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('結果不明'));
    await expect(bundleApi.operation({ action: 'apply', id: 'operation-1' })).rejects.toThrow('結果不明');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('broadcast_bundle', { request: { action: 'apply', id: 'operation-1' } });
});
it('不正な応答のopaque値をエラーへ展開せず、partialを全成功へ変換しない', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ type: 'unexpected', value: 'opaque-vst-state-must-not-be-logged' });
    await expect(bundleApi.preview('歌枠')).rejects.toThrow('差分の応答を確認できません');
    const partial = { id: 'operation-1', complete: false, undoPending: true, auralyn: '一部未完了', obs: ['結果不明'], summary: null };
    vi.mocked(invoke).mockResolvedValueOnce({ type: 'result', value: partial });
    expect(await bundleApi.operation({ action: 'undo', id: 'operation-1' })).toEqual(partial);
});

it('client応答エラーは表示keyを持ち、backendの取消や制御errorは同じ値で伝える', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ type: 'unexpected', value: 'opaque-never-in-error' });
    const error = await bundleApi.list().catch(value => value);
    expect(error).toBeInstanceOf(BundleClientError);
    expect(error.messageKey).toBe('presets.copy.174');
    expect(error.message).not.toContain('opaque-never-in-error');
    for (const token of ['cancelled', 'cancel', 'Stream Error', 'Plugin not found']) {
        vi.mocked(invoke).mockRejectedValueOnce(token);
        await expect(bundleApi.list()).rejects.toBe(token);
    }
});

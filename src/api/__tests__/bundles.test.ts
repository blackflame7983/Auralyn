import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bundleApi, BundleClientError } from '../bundles';
beforeEach(() => { vi.mocked(invoke).mockReset(); });
it('プロセス入力は明示保存だけに含め、分離出力や本番モードと区別する', async () => {
    vi.mocked(invoke).mockResolvedValue({ type: 'saved' });
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    await bundleApi.save('process', categories, null, false, undefined, false, false, true);
    expect(invoke).toHaveBeenLastCalledWith('broadcast_bundle', { request: { action: 'save', name: 'process', categories, obs: null, overwrite: false, includeProcess: true } });
});
it('本番モードと関連VSTも明示選択した保存だけに含める', async () => {
    vi.mocked(invoke).mockResolvedValue({ type: 'saved' });
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    await bundleApi.save('modes', categories, null, false, undefined, true, true);
    expect(invoke).toHaveBeenLastCalledWith('broadcast_bundle', { request: { action: 'save', name: 'modes', categories, obs: null, overwrite: false, includeOutput: true, includeLive: true } });
});
it('分離出力は明示選択した保存だけに含める', async () => {
    vi.mocked(invoke).mockResolvedValue({ type: 'saved' });
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    await bundleApi.save('output', categories, null, false, undefined, true);
    expect(invoke).toHaveBeenLastCalledWith('broadcast_bundle', { request: { action: 'save', name: 'output', categories, obs: null, overwrite: false, includeOutput: true } });
});
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

it('ミックスは明示選択時だけ保存要求に含める', async () => {
    vi.mocked(invoke).mockResolvedValue({ type: 'saved' });
    const categories = { includePlugins: true, includeAudioConfig: true, includeNoiseControl: true, includeBuiltinFx: true };
    await bundleApi.save('mix', categories, null, false, undefined, true, true, false, true);
    expect(invoke).toHaveBeenLastCalledWith('broadcast_bundle', { request: { action: 'save', name: 'mix', categories, obs: null, overwrite: false, includeOutput: true, includeLive: true, includeMixing: true } });
});

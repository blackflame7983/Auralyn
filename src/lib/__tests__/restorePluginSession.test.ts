import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { restorePluginSession } from '../restorePluginSession';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
const item = (path: string) => ({ path, name: path, enabled: false, muted: true, gain: 0.5, state: 'saved' });
beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'loadPlugin').mockImplementation(async path => path);
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setMute').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setPluginState').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it('一括復元失敗では不完全なVSTを表示せず、分割APIへfallbackせず次の項目を復元する', async () => {
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => { if (request.path === 'bad') throw new Error('bad state'); return { id: request.path, name: request.path, prepared: true }; });
    const progress = vi.fn();
    expect(await restorePluginSession([item('bad'), item('good')], progress)).toEqual({ status: 'partial', total: 2, restored: 1, failed: 1, skipped: 0 });
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'good', enabled: false, muted: true, gain: 0.5 })]);
    expect(audioApi.loadPlugin).not.toHaveBeenCalled();
    expect(audioApi.setPluginState).not.toHaveBeenCalled();
    expect(localStorage.getItem('vst_host_pending_plugin')).toBeNull();
});

it('取消後に返ったIDは除去し、後片付け失敗を成功や部分復元で隠さない', async () => {
    let current = true;
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => { current = false; return { id: request.path, name: request.path, prepared: false }; });
    vi.mocked(audioApi.removePlugin).mockRejectedValue(new Error('cleanup failed'));
    await expect(restorePluginSession([item('bad'), item('later')], vi.fn(), null, () => current)).rejects.toThrow('cleanup failed');
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(1);
});

it('停止中prepared:falseもstate復元成功で、空文字stateと全設定を維持する', async () => {
    expect((await restorePluginSession([{ ...item('one'), state: '' }], vi.fn())).status).toBe('success');
    expect(audioApi.restorePlugin).toHaveBeenCalledWith({ path: 'one', state: '', bypassed: true, muted: true, gain: 0.5 });
    expect(audioApi.setBypass).not.toHaveBeenCalled();
});

it('全項目を事前に検証し、不正なJSON構造ではロードも表示変更もしない', async () => {
    const progress = vi.fn();
    for (const value of [{}, [item('valid'), null], [{ ...item('bad'), gain: 'loud' }]]) {
        await expect(restorePluginSession(value, progress)).rejects.toThrow();
    }
    expect(audioApi.restorePlugin).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
});

it('連番の処理中はクラッシュ候補を保持し、既知の問題VSTは読み込まない', async () => {
    let finish!: (value: { id: string; name: string; prepared: boolean }) => void;
    vi.mocked(audioApi.restorePlugin).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const progress = vi.fn();
    const restoring = restorePluginSession([item('skip'), item('first'), item('second')], progress, 'skip');
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('vst_host_pending_plugin')).toBe('first');
    finish({ id: 'first', name: 'first', prepared: false });
    expect(await restoring).toEqual({ status: 'partial', total: 3, restored: 2, failed: 0, skipped: 1 });
    expect(audioApi.restorePlugin).toHaveBeenNthCalledWith(2, { path: 'second', state: 'saved', bypassed: true, muted: true, gain: 0.5 });
    expect(progress).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'first' }), expect.objectContaining({ id: 'second' })]);
});

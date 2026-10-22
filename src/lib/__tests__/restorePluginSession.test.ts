import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { restorePluginSession } from '../restorePluginSession';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
const item = (path: string) => ({ path, name: path, enabled: false, muted: true, gain: 0.5, state: 'saved' });
beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'loadPlugin').mockImplementation(async path => path);
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setMute').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setPluginState').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it('状態適用失敗では不完全なVSTを除去し、次の項目を正しい順番で復元する', async () => {
    vi.mocked(audioApi.setPluginState).mockImplementation(async id => { if (id === 'bad') throw new Error('bad state'); });
    const progress = vi.fn();
    expect(await restorePluginSession([item('bad'), item('good')], progress)).toBe(1);
    expect(audioApi.removePlugin).toHaveBeenCalledWith('bad');
    expect(progress).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'good', enabled: false, muted: true, gain: 0.5 })]);
    expect(localStorage.getItem('vst_host_pending_plugin')).toBeNull();
});

it('除去も失敗した場合は存在するVSTを通知し、次のロードを開始しない', async () => {
    vi.mocked(audioApi.setPluginState).mockRejectedValue(new Error('bad state'));
    vi.mocked(audioApi.removePlugin).mockRejectedValue(new Error('cleanup failed'));
    const progress = vi.fn();
    await expect(restorePluginSession([item('bad'), item('later')], progress)).rejects.toThrow('cleanup failed');
    expect(progress).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'bad', gain: 0.5 })]);
    expect(audioApi.loadPlugin).toHaveBeenCalledTimes(1);
});

it('全項目を事前に検証し、不正なJSON構造ではロードも表示変更もしない', async () => {
    const progress = vi.fn();
    for (const value of [{}, [item('valid'), null], [{ ...item('bad'), gain: 'loud' }]]) {
        await expect(restorePluginSession(value, progress)).rejects.toThrow();
    }
    expect(audioApi.loadPlugin).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
});

it('連番の処理中はクラッシュ候補を保持し、既知の問題VSTは読み込まない', async () => {
    let finish!: (id: string) => void;
    vi.mocked(audioApi.loadPlugin).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const progress = vi.fn();
    const restoring = restorePluginSession([item('skip'), item('first'), item('second')], progress, 'skip');
    expect(audioApi.loadPlugin).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('vst_host_pending_plugin')).toBe('first');
    finish('first');
    expect(await restoring).toBe(0);
    expect(audioApi.loadPlugin).toHaveBeenNthCalledWith(2, 'second');
    expect(progress).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'first' }), expect.objectContaining({ id: 'second' })]);
});

import { act, cleanup, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { useGlobalBypass } from '../useGlobalBypass';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

beforeEach(() => { vi.mocked(listen).mockClear(); vi.mocked(toast.info).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function bypassEvent(payload: boolean) {
    const callbacks = vi.mocked(listen).mock.calls.filter(([event]) => event === 'global-bypass-changed').map(([, callback]) => callback);
    act(() => callbacks.forEach(callback => callback({ event: 'global-bypass-changed', id: 1, payload })));
}

async function startAutoEnd() {
    let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValueOnce(undefined).mockReturnValueOnce(ended);
    const view = renderHook(({ empty }) => useGlobalBypass(empty), { initialProps: { empty: false } });
    await act(async () => { await view.result.current.toggle(); });
    expect(view.result.current.bypassed).toBe(true);
    await act(async () => { view.rerender({ empty: true }); });
    expect(bypass).toHaveBeenLastCalledWith(false);
    return { view, finish: () => finish() };
}

it.each(['イベントが先', '応答が先'])('自動で比較を終えたとき、通知は1回だけ出る（%s）', async order => {
    const { view, finish } = await startAutoEnd();
    if (order === 'イベントが先') {
        bypassEvent(false);
        await act(async () => { finish(); });
    } else {
        await act(async () => { finish(); });
        bypassEvent(false);
    }
    expect(view.result.current.bypassed).toBe(false);
    expect(toast.info).toHaveBeenCalledTimes(1);
});

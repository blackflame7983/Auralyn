import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useObsUsage } from '../useObsUsage';
import { obsApi } from '../../api/obs';
vi.mock('../../api/obs', () => ({ obsApi: { disconnect: vi.fn(() => Promise.resolve()) } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
function Consumer({ active }: { active: boolean }) {
    useObsUsage(active);
    return null;
}
afterEach(async () => {
    cleanup();
    await act(async () => {});
    vi.clearAllMocks();
});
it('最後の利用画面を閉じた時だけ切断し、再表示で接続しない', async () => {
    const first = render(<Consumer active />);
    const second = render(<Consumer active />);
    first.unmount();
    await act(async () => {});
    expect(obsApi.disconnect).not.toHaveBeenCalled();
    second.rerender(<Consumer active={false} />);
    await act(async () => {});
    expect(obsApi.disconnect).toHaveBeenCalledTimes(1);
    second.rerender(<Consumer active />);
    await act(async () => {});
    expect(obsApi.disconnect).toHaveBeenCalledTimes(1);
});
it('StrictModeの再購読では使用中の接続を切らない', async () => {
    render(
        <StrictMode>
            <Consumer active />
        </StrictMode>,
    );
    await act(async () => {});
    expect(obsApi.disconnect).not.toHaveBeenCalled();
});

it('画面非表示でも切断し、表示に戻っても自動再接続しない', async () => {
    render(<Consumer active />);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(obsApi.disconnect).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(obsApi.disconnect).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
});

import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

it.each(['close', 'visibility'] as const)('%s による切断待ち中も画面を再表示して操作できる', async reason => {
    let finish!: () => void;
    vi.mocked(obsApi.disconnect).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    function InteractiveConsumer() {
        const [open, setOpen] = useState(true);
        const [count, setCount] = useState(0);
        const used = useObsUsage(open);
        return <>
            <button onClick={() => setOpen(value => !value)}>{open ? '閉じる' : '開く'}</button>
            <button onClick={() => setCount(value => value + 1)}>別の操作 {count}</button>
            <output>{used ? '利用中' : '非表示'}</output>
        </>;
    }
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    try {
        render(<InteractiveConsumer />);
        if (reason === 'close') fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
        else {
            hidden.mockReturnValue(true);
            act(() => document.dispatchEvent(new Event('visibilitychange')));
        }
        await act(async () => {});
        expect(obsApi.disconnect).toHaveBeenCalledTimes(1);
        expect(screen.getByText('非表示')).toBeInTheDocument();
        if (reason === 'close') fireEvent.click(screen.getByRole('button', { name: '開く' }));
        else {
            hidden.mockReturnValue(false);
            act(() => document.dispatchEvent(new Event('visibilitychange')));
        }
        fireEvent.click(screen.getByRole('button', { name: '別の操作 0' }));
        expect(screen.getByText('利用中')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '別の操作 1' })).toBeInTheDocument();
        expect(obsApi.disconnect).toHaveBeenCalledTimes(1);
        await act(async () => finish());
    } finally {
        hidden.mockRestore();
    }
});

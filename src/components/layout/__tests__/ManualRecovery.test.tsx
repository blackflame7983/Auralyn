import { type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../../api/audio';
import { ModalLayer } from '../ModalLayer';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
it('Start失敗はclose・保存に進まず、同じ画面で再試行できる', async () => {
    const start = vi.spyOn(audioApi, 'start').mockRejectedValueOnce(new Error('start failed')).mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const recover = vi.fn(async (_exclude: unknown, resume?: () => Promise<unknown>) => { await resume?.(); });
    const close = vi.fn();
    const save = vi.fn();
    const props = {
        ui: { isRecoveryModalOpen: true, setIsRecoveryModalOpen: close, crashError: '停止' },
        audioConfig: { host: 'WASAPI' },
        pluginsApi: { recoverSession: recover, savePreset: save },
        handleConfigUpdate: vi.fn(), onPluginAdded: vi.fn(),
    } as unknown as ComponentProps<typeof ModalLayer>;
    render(<ModalLayer {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '全セッションを再読み込み' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('操作を完了できませんでした');
    expect(recover).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '全セッションを再読み込み' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(start).toHaveBeenCalledTimes(2); expect(recover).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
});

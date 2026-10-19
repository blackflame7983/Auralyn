import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionCheck } from '../ConnectionCheck';

afterEach(async () => {
    cleanup();
    await act(async () => {});
    vi.restoreAllMocks();
    vi.mocked(invoke).mockReset();
});

const renderCheck = (onStartAudio = vi.fn(async () => true)) => {
    render(
        <ConnectionCheck
            goal="obs"
            outputName="CABLE Input"
            isBroadcast
            disabled={false}
            audioRunning
            onStartAudio={onStartAudio}
            onBusyChange={() => {}}
        />,
    );
    return onStartAudio;
};

it.each(['成功', '失敗'] as const)(
    '非表示前の遅い接続%sを破棄し、明示接続でだけ再開する',
    async (outcome) => {
        let finish!: () => void;
        let connected = false;
        let attempts = 0;
        vi.mocked(invoke).mockImplementation((command) => {
            if (command === 'connect_obs') {
                if (attempts++ === 0)
                    return new Promise<void>((resolve, reject) => {
                        finish = () => {
                            if (outcome === '失敗') reject(new Error('遅い失敗'));
                            else {
                                connected = true;
                                resolve();
                            }
                        };
                    });
                connected = true;
            }
            if (command === 'disconnect_obs') connected = false;
            return Promise.resolve();
        });
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        renderCheck();
        expect(screen.getByText(/ウィザードを閉じると接続を終了/)).toBeInTheDocument();
        expect(screen.queryByText(/閉じた後も維持/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await act(async () => {});
        hidden.mockReturnValue(true);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        // 応答が返る前に再表示しても、非表示前の接続は採用しない。
        hidden.mockReturnValue(false);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await act(async () => {
            finish();
        });
        expect(invoke).toHaveBeenCalledWith('disconnect_obs');
        expect(connected).toBe(false);
        expect(screen.getByRole('status')).toHaveTextContent('OBS への接続は終了しました。');
        expect(
            screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' }),
        ).toBeDisabled();
        expect(attempts).toBe(1);
        fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
        await act(async () => {});
        expect(connected).toBe(true);
        expect(attempts).toBe(2);
        expect(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' })).toBeEnabled();
    },
);

it('音声開始を待つ間に非表示になった場合は到達確認のテスト音を開始しない', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    let finish!: (value: boolean) => void;
    const startAudio = vi.fn(
        () =>
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
    );
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    renderCheck(startAudio);
    fireEvent.click(screen.getByRole('button', { name: 'OBS に接続する' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'テスト音で OBS への到達を確認' }));
    hidden.mockReturnValue(true);
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
        finish(true);
    });
    expect(invoke).not.toHaveBeenCalledWith('obs_check_audio_reach', expect.anything());
    expect(screen.getByRole('status')).toHaveTextContent('OBS への接続は終了しました。');
});

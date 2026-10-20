import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { VoiceCheckModal } from '../VoiceCheckModal';

const running = { running: true, streamFailed: false };
const stopped = { running: false, streamFailed: false };
const open = (onSettings = vi.fn()) => render(<VoiceCheckModal isOpen onClose={vi.fn()} onOpenAudioSettings={onSettings} />);
const record = () => screen.getByRole('button', { name: /録音開始/ });
const emit = (name: string) => {
    for (const [event, callback] of vi.mocked(listen).mock.calls) {
        if (event === name) callback({ event: name, id: 1, payload: null });
    }
};

beforeEach(() => {
    vi.mocked(listen).mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ config: null, is_running: true });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue(running);
    vi.spyOn(audioApi, 'startVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheckPlayback').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('状態確認中と停止中は録音せず、設定への入口を示す', async () => {
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue(stopped);
    const settings = vi.fn();
    open(settings);
    expect(record()).toBeDisabled();
    await screen.findByText(/音声が停止しています/);
    expect(record()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});

it('取得失敗後に明示的に再確認して復帰できる', async () => {
    vi.mocked(audioApi.getAudioStreamState).mockRejectedValueOnce(new Error('offline'));
    open();
    await screen.findByText(/音声の状態を確認できません/);
    expect(record()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '状態を再確認' }));
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await waitFor(() => expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce());
});

it('クリック直前の再確認で停止していたら録音コマンドを送らない', async () => {
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValueOnce(running).mockResolvedValue(stopped);
    open();
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await screen.findByText(/音声が停止しています/);
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});

it('停止通知より古い稼働応答で録音可能へ戻さない', async () => {
    let resolve!: (value: typeof running) => void;
    vi.mocked(audioApi.getAudioStreamState).mockReturnValue(new Promise(r => { resolve = r; }));
    open();
    await waitFor(() => expect(audioApi.getAudioStreamState).toHaveBeenCalledOnce());
    act(() => emit('audio-stopped'));
    await act(async () => resolve(running));
    expect(record()).toBeDisabled();
    expect(screen.getByText(/音声が停止しています/)).toBeInTheDocument();
});

it('録音開始失敗を画面内に残し、再試行の方法を示す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(audioApi.startVoiceCheck).mockRejectedValue(new Error('start failed'));
    open();
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('音声の状態を再確認');
    expect(screen.getByRole('button', { name: '状態を再確認' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'マイクと出力先を設定する' })).toBeInTheDocument();
});

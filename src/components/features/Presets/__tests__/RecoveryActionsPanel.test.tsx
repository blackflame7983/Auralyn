import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { message } from '@/i18n/messages';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { RecoveryActionsPanel } from '../RecoveryActionsPanel';

vi.mock('../BroadcastBundlePanel', () => ({ BroadcastBundlePanel: () => null }));
const emit = (name: string) => {
    for (const [event, callback] of vi.mocked(listen).mock.calls) {
        if (event === name) callback({ event, id: 1, payload: null });
    }
};
const open = async () => {
    const view = render(<RecoveryActionsPanel />);
    fireEvent.click(screen.getByText(message('ja', 'recovery.failureTitle')));
    await waitFor(() => expect(screen.getByRole('button', { name: message('ja', 'recovery.inspect') })).toBeEnabled());
    return view;
};
beforeEach(() => { vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('取得済みの稼働表示もStopで失効し、手動の再取得で停止を確認できる', async () => {
    const request = vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    await open();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'recovery.inspect') }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.running')));
    act(() => emit('audio-stopped'));
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.unknown'));
    request.mockResolvedValue({ running: false, streamFailed: false });
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'recovery.inspect') }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.stopped')));
});

it.each(['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'])('%s通知前の遅いrunning応答を採用しない', async event => {
    let resolve!: (value: { running: boolean; streamFailed: boolean }) => void;
    vi.spyOn(audioApi, 'getAudioStreamState').mockImplementation(() => new Promise(done => { resolve = done; }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'recovery.inspect') }));
    act(() => emit(event));
    await act(async () => resolve({ running: true, streamFailed: false }));
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.unknown'));
    expect(screen.getByRole('button', { name: message('ja', 'recovery.inspect') })).toBeEnabled();
});

it('非表示化やunmountより前の応答は、後から開いた画面の状態へ混ぜない', async () => {
    let resolve!: (value: { running: boolean; streamFailed: boolean }) => void;
    const request = vi.spyOn(audioApi, 'getAudioStreamState').mockImplementation(() => new Promise(done => { resolve = done; }));
    const first = await open();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'recovery.inspect') }));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    hidden.mockReturnValue(false);
    await act(async () => resolve({ running: true, streamFailed: false }));
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.unknown'));
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'recovery.inspect') }));
    const oldResolve = resolve;
    first.unmount();
    request.mockResolvedValue({ running: false, streamFailed: false });
    await open();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'recovery.inspect') }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.stopped')));
    await act(async () => oldResolve({ running: true, streamFailed: false }));
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.stopped'));
});

it('停止通知の購読を確認できない場合は現在状態として表示しない', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('subscription unavailable'));
    const request = vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    render(<RecoveryActionsPanel />);
    fireEvent.click(screen.getByText(message('ja', 'recovery.failureTitle')));
    await act(async () => {});
    expect(screen.getByRole('button', { name: message('ja', 'recovery.inspect') })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'recovery.state.unknown'));
    expect(request).not.toHaveBeenCalled();
});


it.each(['ja', 'en'] as const)('%sで各復元先を一覧表示し、現在のUndo可否を取得しない', locale => {
    const inspect = vi.spyOn(audioApi, 'getAudioStreamState');
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><RecoveryActionsPanel /></LocaleProvider>);
    fireEvent.click(screen.getByText(message(locale, 'recovery.undoTitle')));
    const list = screen.getByRole('list');
    expect(list.querySelectorAll('li')).toHaveLength(6);
    for (const item of ['nr', 'builtin', 'gain', 'profile', 'bundle', 'monitor'] as const) {
        expect(list).toHaveTextContent(message(locale, `recovery.undo.${item}`));
    }
    expect(screen.getByText(message(locale, 'recovery.undoScope'))).toBeVisible();
    expect(inspect).not.toHaveBeenCalled();
});

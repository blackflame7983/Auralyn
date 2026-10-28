import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { LoudnessCheck } from '../LoudnessCheck';
import { classifyLoudness, LoudnessReading } from '../loudnessVerdict';

const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (event, cb) => {
        listeners.set(event, cb);
        return () => listeners.delete(event);
    }),
}));
vi.mock('@/api/audio', () => ({ audioApi: { setLoudnessMeasurement: vi.fn() } }));
const reading: LoudnessReading = {
    id: 1,
    ready: true,
    silent: false,
    supported: true,
    short_term_lufs: -20,
    true_peak_dbtp: -8,
};
const emit = (event: string, payload: unknown) => act(() => listeners.get(event)?.({ payload }));
beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    vi.mocked(audioApi.setLoudnessMeasurement).mockResolvedValue(undefined);
});
afterEach(async () => {
    cleanup();
    // アンマウント時の停止要求まで完了し、次のケースへ持ち越さない。
    await act(async () => {});
    vi.useRealTimers();
});

describe('音量判定の境界', () => {
    it('短い過大ピークはLUFS準備前・無音区間でも警告する', () => {
        const short = { ...reading, ready: false, short_term_lufs: null, true_peak_dbtp: 0 };
        expect(classifyLoudness(short, -20, null)).toBe('high');
        expect(classifyLoudness({ ...short, silent: true }, -20, null)).toBe('high');
        expect(classifyLoudness({ ...short, true_peak_dbtp: -8 }, -20, null)).toBeNull();
        expect(classifyLoudness({ ...short, supported: false }, -20, null)).toBeNull();
    });
    it('無音・測定不足・不正値はちょうどいいにしない', () => {
        for (const patch of [
            { ready: false },
            { silent: true },
            { short_term_lufs: null },
            { short_term_lufs: NaN },
            { supported: false },
            { true_peak_dbtp: Infinity },
        ]) {
            expect(classifyLoudness({ ...reading, ...patch }, -20, null)).toBeNull();
        }
    });
    it('目標を変更でき、ヒステリシスと過大ピークを判定する', () => {
        expect(classifyLoudness(reading, -20, null)).toBe('good');
        expect(classifyLoudness(reading, -14, null)).toBe('low');
        expect(classifyLoudness({ ...reading, short_term_lufs: -23.5 }, -20, 'good')).toBe('good');
        expect(classifyLoudness({ ...reading, short_term_lufs: -24.1 }, -20, 'good')).toBe('low');
        expect(classifyLoudness({ ...reading, short_term_lufs: -22.5 }, -20, 'low')).toBe('low');
        expect(classifyLoudness({ ...reading, short_term_lufs: -21.5 }, -20, 'low')).toBe('good');
        expect(classifyLoudness({ ...reading, true_peak_dbtp: -0.5 }, -20, 'good')).toBe('high');
    });
});

describe('出力の音量チェック', () => {
    it('未測定でも障害・停止通知と破棄は停止だけを要求し、測定を開始しない', async () => {
        const view = render(<LoudnessCheck running={false} onVoiceCheck={() => {}} />);
        await act(async () => {});
        for (const event of ['audio-error', 'audio-stopped', 'audio-started']) {
            await act(async () => { emit(event, {}); });
        }
        view.unmount();
        await act(async () => {});
        expect(audioApi.setLoudnessMeasurement).toHaveBeenCalled();
        expect(vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.every(([id]) => id === null)).toBe(true);
    });
    async function start() {
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        expect(screen.getByRole('button', { name: '測定を止める' })).toBeInTheDocument();
        const calls = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls;
        return calls[calls.length - 1][0] as number;
    }
    it('初期は追加測定を起動せず、停止中は開始できない', () => {
        render(<LoudnessCheck running={false} onVoiceCheck={() => {}} />);
        expect(screen.getByRole('button', { name: '測定する' })).toBeDisabled();
        expect(audioApi.setLoudnessMeasurement).not.toHaveBeenCalled();
    });
    it('継続した測定で判定し、無音・古いID・再起動で成功表示を消す', async () => {
        vi.useFakeTimers();
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        const id = await start();
        emit('audio-loudness', { ...reading, id });
        act(() => vi.advanceTimersByTime(900));
        emit('audio-loudness', { ...reading, id });
        expect(screen.getByRole('status')).toHaveTextContent('ちょうどいい');
        emit('audio-loudness', {
            ...reading,
            id,
            silent: true,
            ready: false,
            short_term_lufs: null,
        });
        expect(screen.getByRole('status')).not.toHaveTextContent('ちょうどいい');
        await act(async () => {
            emit('audio-started', {});
        });
        emit('audio-loudness', { ...reading, id });
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中');
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
    });
    it('データが途絶えたときは過去の判定を表示しない', async () => {
        vi.useFakeTimers();
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        const id = await start();
        emit('audio-loudness', { ...reading, id });
        act(() => vi.advanceTimersByTime(900));
        emit('audio-loudness', { ...reading, id });
        expect(screen.getByRole('status')).toHaveTextContent('ちょうどいい');
        act(() => vi.advanceTimersByTime(2100));
        expect(screen.getByRole('status')).toHaveTextContent('音声データを確認できません');
    });
    it('3秒未満の過大ピークを800ms待たずに表示する', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        const id = await start();
        emit('audio-loudness', {
            ...reading,
            id,
            ready: false,
            short_term_lufs: null,
            true_peak_dbtp: 0,
        });
        expect(screen.getByRole('status')).toHaveTextContent('大きすぎ');
        emit('audio-loudness', {
            ...reading,
            id,
            ready: false,
            silent: true,
            short_term_lufs: null,
            true_peak_dbtp: 0,
        });
        expect(screen.getByRole('status')).toHaveTextContent('大きすぎ');
        emit('audio-loudness', {
            ...reading,
            id,
            ready: false,
            silent: true,
            short_term_lufs: null,
            true_peak_dbtp: null,
        });
        expect(screen.getByRole('status')).not.toHaveTextContent('ちょうどいい');
        expect(screen.getByRole('status')).not.toHaveTextContent('大きすぎ');
    });
    it('目標を変更すると古い成功を消して、新しい目標で判定する', async () => {
        vi.useFakeTimers();
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        const id = await start();
        emit('audio-loudness', { ...reading, id });
        act(() => vi.advanceTimersByTime(900));
        emit('audio-loudness', { ...reading, id });
        expect(screen.getByRole('status')).toHaveTextContent('ちょうどいい');
        fireEvent.change(screen.getByRole('combobox', { name: '声用の目標（仮の目安）', hidden: true }), {
            target: { value: '-14' },
        });
        expect(screen.getByRole('status')).not.toHaveTextContent('ちょうどいい');
        emit('audio-loudness', { ...reading, id });
        act(() => vi.advanceTimersByTime(900));
        emit('audio-loudness', { ...reading, id });
        expect(screen.getByRole('status')).toHaveTextContent('小さめ');
    });
    it('停止失敗で成功表示を消し、停止を再試行してから停止済みにする', async () => {
        const open = vi.fn();
        render(<LoudnessCheck running onVoiceCheck={open} />);
        const id = await start();
        vi.mocked(audioApi.setLoudnessMeasurement).mockRejectedValueOnce(new Error('closed'));
        fireEvent.click(screen.getByRole('button', { name: '測定を止める' }));
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(screen.getByRole('status')).toHaveTextContent('測定の停止を確認できません');
        emit('audio-loudness', { ...reading, id });
        expect(screen.getByRole('status')).not.toHaveTextContent('ちょうどいい');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '停止を再試行' }));
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
        fireEvent.click(screen.getByText('目安と測定について'));
        fireEvent.click(screen.getByRole('button', { name: 'ボイスチェックで聴いて確認する' }));
        expect(open).toHaveBeenCalledOnce();
    });
    it('入力エラー後の停止失敗も未確認を保ち、停止を再試行できる', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        const id = await start();
        vi.mocked(audioApi.setLoudnessMeasurement).mockRejectedValueOnce(new Error('closed'));
        await act(async () => {
            emit('audio-stream-error', 'Input Stream Error');
        });
        expect(screen.getByRole('status')).toHaveTextContent('測定の停止を確認できません');
        expect(screen.getByRole('button', { name: '停止を再試行' })).toBeEnabled();
        emit('audio-loudness', { ...reading, id, true_peak_dbtp: 0 });
        expect(screen.getByRole('status')).not.toHaveTextContent('大きすぎ');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '停止を再試行' }));
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
    });
    it('入力エラー後の停止応答を待ってから停止済みにする', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await start();
        let resolveStop!: () => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveStop = resolve;
                }),
        );
        await act(async () => {
            emit('audio-stream-error', 'Input Stream Error');
        });
        expect(screen.getByRole('status')).toHaveTextContent('測定を停止しています');
        expect(screen.getByRole('button', { name: '切替中…' })).toBeDisabled();
        await act(async () => {
            resolveStop();
        });
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
    });
    it('入力エラー後の停止待機中に再起動したら古い失敗を採用しない', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await start();
        let rejectStop!: (error: Error) => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectStop = reject;
                }),
        );
        await act(async () => {
            emit('audio-stream-error', 'Input Stream Error');
        });
        emit('audio-started', {});
        await act(async () => {
            rejectStop(new Error('old error cleanup'));
        });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
        expect(screen.getByRole('button', { name: '測定する' })).toBeEnabled();
    });
    it('開始応答を失った場合も停止で状態を確認できる', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        vi.mocked(audioApi.setLoudnessMeasurement).mockRejectedValueOnce(new Error('timeout'));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        expect(screen.getByRole('button', { name: '停止を再試行' })).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '停止を再試行' }));
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
    });
    it.each(['audio-stopped', 'audio-started'])(
        '停止待機中の%s後に古い失敗で測定を戻さない',
        async (event) => {
            render(<LoudnessCheck running onVoiceCheck={() => {}} />);
            const id = await start();
            let rejectStop!: (error: Error) => void;
            vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        rejectStop = reject;
                    }),
            );
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: '測定を止める' }));
            });
            emit(event, {});
            await act(async () => {
                rejectStop(new Error('old stop failed'));
            });
            emit('audio-loudness', { ...reading, id });
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
            expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
            expect(screen.getByRole('button', { name: '測定する' })).toBeEnabled();
        },
    );
    it('再起動後の開始は古い停止とリセットの完了後に適用する', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        const previous = await start();
        let rejectStop!: (error: Error) => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectStop = reject;
                }),
        );
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定を止める' }));
        });
        emit('audio-started', {});
        fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        expect(audioApi.setLoudnessMeasurement).toHaveBeenCalledTimes(2);
        await act(async () => {
            rejectStop(new Error('old stop'));
        });
        const ids = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.map((call) => call[0]);
        expect(ids.slice(0, 3)).toEqual([previous, null, null]);
        expect(ids[3]).toBeGreaterThan(previous);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: '測定を止める' })).toBeEnabled();
    });
});

describe('未使用時の音量測定', () => {
    it('稼働未確認の初期表示を停止確定と区別し、測定を開始しない', () => {
        render(<LoudnessCheck running={false} stateKnown={false} onVoiceCheck={() => {}} />);
        expect(screen.getByRole('status')).toHaveTextContent('音声の稼働状態を確認できません');
        expect(screen.getByRole('button', { name: '測定する' })).toBeDisabled();
        expect(audioApi.setLoudnessMeasurement).not.toHaveBeenCalled();
    });
    it('稼働状態が回復しても、待機中の停止応答を無効にせず確認する', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '測定する' })); });
        let rejectStop!: (error: Error) => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(() => new Promise((_, reject) => { rejectStop = reject; }));
        await act(async () => { view.rerender(<LoudnessCheck running={false} onVoiceCheck={() => {}} />); });
        view.rerender(<LoudnessCheck running onVoiceCheck={() => {}} />);
        expect(screen.getByRole('status')).toHaveTextContent('測定を停止しています');
        await act(async () => { rejectStop(new Error('offline')); });
        expect(screen.getByRole('button', { name: '停止を再試行' })).toBeEnabled();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止を再試行' })); });
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
    });
    it('稼働状態が未確認になったら停止応答を待ち、失敗しても再試行できる', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        let rejectStop!: (error: Error) => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(() => new Promise((_, reject) => { rejectStop = reject; }));
        await act(async () => {
            view.rerender(<LoudnessCheck running={false} onVoiceCheck={() => {}} />);
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.getByRole('status')).toHaveTextContent('測定を停止しています');
        await act(async () => { rejectStop(new Error('offline')); });
        expect(screen.getByRole('status')).toHaveTextContent('測定の停止を確認できません');
        expect(screen.getByRole('button', { name: '停止を再試行' })).toBeEnabled();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '停止を再試行' }));
        });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: '測定する' })).toBeDisabled();
    });
    it('非表示中の停止失敗は、稼働状態の取得失敗や回復で消さない', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        vi.mocked(audioApi.setLoudnessMeasurement).mockRejectedValueOnce(new Error('failed'));
        await act(async () => {
            view.rerender(<LoudnessCheck running enabled={false} onVoiceCheck={() => {}} />);
        });
        const calls = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.length;
        view.rerender(<LoudnessCheck running={false} enabled={false} onVoiceCheck={() => {}} />);
        expect(screen.getByRole('alert')).toHaveTextContent('停止を再試行');
        expect(screen.getByRole('button', { name: '停止を再試行' })).toBeEnabled();
        view.rerender(<LoudnessCheck running enabled={false} onVoiceCheck={() => {}} />);
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(audioApi.setLoudnessMeasurement).toHaveBeenCalledTimes(calls);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '停止を再試行' }));
        });
        expect(screen.queryByRole('region', { name: '出力の音量チェック' })).not.toBeInTheDocument();
    });
    it('開始応答中に稼働状態を失っても、遅い開始の後に停止する', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        let finish!: () => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        view.rerender(<LoudnessCheck running={false} enabled={false} onVoiceCheck={() => {}} />);
        await act(async () => { finish(); });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.queryByRole('region', { name: '出力の音量チェック' })).not.toBeInTheDocument();
    });
    it('未使用の表示を畳み、再表示だけでは測定を開始しない', () => {
        const view = render(<LoudnessCheck running enabled={false} onVoiceCheck={() => {}} />);
        expect(screen.queryByRole('region', { name: '出力の音量チェック' })).not.toBeInTheDocument();
        view.rerender(<LoudnessCheck running onVoiceCheck={() => {}} />);
        expect(screen.getByRole('button', { name: '測定する' })).toBeEnabled();
        expect(audioApi.setLoudnessMeasurement).not.toHaveBeenCalled();
    });
    it('測定中の利用OFFは停止応答を確認し、再有効化しても自動で開始しない', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        await act(async () => {
            view.rerender(<LoudnessCheck running enabled={false} onVoiceCheck={() => {}} />);
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.queryByRole('region', { name: '出力の音量チェック' })).not.toBeInTheDocument();
        const calls = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.length;
        view.rerender(<LoudnessCheck running onVoiceCheck={() => {}} />);
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中');
        expect(audioApi.setLoudnessMeasurement).toHaveBeenCalledTimes(calls);
    });
    it('利用OFF中の停止失敗を隠さず、停止を再試行できる', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        vi.mocked(audioApi.setLoudnessMeasurement).mockRejectedValueOnce(new Error('failed'));
        await act(async () => {
            view.rerender(<LoudnessCheck running enabled={false} onVoiceCheck={() => {}} />);
        });
        expect(screen.getByRole('button', { name: '停止を再試行' })).toBeEnabled();
        expect(screen.getByRole('alert')).toHaveTextContent('停止を再試行');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '停止を再試行' }));
        });
        expect(screen.queryByRole('region', { name: '出力の音量チェック' })).not.toBeInTheDocument();
    });
    it('開始応答待機中に利用OFFでも、遅い開始の後へ停止を適用する', async () => {
        const view = render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        let finish!: () => void;
        vi.mocked(audioApi.setLoudnessMeasurement).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        view.rerender(<LoudnessCheck running enabled={false} onVoiceCheck={() => {}} />);
        await act(async () => {
            finish();
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        expect(screen.queryByRole('region', { name: '出力の音量チェック' })).not.toBeInTheDocument();
    });
    it('画面が非表示になると停止し、戻っても測定を再開しない', async () => {
        render(<LoudnessCheck running onVoiceCheck={() => {}} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '測定する' }));
        });
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
        hidden.mockReturnValue(false);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(screen.getByRole('status')).toHaveTextContent('測定は停止中');
        hidden.mockRestore();
    });
});

it('測定中のlocale変更で測定ID・目標・購読を保持し、無音を合格へ変えない', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><LoudnessCheck running onVoiceCheck={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '測定する' }));
    await waitFor(() => expect(audioApi.setLoudnessMeasurement).toHaveBeenCalledWith(expect.any(Number)));
    const measurementCalls = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls;
    const id = measurementCalls[measurementCalls.length - 1][0]!;
    const calls = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.length;
    const callback = listeners.get('audio-loudness');
    emit('audio-loudness', { ...reading, id, silent: true });
    act(() => { store.setLocale('en'); });
    expect(vi.mocked(audioApi.setLoudnessMeasurement).mock.calls).toHaveLength(calls);
    expect(listeners.get('audio-loudness')).toBe(callback);
    expect(screen.queryByText('About right')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop measurement/ })).toBeInTheDocument();
});


it('明示的な開始要求を一度だけ消費し、再表示や稼働回復では再開しない', async () => {
    const request = {id: 42, action: 'start' as const};
    const view = render(<LoudnessCheck running enabled request={request} onVoiceCheck={() => {}} />);
    await act(async () => {});
    expect(vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.filter(([id]) => id !== null)).toHaveLength(1);
    view.rerender(<LoudnessCheck running enabled request={request} onVoiceCheck={() => {}} />);
    await act(async () => {});
    expect(vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.filter(([id]) => id !== null)).toHaveLength(1);
    view.rerender(<LoudnessCheck running enabled={false} request={request} onVoiceCheck={() => {}} />);
    await act(async () => {});
    expect(audioApi.setLoudnessMeasurement).toHaveBeenLastCalledWith(null);
    view.rerender(<LoudnessCheck running enabled request={request} onVoiceCheck={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('測定は停止中です');
    expect(vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.filter(([id]) => id !== null)).toHaveLength(1);
});
it('稼働未確認の要求は後の状態回復で実行せず、新しい操作を待つ', async () => {
    const request = {id: 43, action: 'start' as const};
    const view = render(<LoudnessCheck running stateKnown={false} request={request} onVoiceCheck={() => {}} />);
    expect(screen.getByRole('button', {name: '測定する'})).toBeDisabled();
    view.rerender(<LoudnessCheck running stateKnown request={request} onVoiceCheck={() => {}} />);
    await act(async () => {});
    expect(vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.filter(([id]) => id !== null)).toHaveLength(0);
});

it('音楽表示は声用の目標・自動調整を出さず測定値とピークを表示する', async () => {
    render(<LoudnessCheck running music request={{id: 60, action: 'start'}} onVoiceCheck={() => {}} />);
    await act(async () => {});
    const id = vi.mocked(audioApi.setLoudnessMeasurement).mock.calls.find(([value]) => value !== null)![0]!;
    emit('audio-loudness', {...reading, id});
    expect(screen.getByRole('status')).toHaveTextContent('出力の測定値を表示しています');
    expect(screen.queryByRole('button', {name: '音量を合わせる'})).not.toBeInTheDocument();
    expect(screen.getByText(/-20.0/)).toBeInTheDocument();
    emit('audio-loudness', {...reading, id, true_peak_dbtp: 0});
    expect(screen.getByRole('status')).toHaveTextContent('出力のピークが高くなっています');
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { LevelMeter } from '../LevelMeter';
import { LargeLevelMeter } from '../LargeLevelMeter';
import { MeterProvider } from '../MeterContext';
import { MeterVisual } from '../MeterVisual';

const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (name: string, payload?: unknown) => act(() => handlers.get(name)?.forEach(fn => fn({ payload })));
beforeEach(() => {
    vi.useFakeTimers(); handlers.clear();
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        const fn = callback as unknown as (event: { payload: unknown }) => void;
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => { handlers.get(name)?.delete(fn); };
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(listen).mockReset(); });
it('無音通知後の減衰残値を極端なdBFS値として表示しない', () => {
    render(<MeterVisual label="出力" showValues reading={{ levels: [1e-300, 1e-300], peak: [.1, .1], clipped: false, state: 'silent', resetClip: () => {} }} />);
    expect(screen.getByRole('meter', { name: '出力' })).toHaveAttribute('aria-valuetext', '−∞ dBFS');
    expect(screen.getByText('−∞ dBFS')).toBeInTheDocument();
});
it('フッター用の小表示は数値とクリップがあっても固定のバー高さを保つ', () => {
    render(<MeterVisual label="出力" height={28} width={12} showValues reading={{ levels: [1, 1], peak: [1, 1], clipped: true, state: 'live', resetClip: () => {} }} />);
    expect(screen.getByRole('meter', { name: '出力' })).toHaveStyle({ height: '28px' });
    expect(screen.getByRole('button', { name: /クリップ表示を消す/ })).toBeInTheDocument();
});
it('小メーターは入力を選び、停止後は旧値を表示しない', () => {
    render(<LevelMeter running type="input" />);
    emit('audio-level', { input: [1.2, 1.2], output: [0, 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByLabelText('入力レベル: レベル表示中')).toBeInTheDocument();
    emit('audio-stopped');
    expect(screen.getByLabelText('入力レベル: 音声停止中')).toBeInTheDocument();
    expect(screen.getByTitle('Left').firstElementChild).toHaveStyle({ height: '0%' });
});
it('大メーターはtimeoutでもclipを保持し、手動で消せる', () => {
    render(<LargeLevelMeter running onClose={() => {}} />);
    emit('audio-level', { input: [0, 0], output: [1.2, 1.2] });
    act(() => vi.advanceTimersByTime(16)); expect(screen.getByText('クリップ')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByRole('status')).toHaveTextContent('更新待ち'); expect(screen.getByText('クリップ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /クリップ表示を消す/ }));
    expect(screen.queryByText('クリップ')).toBeNull();
    emit('audio-level', { input: [0, 0], output: [0, 0] });
    act(() => vi.advanceTimersByTime(3000)); expect(screen.getByText('無音')).toBeInTheDocument();
    emit('audio-stream-error'); expect(screen.getByRole('status')).toHaveTextContent('停止中');
});

it('同じ出力の表示はクリップを共有し、1か所の解除が両方に反映される', () => {
    render(<MeterProvider running><LevelMeter running type="output" /><LevelMeter running type="output" /></MeterProvider>);
    expect(handlers.get('audio-level')?.size).toBe(2);
    emit('audio-level', { input: [0, 0], output: [1, .5] });
    act(() => vi.advanceTimersByTime(16));
    const reset = screen.getAllByRole('button', { name: /クリップ表示を消す/ });
    expect(reset).toHaveLength(2);
    fireEvent.click(reset[0]);
    expect(screen.queryAllByRole('button', { name: /クリップ表示を消す/ })).toHaveLength(0);
});

it('−3 dBFS は注意色、0 dBFS 到達は危険色とクリップ表示になる', () => {
    render(<LevelMeter running type="output" />);
    emit('audio-level', { input: [0, 0], output: [Math.pow(10, -3 / 20), 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByTitle('Left').firstElementChild).toHaveClass('bg-warning');
    expect(screen.queryByRole('button', { name: /クリップ表示を消す/ })).toBeNull();
    emit('audio-level', { input: [0, 0], output: [1, 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByTitle('Left').firstElementChild).toHaveClass('bg-meter-danger');
    expect(screen.getByRole('button', { name: /クリップ表示を消す/ })).toBeInTheDocument();
});

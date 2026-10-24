import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { LevelMeter } from '../LevelMeter';
import { LargeLevelMeter } from '../LargeLevelMeter';

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
it('小メーターは入力を選び、停止後は旧値を表示しない', () => {
    render(<LevelMeter running type="input" />);
    emit('audio-level', { input: [1.2, 1.2], output: [0, 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByLabelText('入力レベル: レベル表示中')).toBeInTheDocument();
    emit('audio-stopped');
    expect(screen.getByLabelText('入力レベル: 音声停止中')).toBeInTheDocument();
    expect(screen.getByTitle('Left').firstElementChild?.firstElementChild).toHaveStyle({ height: '0%' });
});
it('大メーターはtimeoutでclipを破棄し、無音と停止を区別する', () => {
    render(<LargeLevelMeter running onClose={() => {}} />);
    emit('audio-level', { input: [0, 0], output: [1.2, 1.2] });
    act(() => vi.advanceTimersByTime(16)); expect(screen.getByText('Clip!')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByText('レベル更新待ち')).toBeInTheDocument(); expect(screen.queryByText('Clip!')).toBeNull();
    emit('audio-level', { input: [0, 0], output: [0, 0] });
    act(() => vi.advanceTimersByTime(3000)); expect(screen.getByText('無音')).toBeInTheDocument();
    emit('audio-stream-error'); expect(screen.getByText('音声停止中')).toBeInTheDocument();
});

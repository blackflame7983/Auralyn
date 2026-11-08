import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { MeterProvider, useSharedMeter } from '../MeterContext';
import { LiveStrip } from '../../Home/LiveStrip';
import { MasterBar } from '@/components/layout/MasterBar';
import type { PreparationModel } from '@/hooks/usePreparation';

const controls = vi.hoisted(() => ({ input: vi.fn(), output: vi.fn() }));
vi.mock('../../Home/InputGainControl', () => ({ InputGainControl: () => { controls.input(); return <button>input control</button>; } }));
vi.mock('@/components/ui/slider', () => ({ Slider: () => { controls.output(); return <button>output control</button>; } }));
vi.mock('@/hooks/useRuntimeStats', () => ({ useRuntimeStats: () => null, useRuntimeStatsUnavailable: () => false, invalidateRuntimeStats: vi.fn() }));
vi.mock('@/api/audio', () => ({ audioApi: { getAudioState: vi.fn().mockResolvedValue({ is_running: false }) } }));
const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (input: number, output: number) => act(() => handlers.get('audio-level')?.forEach(fn => fn({ payload: { input: [input, input], output: [output, output] } })));
beforeEach(() => {
    vi.useFakeTimers(); handlers.clear(); vi.clearAllMocks();
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        const fn = callback as unknown as (event: { payload: unknown }) => void;
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => { handlers.get(name)?.delete(fn); };
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(listen).mockReset(); });

it.each(['input', 'output'] as const)('%sだけの更新は反対側の購読者を再描画しない', type => {
    const renders = { input: 0, output: 0 };
    function Reading({ type }: { type: 'input' | 'output' }) {
        const reading = useSharedMeter(true, type); renders[type]++;
        return <span>{type}:{reading.levels[0]}</span>;
    }
    render(<MeterProvider running><Reading type="input" /><Reading type="output" /></MeterProvider>);
    emit(type === 'input' ? .2 : 0, type === 'output' ? .2 : 0); act(() => vi.advanceTimersByTime(16));
    const previous = { ...renders };
    for (let i = 0; i < 20; i++) { emit(type === 'input' ? .2 + i / 100 : 0, type === 'output' ? .2 + i / 100 : 0); act(() => vi.advanceTimersByTime(16)); }
    expect(renders[type]).toBeGreaterThan(previous[type]);
    const other = type === 'input' ? 'output' : 'input';
    expect(renders[other]).toBe(previous[other]);
    expect(handlers.get('audio-level')?.size).toBe(2);
});

it('レベルとクリップが変わっても本番帯とフッターの操作部品を再描画しない', () => {
    const model = { context: { usage: 'obs', receiver: '' }, observation: { availability: 'ready', config: null } } as PreparationModel;
    render(<MeterProvider running><LiveStrip running model={model} /><MasterBar isRunning host="WASAPI" processReady /></MeterProvider>);
    const previous = { input: controls.input.mock.calls.length, output: controls.output.mock.calls.length };
    for (let i = 0; i < 20; i++) { emit(.3 + i / 100, i === 19 ? 1.2 : .4 + i / 100); act(() => vi.advanceTimersByTime(16)); }
    expect(controls.input).toHaveBeenCalledTimes(previous.input);
    expect(controls.output).toHaveBeenCalledTimes(previous.output);
    expect(screen.getByRole('meter', { name: 'マイクの入力レベル' })).toHaveAttribute('aria-valuenow');
    expect(screen.getAllByRole('button', { name: /クリップ表示を消す/ }).length).toBeGreaterThan(0);
});

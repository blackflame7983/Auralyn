import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { InputGainControl } from '../InputGainControl';

// Slider は Radix の操作を jsdom で再現しにくいため、値の変更だけを渡す部品に置き換える。
vi.mock('@/components/ui/slider', () => ({ Slider: ({ onValueChange }: { onValueChange: (value: number[]) => void }) => <button type="button" onClick={() => onValueChange([150])}>set150</button> }));
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('保存済みのマイク音量を表示し、変更を保存・反映して他の表示へ知らせる', async () => {
    localStorage.setItem('vst_host_input_gain', '80');
    const set = vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined);
    const events: number[] = [];
    window.addEventListener('input-gain-sync', event => events.push((event as CustomEvent<number>).detail));
    render(<InputGainControl />);
    // 読み上げの名前にも、画面に出ている今の値を含める。
    const trigger = screen.getByRole('button', { name: 'マイク音量 80%' });
    act(() => trigger.click());
    act(() => screen.getByRole('button', { name: 'set150' }).click());
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(set).toHaveBeenCalledWith(1.5);
    expect(localStorage.getItem('vst_host_input_gain')).toBe('150');
    expect(events).toEqual([150]);
});

it('大型メーターなど外部からの同期では、値を反映しても通知を返さない', async () => {
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined);
    render(<InputGainControl />);
    const events: number[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<number>).detail);
    act(() => { window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: 120 })); });
    window.addEventListener('input-gain-sync', listener);
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(screen.getByRole('button', { name: 'マイク音量 120%' })).toBeInTheDocument();
    expect(events).toEqual([]);
    window.removeEventListener('input-gain-sync', listener);
});

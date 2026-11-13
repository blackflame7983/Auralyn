import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { SoundFlow } from '../SoundFlow';

const meter = vi.hoisted(() => ({ state: 'stopped' as MeterReading['state'], levels: [0, 0], peak: [0, 0] }));
vi.mock('../../LevelMeter/MeterContext', () => ({
    useSharedMeter: () => ({ levels: meter.levels, peak: meter.peak, clipped: false, state: meter.state, resetClip: () => {} }),
}));

afterEach(() => {
    cleanup();
    meter.state = 'stopped';
    meter.levels = [0, 0];
    meter.peak = [0, 0];
    vi.unstubAllGlobals();
});

function matchMedia(matches: boolean) {
    vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

it('停止中は時間の流れを描かず、凡例だけを残す', () => {
    matchMedia(false);
    render(<SoundFlow running={false} music={false} />);
    const graph = screen.getByRole('img', { name: '加工前と加工後の音量' });
    expect(graph).toHaveAttribute('data-flow', 'idle');
    expect(screen.getByRole('region', { name: '声の流れ' })).toHaveTextContent('加工前');
    expect(screen.getByRole('region', { name: '声の流れ' })).toHaveTextContent('加工後');
});

it('稼働中は時間の流れを描き、動きを減らす設定では静止する', () => {
    meter.state = 'live';
    meter.levels = [0.2, 0.2];
    matchMedia(false);
    const view = render(<SoundFlow running music={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'time');
    matchMedia(true);
    view.rerender(<SoundFlow running music={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'still');
});

it('画面が隠れている間は流れを描かない', () => {
    meter.state = 'live';
    meter.levels = [0.2, 0.2];
    matchMedia(false);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    render(<SoundFlow running music={false} />);
    expect(screen.getByRole('img')).not.toHaveAttribute('data-flow', 'time');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

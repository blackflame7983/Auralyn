import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { SafetyOutput } from '../SafetyLevels';

const meter = vi.hoisted(() => ({ state: 'live' as MeterReading['state'], levels: [0.1, 0.1], peak: [0.1, 0.1] }));
vi.mock('../../features/LevelMeter/MeterContext', () => ({
    useSharedMeter: () => ({ levels: meter.levels, peak: meter.peak, clipped: false, state: meter.state, resetClip: () => {} }),
}));
vi.mock('../../features/Home/InputGainControl', () => ({ InputGainControl: () => null }));

afterEach(() => { cleanup(); });

it('出力のミュートは見えている名前で押せ、押した位置を確認先へ渡す', () => {
    const onCheckOutput = vi.fn();
    render(<SafetyOutput running name="Speakers" muted onCheckOutput={onCheckOutput} />);
    const chip = screen.getByRole('button', { name: '出力ミュート・音量ゼロ' });
    expect(chip).toHaveAttribute('title', 'ミュート・出力音量を確認');
    fireEvent.click(chip);
    expect(onCheckOutput).toHaveBeenCalledWith(chip);
});

it('稼働中の一言と dBFS はピーク保持で出し、停止中は一言を出さない', () => {
    meter.peak = [1, 1];
    meter.levels = [0.01, 0.01];
    const view = render(<SafetyOutput running name="Speakers" muted={false} />);
    expect(screen.getByText('大きすぎ')).toBeInTheDocument();
    expect(screen.getByLabelText('出力のピーク')).toHaveTextContent('0.0 dBFS');
    meter.state = 'stopped';
    meter.peak = [0, 0];
    view.rerender(<SafetyOutput running={false} name="Speakers" muted={false} />);
    expect(screen.queryByText('大きすぎ')).not.toBeInTheDocument();
    expect(screen.queryByText('適正')).not.toBeInTheDocument();
    expect(screen.queryByText('小さめ')).not.toBeInTheDocument();
});

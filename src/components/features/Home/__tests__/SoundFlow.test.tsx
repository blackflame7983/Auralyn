import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { SoundFlow, flowIdleState } from '../SoundFlow';

const meter = vi.hoisted(() => ({
    state: 'stopped' as MeterReading['state'],
    input: undefined as MeterReading['state'] | undefined,
    output: undefined as MeterReading['state'] | undefined,
    levels: [0, 0],
    peak: [0, 0],
}));
vi.mock('../../LevelMeter/MeterContext', () => ({
    useSharedMeter: (_running: boolean, type: 'input' | 'output') => ({
        levels: meter.levels,
        peak: meter.peak,
        clipped: false,
        state: (type === 'input' ? meter.input : meter.output) ?? meter.state,
        resetClip: () => {},
    }),
}));

afterEach(() => {
    cleanup();
    meter.state = 'stopped';
    meter.input = undefined;
    meter.output = undefined;
    meter.levels = [0, 0];
    meter.peak = [0, 0];
    vi.unstubAllGlobals();
});

function matchMedia(matches: boolean) {
    vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

it('停止中は時間の流れを描かず、波形の場所に停止を文字で出し、凡例は残す', () => {
    // 段階4で、live 以外は波形を描かず meterStatusLabel の文言を出す。凡例は残す。
    matchMedia(false);
    render(<SoundFlow running={false} music={false} />);
    const graph = screen.getByRole('img', { name: '加工前と加工後の音量' });
    expect(graph).toHaveAttribute('data-flow', 'idle');
    const region = screen.getByRole('region', { name: '声の流れ' });
    expect(region).toHaveTextContent('加工前');
    expect(region).toHaveTextContent('加工後');
    expect(region.querySelector('[data-flow-status]')).toHaveAttribute('data-flow-status', 'stopped');
    expect(region.querySelector('[data-flow-status]')).toHaveTextContent('音声停止中');
});

it.each([
    ['silent', '無音'],
    ['waiting', 'レベル未受信'],
    ['stale', 'レベル未受信'],
] as const)('入力が %s のときは波形を描かず、その状態の言葉を出す', (state, label) => {
    matchMedia(false);
    meter.state = state;
    render(<SoundFlow running music={false} />);
    const region = screen.getByRole('region', { name: '声の流れ' });
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'idle');
    expect(region.querySelector('[data-flow-status]')).toHaveAttribute('data-flow-status', state);
    expect(region.querySelector('[data-flow-status]')).toHaveTextContent(label);
    expect(region.querySelector('[data-flow-status]')).not.toHaveClass('animate-pulse');
});

it('live のときだけ波形を描き、状態の文字は出さない', () => {
    matchMedia(false);
    meter.input = 'silent';
    meter.output = 'live';
    meter.levels = [0.2, 0.2];
    render(<SoundFlow running music={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'time');
    expect(screen.getByRole('region', { name: '声の流れ' }).querySelector('[data-flow-status]')).toBeNull();
});

it('流れの状態は、動いているときの入力を優先し、停止中は停止にする', () => {
    expect(flowIdleState(true, 'live', 'silent')).toBeNull();
    expect(flowIdleState(true, 'silent', 'live')).toBeNull();
    expect(flowIdleState(true, 'silent', 'waiting')).toBe('silent');
    expect(flowIdleState(true, 'stale', 'silent')).toBe('stale');
    expect(flowIdleState(false, 'live', 'live')).toBe('stopped');
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

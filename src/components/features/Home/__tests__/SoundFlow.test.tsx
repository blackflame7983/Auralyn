import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { SoundFlow, drawFlowWave, flowBeforeLineAlpha, flowBeforeLineWidth, flowHalfHeight, flowIdleState } from '../SoundFlow';

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

it('波形の高さはメーターと同じ −60〜0 dBFS の目盛りにする', () => {
    // #570: pow(level, 2.2) をやめ、−30 dBFS は中央の 0.92 倍の半分。
    const mid = 36;
    expect(flowHalfHeight(1, mid)).toBe(mid * 0.92);
    expect(flowHalfHeight(Math.pow(10, -30 / 20), mid)).toBe(mid * 0.46);
    expect(flowHalfHeight(Math.pow(10, -6 / 20), mid)).toBeCloseTo(mid * 0.92 * 0.9);
    expect(flowHalfHeight(0, mid)).toBe(0);
    expect(flowHalfHeight(Number.NaN, mid)).toBe(0);
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

function recordingContext() {
    const ops: { op: string; x?: number; y?: number; strokeStyle?: string; lineWidth?: number; fillStyle?: unknown }[] = [];
    const ctx = {
        fillStyle: '' as string | CanvasGradient,
        strokeStyle: '' as string | CanvasGradient,
        lineWidth: 1,
        beginPath() { ops.push({ op: 'beginPath' }); },
        moveTo(x: number, y: number) { ops.push({ op: 'moveTo', x, y }); },
        lineTo(x: number, y: number) { ops.push({ op: 'lineTo', x, y }); },
        closePath() { ops.push({ op: 'closePath' }); },
        fill() { ops.push({ op: 'fill', fillStyle: this.fillStyle }); },
        stroke() { ops.push({ op: 'stroke', strokeStyle: String(this.strokeStyle), lineWidth: this.lineWidth }); },
        fillRect() { ops.push({ op: 'fillRect' }); },
        createLinearGradient() { return { addColorStop() {} }; },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

const waveColors = {
    before: `hsl(220 20% 94% / ${flowBeforeLineAlpha})`,
    teal: 'hsl(176 70% 48% / 0.95)',
    green: 'hsl(152 60% 45% / 0.95)',
    playhead: 'hsl(220 20% 94%)',
};

function strokedPaths(ops: { op: string; x?: number; y?: number; strokeStyle?: string; lineWidth?: number }[]) {
    const paths: { points: { op: string; x?: number; y?: number }[]; lineWidth?: number; strokeStyle?: string }[] = [];
    let points: { op: string; x?: number; y?: number }[] = [];
    for (const op of ops) {
        if (op.op === 'beginPath') points = [];
        else if (op.op === 'moveTo' || op.op === 'lineTo') points.push({ op: op.op, x: op.x, y: op.y });
        else if (op.op === 'stroke') paths.push({ points, lineWidth: op.lineWidth, strokeStyle: op.strokeStyle });
    }
    return paths;
}

it('加工後は塗り、加工前は塗りの上に上下の線で描く', () => {
    const { ctx, ops } = recordingContext();
    const samples = [{ inn: 0.1, out: 0.5 }, { inn: 0.2, out: 0.8 }];
    drawFlowWave(ctx, samples, 100, 40, waveColors, false);
    const fillAt = ops.findIndex(op => op.op === 'fill');
    const strokeAt = ops.findIndex(op => op.op === 'stroke');
    expect(fillAt).toBeGreaterThan(-1);
    expect(strokeAt).toBeGreaterThan(fillAt);
    expect(ops.filter(op => op.op === 'fill')).toHaveLength(1);
    expect(ops.filter(op => op.op === 'stroke')).toHaveLength(2);
    expect(ops.filter(op => op.op === 'closePath')).toHaveLength(1);
    expect(ops.find(op => op.op === 'fill')?.fillStyle).not.toEqual(expect.any(String));
    for (const stroke of ops.filter(op => op.op === 'stroke')) {
        expect(stroke.lineWidth).toBe(flowBeforeLineWidth);
        expect(stroke.strokeStyle).toBe(waveColors.before);
    }
    const mid = 20;
    expect(ops.find(op => op.op === 'moveTo')).toMatchObject({ y: mid - flowHalfHeight(samples[0].out, mid) });
    const [upper, lower] = strokedPaths(ops);
    expect(upper.points.map(point => point.y)).toEqual([
        mid - flowHalfHeight(samples[0].inn, mid),
        mid - flowHalfHeight(samples[1].inn, mid),
    ]);
    expect(lower.points.map(point => point.y)).toEqual([
        mid + flowHalfHeight(samples[0].inn, mid),
        mid + flowHalfHeight(samples[1].inn, mid),
    ]);
    expect(ops.some(op => op.op === 'fillRect')).toBe(false);
});

it('加工後が大きくても小さくても、加工前の線は残る', () => {
    for (const samples of [[{ inn: 0.05, out: 0.9 }], [{ inn: 0.9, out: 0.05 }]]) {
        const { ctx, ops } = recordingContext();
        drawFlowWave(ctx, samples, 80, 40, waveColors, true);
        expect(ops.filter(op => op.op === 'stroke')).toHaveLength(2);
        expect(ops.filter(op => op.op === 'fill')).toHaveLength(1);
        expect(ops.some(op => op.op === 'fillRect')).toBe(true);
    }
});

it('サンプルが1つのときは加工前を横の直線2本で描く', () => {
    // 動きを減らす設定は現在値1つだけを渡す。そのとき加工前は幅いっぱいの水平線になる。
    const { ctx, ops } = recordingContext();
    const sample = { inn: 0.25, out: 0.25 };
    drawFlowWave(ctx, [sample], 80, 40, waveColors, false);
    const mid = 20;
    const upper = mid - flowHalfHeight(sample.inn, mid);
    const lower = mid + flowHalfHeight(sample.inn, mid);
    expect(strokedPaths(ops).map(path => path.points)).toEqual([
        [{ op: 'moveTo', x: 0, y: upper }, { op: 'lineTo', x: 80, y: upper }],
        [{ op: 'moveTo', x: 0, y: lower }, { op: 'lineTo', x: 80, y: lower }],
    ]);
    // 加工後の塗りは長方形。左下の角まで戻してから閉じ、斜めの辺を作らない。
    const fillPath = ops.slice(0, ops.findIndex(op => op.op === 'closePath')).filter(op => op.op === 'moveTo' || op.op === 'lineTo').map(op => [op.x, op.y]);
    const outTop = mid - flowHalfHeight(sample.out, mid);
    const outBottom = mid + flowHalfHeight(sample.out, mid);
    expect(fillPath).toEqual([[0, outTop], [80, outTop], [80, outBottom], [0, outBottom]]);
});

it('凡例の加工前は線の見本で、加工後は塗りの見本のまま', () => {
    matchMedia(false);
    render(<SoundFlow running={false} music={false} />);
    const before = screen.getByText('加工前', { exact: true }).querySelector('[aria-hidden="true"]')!;
    expect(before.className).toContain(`border-t-[${flowBeforeLineWidth}px]`);
    expect(before.className).toContain(`border-foreground/${Math.round(flowBeforeLineAlpha * 100)}`);
    expect(before.className).toContain('h-0');
    expect(before.className).not.toContain('rounded-full');
    expect(before.className).not.toContain('bg-muted-foreground');
    const after = screen.getByText('加工後', { exact: true }).querySelector('[aria-hidden="true"]')!;
    expect(after.className).toContain('meter-fill-aurora');
    expect(after.className).toContain('rounded-full');
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

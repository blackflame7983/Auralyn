import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { SoundFlow, flowIdleState } from '../SoundFlow';
import { drawFlowWave, flowBeforeLineAlpha, flowBeforeLineWidth, flowHalfHeight } from '../soundFlowDraw';

const meter = vi.hoisted(() => ({
    state: 'stopped' as MeterReading['state'],
    input: undefined as MeterReading['state'] | undefined,
    output: undefined as MeterReading['state'] | undefined,
    levels: [0, 0],
    peak: [0, 0],
}));
// 実際の useMeterLevels と同じく、値が変わらない間は同じ読み取りを返す。毎回新しい参照を返すと、
// 値が変わらないまま設定だけが変わった場合の再描画を、無関係な再描画が隠してしまう。
const readings = vi.hoisted(() => new Map<string, { key: string; reading: unknown }>());
vi.mock('../../LevelMeter/MeterContext', () => ({
    useSharedMeter: (_running: boolean, type: 'input' | 'output') => {
        const state = (type === 'input' ? meter.input : meter.output) ?? meter.state;
        const key = `${state}|${meter.levels.join()}|${meter.peak.join()}`;
        const cached = readings.get(type);
        if (cached?.key === key) return cached.reading as MeterReading;
        const reading = { levels: meter.levels, peak: meter.peak, clipped: false, state, resetClip: () => {} };
        readings.set(type, { key, reading });
        return reading;
    },
}));

afterEach(() => {
    cleanup();
    meter.state = 'stopped';
    meter.input = undefined;
    meter.output = undefined;
    meter.levels = [0, 0];
    meter.peak = [0, 0];
    readings.clear();
    vi.unstubAllGlobals();
});

function matchMedia(matches: boolean) {
    vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

/** 利用者が OS の設定を切り替えたときと同じく、購読している change を呼ぶ。 */
function switchableMatchMedia(initial: boolean) {
    let matches = initial;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({
        get matches() { return matches; },
        addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
        removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    }));
    return (next: boolean) => {
        matches = next;
        act(() => { listeners.forEach(listener => listener()); });
    };
}

it.each(['stopped', 'waiting', 'stale'] as const)('入力が %s のときは声の流れの区画を出さない（#624、#639）', state => {
    matchMedia(false);
    meter.state = state;
    const { container } = render(<SoundFlow running={state !== 'stopped'} music={false} action={<button type="button">音量を測る</button>} />);
    expect(screen.queryByRole('region', { name: '声の流れ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '音量を測る' })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
});

it('一度値が届いたら、受信待ち・更新停止になっても停止まで区画を残す（#644）', () => {
    matchMedia(false);
    meter.state = 'live';
    const view = render(<SoundFlow running music={false} />);
    expect(screen.getByRole('region', { name: '声の流れ' })).toBeInTheDocument();
    for (const state of ['stale', 'waiting', 'live', 'stale'] as const) {
        meter.state = state;
        view.rerender(<SoundFlow running music={false} />);
        expect(screen.getByRole('region', { name: '声の流れ' })).toBeInTheDocument();
    }
    meter.state = 'stopped';
    view.rerender(<SoundFlow running={false} music={false} />);
    expect(screen.queryByRole('region', { name: '声の流れ' })).not.toBeInTheDocument();
    // 停止のあと開き直した直後は、値が届くまで出さない。
    meter.state = 'waiting';
    view.rerender(<SoundFlow running music={false} />);
    expect(screen.queryByRole('region', { name: '声の流れ' })).not.toBeInTheDocument();
});

it('無音のときは平らな波形と凡例を描き、無音の言葉は出さない（#624）', () => {
    matchMedia(false);
    meter.state = 'silent';
    render(<SoundFlow running music={false} />);
    const region = screen.getByRole('region', { name: '声の流れ' });
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'flat');
    expect(region).not.toHaveTextContent('無音');
    expect(region.querySelector('[data-flow-status]')).toBeNull();
    expect(region.querySelector('[data-flow-legend]')).toHaveAttribute('data-flow-legend', 'shown');
    expect(region).toHaveTextContent('加工前');
    expect(region).toHaveTextContent('加工後');
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
    matchMedia(true);
    render(<SoundFlow running music={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'still');
});

it('音量が変わらないまま動きを減らす設定に変わっても、すぐ静止する', () => {
    meter.state = 'live';
    meter.levels = [0.2, 0.2];
    const setReduced = switchableMatchMedia(false);
    render(<SoundFlow running music={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'time');
    setReduced(true);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'still');
    setReduced(false);
    expect(screen.getByRole('img')).toHaveAttribute('data-flow', 'time');
});

it('更新が止まって最後の波形を保っているあいだに設定が変わっても、最後の値で静止する', () => {
    meter.state = 'live';
    meter.levels = [0.2, 0.2];
    const setReduced = switchableMatchMedia(false);
    const view = render(<SoundFlow running music={false} />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    expect(canvas).toHaveAttribute('data-flow', 'time');
    meter.state = 'stale';
    view.rerender(<SoundFlow running music={false} />);
    expect(canvas).toHaveAttribute('data-flow', 'time');
    const { ctx, ops } = recordingContext();
    Object.assign(ctx, { setTransform: vi.fn(), clearRect: vi.fn() });
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx);
    setReduced(true);
    expect(canvas).toHaveAttribute('data-flow', 'still');
    // 最後の値1つだけで描き直す。時間の流れの再生ヘッドは出さない。
    expect(ops.filter(op => op.op === 'fill')).toHaveLength(1);
    expect(ops.some(op => op.op === 'fillRect')).toBe(false);
    expect(screen.getByRole('region', { name: '声の流れ' })).toBeInTheDocument();
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
    meter.state = 'live';
    render(<SoundFlow running music={false} />);
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

import { useEffect, useRef } from 'react';
import { meterPosition } from '@/lib/model/meter';

interface Sample { inn: number; out: number }

const HISTORY = 96;
/** 加工前の包絡線。凡例の `border-t-[1.5px] border-foreground/70` と揃える（#582）。 */
export const flowBeforeLineWidth = 1.5;
export const flowBeforeLineAlpha = 0.7;

/** 波形の片側の高さ。目盛りはメーターと同じ −60〜0 dBFS の等間隔。 */
export function flowHalfHeight(level: number, mid: number): number {
    return meterPosition(level) * mid * 0.92;
}

/** 共有メーターの読み取りが変わったときだけ直近の値を足す。タイマーは作らない。 */
export function pushFlowSample(history: Sample[], sample: Sample, flowing: boolean): Sample[] {
    if (!flowing) return history.length === 0 ? history : [];
    const next = history.length >= HISTORY ? history.slice(history.length - HISTORY + 1) : history.slice();
    next.push(sample);
    return next;
}

/**
 * 加工後をオーロラ色で塗り、その上に加工前の上下の包絡を線で重ねる。
 * 加工後が大きくても、加工前の形が残る。差が無いときは線が塗りの縁に重なる。
 * サンプルが1つのときは、加工前を横の直線2本にする。
 */
export function drawFlowWave(
    ctx: CanvasRenderingContext2D,
    samples: readonly Sample[],
    width: number,
    height: number,
    colors: { before: string; teal: string; green: string; playhead: string },
    flowing: boolean,
) {
    if (samples.length === 0 || width <= 0 || height <= 0) return;
    const mid = height / 2;
    const n = samples.length;
    const step = n <= 1 ? width : width / (n - 1);
    const yAt = (level: number, sign: -1 | 1) => mid + sign * flowHalfHeight(level, mid);
    ctx.beginPath();
    ctx.moveTo(0, yAt(samples[0].out, -1));
    if (n === 1) ctx.lineTo(width, yAt(samples[0].out, -1));
    else for (let i = 1; i < n; i += 1) ctx.lineTo(i * step, yAt(samples[i].out, -1));
    if (n === 1) { ctx.lineTo(width, yAt(samples[0].out, 1)); ctx.lineTo(0, yAt(samples[0].out, 1)); }
    else for (let i = n - 1; i >= 0; i -= 1) ctx.lineTo(i * step, yAt(samples[i].out, 1));
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, colors.teal);
    gradient.addColorStop(0.5, colors.green);
    gradient.addColorStop(1, colors.teal);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = colors.before;
    ctx.lineWidth = flowBeforeLineWidth;
    const envelope = (sign: -1 | 1) => {
        ctx.beginPath();
        ctx.moveTo(0, yAt(samples[0].inn, sign));
        if (n === 1) ctx.lineTo(width, yAt(samples[0].inn, sign));
        else for (let i = 1; i < n; i += 1) ctx.lineTo(i * step, yAt(samples[i].inn, sign));
        ctx.stroke();
    };
    envelope(-1);
    envelope(1);
    if (flowing) {
        ctx.fillStyle = colors.playhead;
        ctx.fillRect(width - 1, 0, 1, height);
    }
}

function paint(canvas: HTMLCanvasElement, samples: Sample[], flowing: boolean) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (samples.length === 0) return;
    const style = getComputedStyle(canvas);
    const token = (name: string) => style.getPropertyValue(name).trim();
    drawFlowWave(ctx, samples, w, h, {
        before: `hsl(${token('--foreground')} / ${flowBeforeLineAlpha})`,
        teal: `hsl(${token('--aurora-teal')} / 0.95)`,
        green: `hsl(${token('--aurora-green')} / 0.95)`,
        playhead: `hsl(${token('--foreground')})`,
    }, flowing);
}

/** 声の流れのキャンバス。購読は共有メーターのまま、描き直しだけを部品の外に置く。 */
export function useSoundFlowCanvas(input: { levels: readonly number[] }, output: { levels: readonly number[] }, live: boolean, receiving: boolean, shown: boolean) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const history = useRef<Sample[]>([]);
    const lastPaint = useRef<{ samples: Sample[]; flowing: boolean }>({ samples: [], flowing: false });
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!shown || !canvas) {
            history.current = [];
            return;
        }
        // 受信待ち・更新停止のあいだは、最後に描いた波形のまま止める。
        if (!receiving) return;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        if (document.hidden) return;
        const sample = {
            inn: Math.max(0, ...input.levels),
            out: Math.max(0, ...output.levels),
        };
        // 動きを減らす設定と、無音では時間の流れを描かない。無音は現在の値で横に伸ばす。
        const flowing = live && !reduced;
        history.current = flowing ? pushFlowSample(history.current, sample, true) : [];
        const samples = flowing ? history.current : [sample];
        lastPaint.current = { samples, flowing };
        paint(canvas, samples, flowing);
        canvas.dataset.flow = flowing ? 'time' : live ? 'still' : 'flat';
    }, [input, output, live, shown, receiving]);
    // 見えているときだけ、大きさが変わった最後の値で描き直す。
    useEffect(() => {
        if (!shown) return;
        const canvas = canvasRef.current;
        if (!canvas || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (document.hidden) return;
            paint(canvas, lastPaint.current.samples, lastPaint.current.flowing);
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [shown]);
    return canvasRef;
}

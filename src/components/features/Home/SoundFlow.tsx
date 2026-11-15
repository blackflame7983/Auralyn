import { useEffect, useRef, type ReactNode } from 'react';
import { meterPosition, meterStatusLabel, type MeterState } from '@/hooks/useMeterLevels';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';

/**
 * 波形を描かないときの状態。
 * live のときだけ波形を描く。止まっているときは停止、動いているときは入力の状態を文字にする。
 * stale と waiting は、meterStatusLabel がどちらも「レベル未受信」にする。
 */
export function flowIdleState(running: boolean, input: MeterState, output: MeterState): MeterState | null {
    if (running && (input === 'live' || output === 'live')) return null;
    return running ? input : 'stopped';
}

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
    // 加工後の塗りは、これまでの閉じた形のままにする。
    ctx.beginPath();
    ctx.moveTo(0, yAt(samples[0].out, -1));
    if (n === 1) ctx.lineTo(width, yAt(samples[0].out, -1));
    else for (let i = 1; i < n; i += 1) ctx.lineTo(i * step, yAt(samples[i].out, -1));
    // 1つのときは、右下から左下へ戻して長方形にする。斜めの辺を作らない。
    if (n === 1) { ctx.lineTo(width, yAt(samples[0].out, 1)); ctx.lineTo(0, yAt(samples[0].out, 1)); }
    else for (let i = n - 1; i >= 0; i -= 1) ctx.lineTo(i * step, yAt(samples[i].out, 1));
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, colors.teal);
    gradient.addColorStop(0.5, colors.green);
    gradient.addColorStop(1, colors.teal);
    ctx.fillStyle = gradient;
    ctx.fill();
    // 加工前は塗らない。上下の包絡だけを、塗りの上に線で重ねる。
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

/** 加工前と加工後の音量を重ねる帯。共有メーター以外の購読やタイマーは持たない。 */
export function SoundFlow({ running, music, action }: { running: boolean; music: boolean; action?: ReactNode }) {
    const t = useMessages();
    const input = useSharedMeter(running, 'input');
    const output = useSharedMeter(running, 'output');
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const history = useRef<Sample[]>([]);
    const lastPaint = useRef<{ samples: Sample[]; flowing: boolean }>({ samples: [], flowing: false });
    const idle = flowIdleState(running, input.state, output.state);
    const live = idle === null;
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        if (document.hidden) return;
        const sample = {
            inn: live ? Math.max(0, ...input.levels) : 0,
            out: live ? Math.max(0, ...output.levels) : 0,
        };
        // 動きを減らす設定と、停止・未稼働では時間の流れを描かない。
        const flowing = live && !reduced;
        history.current = flowing ? pushFlowSample(history.current, sample, true) : [];
        const shown = !live ? [] : flowing ? history.current : [sample];
        lastPaint.current = { samples: shown, flowing };
        paint(canvas, shown, flowing);
        canvas.dataset.flow = !live ? 'idle' : flowing ? 'time' : 'still';
    }, [input, output, live]);
    // 大きさが変わったときだけ、最後の値で描き直す。監視は一度だけ作る。
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (document.hidden) return;
            paint(canvas, lastPaint.current.samples, lastPaint.current.flowing);
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);
    return <section aria-label={t(music ? 'home.flowMusic' : 'home.flowVoice')} data-flow-live={live || undefined}
        className="mb-3 rounded-card bg-card px-4 py-2">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-ui-control font-medium">{t(music ? 'home.flowMusic' : 'home.flowVoice')}</h2>
            {action}
        </div>
        {/* 全体の高さは 72px のまま。波形は凡例の上の段だけに描き、大きな音でも凡例に重ねない（#570）。 */}
        <div className="flex h-[72px] flex-col">
            <div className="relative min-h-0 flex-1">
                <canvas ref={canvasRef} role="img" aria-label={t('home.flowGraph')} className="h-full w-full" />
                {/* 点滅は付けない。動きを減らす設定でも、状態は同じ文字のまま読める。 */}
                {idle && <p data-flow-status={idle} className="pointer-events-none absolute inset-x-2 inset-y-0 flex items-center justify-center text-center text-ui-control text-foreground">{t(meterStatusLabel(idle))}</p>}
            </div>
            <div className="pointer-events-none flex h-5 shrink-0 items-center gap-3 text-ui-support text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0 w-4 border-t-[1.5px] border-foreground/70" />{t('home.flowBefore')}</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="meter-fill-aurora inline-block h-2 w-4 rounded-full" />{t('home.flowAfter')}</span>
            </div>
        </div>
    </section>;
}

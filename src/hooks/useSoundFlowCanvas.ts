import { useEffect, useRef, type RefObject } from 'react';
import { paintFlow, pushFlowSample, type Sample } from '@/components/features/Home/soundFlowDraw';
import { useAppHidden } from '@/hooks/useAppHidden';
import { useMatchMedia } from '@/hooks/useMatchMedia';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { isAppHidden } from '@/lib/appVisibility';

interface SoundFlowCanvas {
    canvasRef: RefObject<HTMLCanvasElement | null>;
    input: MeterReading;
    output: MeterReading;
    /** 入力か出力が live。時間の流れを描ける。 */
    live: boolean;
    /** 値を受け取っている（live か無音）。 */
    receiving: boolean;
    /** 区画を出している。 */
    shown: boolean;
}

/**
 * 音の流れの帯の canvas を、共有メーターの読み取りが変わったときだけ描く。
 * 音声メーターの購読・IPC・タイマーは足さない。動きを減らす設定と表示の切り替えは、既存の通知で受ける。
 * 動きを減らす設定が変わったらすぐ静止の描画へ切り替える。受信待ち・更新停止のあいだに変わったときは、最後の値で静止して描き直す。
 * 隠れているあいだは描かない。表示に戻ったときに、最新の設定と保持しているサンプルから描き直す。
 */
export function useSoundFlowCanvas({ canvasRef, input, output, live, receiving, shown }: SoundFlowCanvas): void {
    const reduced = useMatchMedia('(prefers-reduced-motion: reduce)');
    const hidden = useAppHidden();
    const history = useRef<Sample[]>([]);
    const lastPaint = useRef<{ samples: Sample[]; flowing: boolean }>({ samples: [], flowing: false });
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!shown || !canvas) {
            history.current = [];
            return;
        }
        if (!receiving) {
            // 受信待ち・更新停止のあいだは、最後に描いた波形のまま止める。
            // 動きを減らす設定へ変わったときだけ、最後の値で静止して描き直す。
            const last = lastPaint.current;
            if (reduced && last.flowing) {
                const samples = last.samples.slice(-1);
                lastPaint.current = { samples, flowing: false };
                paintFlow(canvas, samples, false);
                canvas.dataset.flow = 'still';
            }
            return;
        }
        if (hidden) return;
        const sample = {
            inn: Math.max(0, ...input.levels),
            out: Math.max(0, ...output.levels),
        };
        // 動きを減らす設定と、無音では時間の流れを描かない。無音は現在の値で横に伸ばす。
        const flowing = live && !reduced;
        history.current = flowing ? pushFlowSample(history.current, sample, true) : [];
        const samples = flowing ? history.current : [sample];
        lastPaint.current = { samples, flowing };
        paintFlow(canvas, samples, flowing);
        canvas.dataset.flow = flowing ? 'time' : live ? 'still' : 'flat';
    }, [canvasRef, input, output, live, shown, receiving, reduced, hidden]);
    // 見えているときだけ、大きさが変わった最後の値で描き直す。
    useEffect(() => {
        if (!shown) return;
        const canvas = canvasRef.current;
        if (!canvas || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (isAppHidden()) return;
            paintFlow(canvas, lastPaint.current.samples, lastPaint.current.flowing);
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [canvasRef, shown]);
}

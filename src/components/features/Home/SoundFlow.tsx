import { useRef, type ReactNode } from 'react';
import { useSoundFlowCanvas } from '@/hooks/useSoundFlowCanvas';
import type { MeterState } from '@/hooks/useMeterLevels';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';

/**
 * 波形を描くか、区画を出さないかを決める状態。
 * 入力か出力が live なら null（波形）。動いていなければ停止。動いていれば入力の状態。
 * 区画の表示継続はSoundFlowが受信履歴から決める。waiting・staleでは最後の波形を保持する（#644）。
 */
export function flowIdleState(running: boolean, input: MeterState, output: MeterState): MeterState | null {
    if (running && (input === 'live' || output === 'live')) return null;
    return running ? input : 'stopped';
}

/** 加工前と加工後の音量を重ねる帯。音声メーターの購読・IPC・タイマーは足さない。 */
export function SoundFlow({ running, music, action }: { running: boolean; music: boolean; action?: ReactNode }) {
    const t = useMessages();
    const input = useSharedMeter(running, 'input');
    const output = useSharedMeter(running, 'output');
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const idle = flowIdleState(running, input.state, output.state);
    const live = idle === null;
    const receiving = live || idle === 'silent';
    // 無音は値が届いているので平らな波形を描く。停止中と、開始してからまだ値が届いていないあいだは
    // 区画ごと出さない（#624、#639）。一度届いたら、受信待ち・更新停止になっても停止まで区画を残し、
    // 最後の波形を止めて見せる。値の届き方が途切れるたびに区画が出入りして、ホームが跳ね続けるのを防ぐ（#644）。
    const received = useRef(false);
    received.current = running && (received.current || receiving);
    const shown = received.current;
    useSoundFlowCanvas({ canvasRef, input, output, live, receiving, shown });
    if (!shown) return null;
    return <section aria-label={t(music ? 'home.flowMusic' : 'home.flowVoice')} data-flow-live={live || undefined}
        className="sound-flow mb-3 rounded-card bg-card px-4 py-2">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h2 className="text-ui-control font-medium">{t(music ? 'home.flowMusic' : 'home.flowVoice')}</h2>
                <p className="text-ui-support text-muted-foreground">{t('home.flowCompare')}</p>
            </div>
            {action}
        </div>
        {/* 全体の高さは 72px のまま。波形は凡例の上の段だけに描き、大きな音でも凡例に重ねない（#570）。
            無音の言葉はいまの状態のメーターに任せ、ここでは平らな波形と凡例だけを出す（#624、#639）。 */}
        <div className="sound-flow-body flex h-[72px] flex-col">
            <div className="relative min-h-0 flex-1">
                <canvas ref={canvasRef} role="img" aria-label={t('home.flowGraph')} className="h-full w-full" />
            </div>
            <div data-flow-legend="shown" className="pointer-events-none flex h-5 shrink-0 items-center gap-3 text-ui-support text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0 w-4 border-t-[1.5px] border-foreground/70" />{t('home.flowBefore')}</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="meter-fill-aurora inline-block h-2 w-4 rounded-full" />{t('home.flowAfter')}</span>
            </div>
        </div>
    </section>;
}

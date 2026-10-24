import type { MessageKey } from '@/i18n/messages';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { QualityAdvice, QualityReport, QualityVerdict, VoiceCheckSource } from '../../../api/audio';

export function formatMs(ms: number): string {
    const sec = Math.floor(ms / 1000);
    const rem = Math.floor((ms % 1000) / 100);
    return `${sec}.${rem}s`;
}
export const VERDICT_LABELS: Record<QualityVerdict, MessageKey> = {
    good: 'voice.copy.105',
    warn: 'voice.copy.106',
    bad: 'voice.copy.107',
};
export const VERDICT_STYLES: Record<QualityVerdict, string> = {
    good: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border-emerald-500/40',
    warn: 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/40',
    bad: 'bg-red-500/20 text-red-600 dark:text-red-300 border-red-500/40',
};
export function formatAdvice(advice: QualityAdvice, t: ReturnType<typeof useMessages>): string {
    const p = advice.params;
    switch (advice.messageKey) {
        case 'clip_detected':
            return t('voice.copy.108', { arg0: p.count, arg1: p.recommendedGainReductionDb });
        case 'dropout_detected':
            return t('voice.copy.109', { arg0: p.count, arg1: p.currentBufferSize, arg2: p.recommendedBufferSize });
        case 'high_freq_attenuation':
            return t('voice.copy.110', { arg0: p.bandHz, arg1: Math.abs(Number(p.deltaDb)).toFixed(1) });
        case 'noise_floor_high':
            return t('voice.copy.111', { arg0: p.noiseFloorDb });
        case 'noise_suppression_weak':
            return t('voice.copy.112', { arg0: p.snrImprovementDb });
        case 'loudness_low':
            return t('voice.copy.113', { arg0: p.rmsDb });
        case 'loudness_high':
            return t('voice.copy.114', { arg0: p.rmsDb, arg1: p.peakDb });
        default:
            return advice.messageKey;
    }
}
export function adviceSettingsTarget(messageKey: string): 'audio' | 'sound' | null {
    if (['high_freq_attenuation', 'noise_floor_high', 'noise_suppression_weak'].includes(messageKey)) return 'sound';
    if (['clip_detected', 'dropout_detected', 'loudness_low', 'loudness_high'].includes(messageKey)) return 'audio';
    return null;
}
export function adviceSeverityClass(severity: string): string {
    switch (severity) {
        case 'bad':
            return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
        case 'warn':
            return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
        default:
            return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    }
}
export function BandDeltaChart({ bands }: { bands: QualityReport['bandDeltaDb'] }) {
    const t = useMessages();
    if (bands.length === 0) return null;
    const maxAbs = Math.max(12, ...bands.map((b) => Math.abs(b.deltaDb)));
    return (
        <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('voice.copy.115')}</p>
            <div className="flex items-end gap-1 h-20">
                {bands.map((band) => {
                    const h = (Math.abs(band.deltaDb) / maxAbs) * 100;
                    const isNeg = band.deltaDb < 0;
                    return (
                        <div key={band.bandHz} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
                            <div className="w-full h-16 flex items-end justify-center">
                                <div
                                    className={cn(
                                        'w-full max-w-[28px] rounded-sm transition-all',
                                        isNeg ? 'bg-amber-500/70' : 'bg-sky-500/70'
                                    )}
                                    style={{ height: `${Math.max(4, h)}%` }}
                                    title={`${band.bandHz} Hz: ${band.deltaDb.toFixed(1)} dB`}
                                />
                            </div>
                            <span className="text-xs text-muted-foreground truncate w-full text-center">
                                {band.bandHz >= 1000 ? `${band.bandHz / 1000}k` : band.bandHz}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
export function WaveformCanvas({
    rawPeaks,
    processedPeaks,
    positionMs,
    durationMs,
    activeSource,
    markersMs,
}: {
    rawPeaks: number[];
    processedPeaks: number[];
    positionMs: number;
    durationMs: number;
    activeSource: VoiceCheckSource;
    markersMs: number[];
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
        ctx.fillRect(0, 0, w, h);
        const mid = h / 2;
        const drawEnvelope = (peaks: number[], color: string, alpha: number) => {
            if (peaks.length === 0) return;
            ctx.strokeStyle = color;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = 1.5 * dpr;
            ctx.beginPath();
            peaks.forEach((peak, i) => {
                const x = (i / Math.max(1, peaks.length - 1)) * w;
                const amp = Math.min(1, peak) * (h * 0.42);
                if (i === 0) ctx.moveTo(x, mid - amp);
                else ctx.lineTo(x, mid - amp);
            });
            for (let i = peaks.length - 1; i >= 0; i--) {
                const x = (i / Math.max(1, peaks.length - 1)) * w;
                const amp = Math.min(1, peaks[i]) * (h * 0.42);
                ctx.lineTo(x, mid + amp);
            }
            ctx.closePath();
            ctx.fillStyle = color.replace('1)', `${alpha * 0.35})`);
            ctx.fill();
            ctx.stroke();
            ctx.globalAlpha = 1;
        };
        drawEnvelope(rawPeaks, 'rgba(52, 211, 153, 1)', activeSource === 'raw' ? 1 : 0.45);
        drawEnvelope(processedPeaks, 'rgba(56, 189, 248, 1)', activeSource === 'processed' ? 1 : 0.45);
        if (durationMs > 0 && markersMs.length > 0) {
            markersMs.forEach((ms) => {
                const posX = (ms / durationMs) * w;
                ctx.strokeStyle = 'rgba(248, 113, 113, 0.85)';
                ctx.lineWidth = 1.5 * dpr;
                ctx.setLineDash([4 * dpr, 3 * dpr]);
                ctx.beginPath();
                ctx.moveTo(posX, 0);
                ctx.lineTo(posX, h);
                ctx.stroke();
                ctx.setLineDash([]);
            });
        }
        if (durationMs > 0) {
            const posX = (positionMs / durationMs) * w;
            ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.moveTo(posX, 0);
            ctx.lineTo(posX, h);
            ctx.stroke();
        }
    }, [rawPeaks, processedPeaks, positionMs, durationMs, activeSource, markersMs]);
    return (
        <canvas
            ref={canvasRef}
            className="w-full h-28 rounded-lg border border-border bg-slate-950/50"
        />
    );
}

import React from 'react';
import { MdFlashOn, MdFlashOff } from 'react-icons/md';

interface DeviceStatusProps {
    host: string;
    sampleRate?: number;
    bufferSize?: number;
    isRunning: boolean;
    onClick: () => void;
}

// Calculate estimated round-trip latency in ms
const calculateLatency = (sampleRate: number, bufferSize: number, isAsio: boolean): number => {
    // Round-trip = 2 buffers (input + output)
    const baseLatency = (bufferSize * 2 / sampleRate) * 1000;
    // WASAPI Shared Mode typically adds substantial OS mixing overhead (~20ms)
    // ASIO is direct, so we assume near-zero driver overhead beyond buffers.
    const overhead = isAsio ? 0 : 20;
    return baseLatency + overhead;
};

// Quality assessment
const getLatencyQuality = (latencyMs: number): {
    label: string;
    textClass: string;
    badgeClass: string;
    icon: 'good' | 'bad';
} => {
    if (latencyMs <= 10) {
        return {
            label: '非常に低遅延',
            textClass: 'text-emerald-600 dark:text-emerald-400',
            badgeClass: 'bg-emerald-500/15 border-emerald-500/30',
            icon: 'good',
        };
    }
    if (latencyMs <= 20) {
        return {
            label: '低遅延',
            textClass: 'text-primary',
            badgeClass: 'bg-primary/15 border-primary/30',
            icon: 'good',
        };
    }
    if (latencyMs <= 40) {
        return {
            label: '標準',
            textClass: 'text-yellow-600 dark:text-yellow-400',
            badgeClass: 'bg-yellow-500/15 border-yellow-500/30',
            icon: 'good',
        };
    }
    return {
        label: '高遅延',
        textClass: 'text-destructive',
        badgeClass: 'bg-destructive/10 border-destructive/30',
        icon: 'bad',
    };
};

export const DeviceStatus: React.FC<DeviceStatusProps> = ({ host, sampleRate, bufferSize, isRunning, onClick }) => {
    // Estimate buffer size if not provided (typical WASAPI default)
    const effectiveBufferSize = bufferSize || (host?.includes('ASIO') ? 256 : 512);
    const effectiveSampleRate = sampleRate || 48000;
    const isAsio = host?.toUpperCase().includes('ASIO') || false;

    const latencyMs = calculateLatency(effectiveSampleRate, effectiveBufferSize, isAsio);
    const quality = getLatencyQuality(latencyMs);
    const latencyHint = latencyMs > 40
        ? '設定でバッファサイズを小さくすると改善する場合があります'
        : 'より低遅延にしたい場合は設定でバッファサイズを調整してください';

    return (
        <button
            onClick={onClick}
            className="flex flex-col items-start px-3 py-1 rounded-md 
                       bg-muted hover:bg-muted/80
                       border border-border hover:border-primary/50
                       transition-all duration-200 group cursor-pointer min-w-0 max-w-[200px]"
        >
            <span className="hidden md:block text-[10px] uppercase text-muted-foreground font-bold tracking-wider group-hover:text-primary transition-colors">
                オーディオエンジン
            </span>
            <div className="flex items-center gap-2 min-w-0">
                <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-destructive'}`} />
                <span className="text-xs font-mono text-foreground font-medium truncate">
                    {isRunning ? (host || "稼働中") : "停止中"}
                </span>
            </div>
            {isRunning && (
                <div
                    className={`hidden sm:inline-flex mt-1 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${quality.textClass} ${quality.badgeClass}`}
                    title={`推定レイテンシ: ${latencyMs.toFixed(1)}ms / ${latencyHint}`}
                >
                    {quality.icon === 'good' ? <MdFlashOn className="w-3 h-3" /> : <MdFlashOff className="w-3 h-3" />}
                    <span>{latencyMs.toFixed(0)}ms</span>
                    <span className="opacity-70">({quality.label})</span>
                </div>
            )}
        </button>
    );
};

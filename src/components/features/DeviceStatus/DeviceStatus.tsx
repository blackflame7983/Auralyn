import React from 'react';
import { MdFlashOn, MdFlashOff } from 'react-icons/md';

interface DeviceStatusProps {
    host: string;
    sampleRate?: number;
    bufferSize?: number;
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
const getLatencyQuality = (latencyMs: number): { label: string; color: string; icon: 'good' | 'bad' } => {
    if (latencyMs <= 10) return { label: '最高', color: 'text-emerald-500', icon: 'good' };
    if (latencyMs <= 20) return { label: '良好', color: 'text-primary', icon: 'good' };
    if (latencyMs <= 40) return { label: '普通', color: 'text-yellow-500', icon: 'good' };
    return { label: '遅延大', color: 'text-destructive', icon: 'bad' };
};

export const DeviceStatus: React.FC<DeviceStatusProps> = ({ host, sampleRate, bufferSize, onClick }) => {
    // Estimate buffer size if not provided (typical WASAPI default)
    const effectiveBufferSize = bufferSize || (host?.includes('ASIO') ? 256 : 512);
    const effectiveSampleRate = sampleRate || 48000;
    const isAsio = host?.toUpperCase().includes('ASIO') || false;

    const latencyMs = calculateLatency(effectiveSampleRate, effectiveBufferSize, isAsio);
    const quality = getLatencyQuality(latencyMs);

    return (
        <button
            onClick={onClick}
            className="flex flex-col items-start px-3 py-1 rounded-md 
                       bg-muted hover:bg-muted/80
                       border border-border hover:border-primary/50
                       transition-all duration-200 group cursor-pointer"
        >
            <span className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider group-hover:text-primary transition-colors">
                オーディオエンジン
            </span>
            <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${host ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-destructive'}`} />
                <span className="text-xs font-mono text-foreground font-medium">
                    {host || "停止中"}
                    {host && (
                        <>
                            <span className="opacity-50 mx-1">|</span>
                            <span className={quality.color} title={`推定レイテンシ: ${latencyMs.toFixed(1)}ms`}>
                                {quality.icon === 'good' ? <MdFlashOn className="w-3 h-3 inline" /> : <MdFlashOff className="w-3 h-3 inline" />}
                                {latencyMs.toFixed(0)}ms
                            </span>
                        </>
                    )}
                </span>
            </div>
        </button>
    );
};

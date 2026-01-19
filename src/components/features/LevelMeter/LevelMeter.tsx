import React, { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

interface MeterLevels {
    input: [number, number];
    output: [number, number];
}

interface LevelMeterProps {
    width?: number; // Width of EACH bar
    height?: number;
    type?: 'input' | 'output';
}

export const LevelMeter: React.FC<LevelMeterProps> = ({ width = 8, height = 32, type = 'output' }) => {
    const [levels, setLevels] = useState<[number, number]>([0, 0]);
    const [isClipping, setIsClipping] = useState(false);
    const targetLevels = useRef<[number, number]>([0, 0]);
    const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const unlisten = listen<MeterLevels>('audio-level', (event) => {
            const data = type === 'input' ? event.payload.input : event.payload.output;
            targetLevels.current = data;

            // Check clipping (instant)
            if (data[0] > 1.0 || data[1] > 1.0) {
                setIsClipping(true);
                if (clipTimer.current) clearTimeout(clipTimer.current);
                clipTimer.current = setTimeout(() => setIsClipping(false), 2000); // Hold clip for 2s
            }
        });

        return () => {
            unlisten.then(f => f());
        };
    }, [type]);

    useEffect(() => {
        // Use setInterval instead of requestAnimationFrame
        // RAF is throttled to ~1FPS or paused when window is in background
        const intervalId = setInterval(() => {
            setLevels(prev => {
                const [currL, currR] = prev;
                let [targetL, targetR] = targetLevels.current;

                // NaN Protection
                if (isNaN(targetL)) targetL = 0;
                if (isNaN(targetR)) targetR = 0;

                // Asymmetric Smoothing: Fast Attack (0.8), Smooth Decay (0.4)
                // This makes it feel "snappy" but readable.
                const smoothL = targetL > currL ? 0.8 : 0.4;
                const smoothR = targetR > currR ? 0.8 : 0.4;

                let newL = currL + (targetL - currL) * smoothL;
                let newR = currR + (targetR - currR) * smoothR;

                // Safety Clamp/NaN Check for result
                if (isNaN(newL) || !isFinite(newL)) newL = 0;
                if (isNaN(newR) || !isFinite(newR)) newR = 0;

                return [newL, newR];
            });
        }, 16); // ~60 FPS

        return () => {
            clearInterval(intervalId);
            if (clipTimer.current) clearTimeout(clipTimer.current);
        };
    }, []);

    const renderBar = (val: number) => {
        // Clamp for bar height, but keep original val for clip logic (handled separately)
        const pct = Math.min(100, Math.max(0, val * 100));

        // Color logic
        let barColor = "bg-gradient-to-t from-emerald-500 via-emerald-400 to-yellow-400 dark:from-accent-primary dark:to-accent-secondary";

        return (
            <div className="w-full h-full bg-bg-element rounded-full relative overflow-hidden ring-1 ring-border-subtle">
                <div
                    className={`absolute bottom-0 left-0 right-0 ${barColor} transition-all duration-75 ease-out`}
                    style={{ height: `${pct}%` }}
                />
                {/* Scanline effect */}
                <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.1)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none opacity-50" />
            </div>
        );
    };

    return (
        <div className={`relative flex gap-1.5 p-1.5 bg-bg-panel/50 rounded-lg border shadow-inner items-center justify-center backdrop-blur-sm transition-colors duration-300 ${isClipping ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)] bg-red-500/10' : 'border-border-subtle'}`} style={{ height }}>
            {/* Type Label (Tiny) */}
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] font-mono font-bold text-text-tertiary uppercase tracking-wider bg-bg-base px-1 rounded ring-1 ring-border-subtle/50">
                {type === 'input' ? 'IN' : 'OUT'}
            </div>

            <div style={{ width, height: '100%' }} title="Left">
                {renderBar(levels[0])}
            </div>
            <div style={{ width, height: '100%' }} title="Right">
                {renderBar(levels[1])}
            </div>
        </div>
    );
};

import React, { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdGraphicEq } from 'react-icons/md';
import { cn } from '@/lib/utils';

interface MeterLevels {
    input: [number, number];
    output: [number, number];
}

export const MasterBar: React.FC = () => {
    const [levels, setLevels] = useState<[number, number]>([0, 0]);
    const [isClipping, setIsClipping] = useState(false);
    const targetLevels = useRef<[number, number]>([0, 0]);
    const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const unlisten = listen<MeterLevels>('audio-level', (event) => {
            const data = event.payload.output;
            targetLevels.current = data;

            // Instant clip detection
            if (data[0] > 1.0 || data[1] > 1.0) {
                setIsClipping(true);
                if (clipTimer.current) clearTimeout(clipTimer.current);
                clipTimer.current = setTimeout(() => setIsClipping(false), 2000);
            }
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    useEffect(() => {
        const intervalId = setInterval(() => {
            setLevels(prev => {
                const [currL, currR] = prev;
                let [targetL, targetR] = targetLevels.current;

                if (isNaN(targetL)) targetL = 0;
                if (isNaN(targetR)) targetR = 0;

                // Smooth decay
                const smoothL = targetL > currL ? 0.9 : 0.4;
                const smoothR = targetR > currR ? 0.9 : 0.4;

                let newL = currL + (targetL - currL) * smoothL;
                let newR = currR + (targetR - currR) * smoothR;

                if (isNaN(newL)) newL = 0;
                if (isNaN(newR)) newR = 0;

                return [newL, newR];
            });
        }, 16);

        return () => clearInterval(intervalId);
    }, []);

    const dbValue = (val: number) => {
        if (val <= 0.0001) return '-inf';
        return (20 * Math.log10(val)).toFixed(1);
    };

    const renderMeter = (val: number, label: string) => {
        const pct = Math.min(100, Math.max(0, val * 100));
        return (
            <div className="flex flex-col gap-1 w-3 h-full bg-muted rounded-sm overflow-hidden border border-border relative group transition-colors duration-300">
                {/* Bar */}
                <div
                    className={cn(
                        "absolute bottom-0 left-0 right-0 transition-all duration-75 ease-out",
                        isClipping ? "bg-destructive shadow-[0_0_10px_currentColor]" : "bg-emerald-500"
                    )}
                    style={{ height: `${pct}%` }}
                />

                {/* Grid */}
                <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.1)_1px,transparent_1px)] dark:bg-[linear-gradient(rgba(0,0,0,0.5)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none" />

                {/* Label */}
                <div className="absolute bottom-1 left-0 right-0 text-[8px] text-center text-muted-foreground font-mono pointer-events-none mix-blend-difference opacity-0 group-hover:opacity-100 transition-opacity">{label}</div>
            </div>
        );
    };

    return (
        <div className="h-full flex items-center gap-6 px-6 border-l border-border bg-card/30 backdrop-blur-sm transition-colors duration-300">
            {/* Label */}
            <div className="flex flex-col items-end justify-center min-w-[60px]">
                <div className="flex items-center gap-2 text-muted-foreground font-bold font-mono tracking-widest text-xs">
                    <MdGraphicEq className={cn("w-3 h-3", isClipping ? 'text-destructive animate-pulse' : 'text-emerald-500')} />
                    マスター
                </div>
                <div className="text-[10px] text-muted-foreground font-mono tracking-tight">
                    {dbValue(Math.max(levels[0], levels[1]))} dB
                </div>
            </div>

            {/* Meters */}
            <div className="flex gap-1 h-3/4 items-end pb-1">
                {renderMeter(levels[0], 'L')}
                {renderMeter(levels[1], 'R')}
            </div>


        </div>
    );
};

import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../../api/audio';
import { MdGraphicEq } from 'react-icons/md';

interface InputChannelSelectorProps {
    // selectedInput: string; // Not currently used visually, but kept in props if needed later? No, remove if unused.
    onChannelMapped?: (channels: [number, number]) => void;
    initialChannels?: [number, number];
    maxChannels?: number;
}

export const InputChannelSelector: React.FC<InputChannelSelectorProps> = ({ onChannelMapped, initialChannels, maxChannels }) => {
    const [activeChannels, setActiveChannels] = useState<number[]>([]);
    const [selectedPair, setSelectedPair] = useState<[number, number]>(initialChannels || [0, 1]);
    // const [scanning, setScanning] = useState(true); // Always true while mounted

    // Update selectedPair if initialChannels changes (e.g. loaded from config)
    useEffect(() => {
        if (initialChannels) {
            setSelectedPair(initialChannels);
        }
    }, [initialChannels]);

    // Use a ref for throttle or immediate update without re-render loops if needed
    // But here we rely on state for UI

    useEffect(() => {
        // Enable scanning on mount
        audioApi.setChannelScan(true);

        const unlisten = listen('audio-channel-scan', (event) => {
            const levels = event.payload as number[]; // Vec<f32>
            // Determine which channels have signal above threshold
            const active: number[] = [];
            levels.forEach((lvl, idx) => {
                if (lvl > 0.05) { // Threshold
                    active.push(idx);
                }
            });
            setActiveChannels(active);
        });

        return () => {
            audioApi.setChannelScan(false);
            unlisten.then(f => f());
        };
    }, []);

    // Clear signal indicators when device changes (maxChannels changes)
    // This prevents confusion when the user switches devices in the dropdown
    // but the engine is still running with the previous device.
    useEffect(() => {
        setActiveChannels([]);
    }, [maxChannels]);

    const handlePairSelect = (left: number, right: number) => {
        setSelectedPair([left, right]);
        audioApi.setInputChannels(left, right);
        if (onChannelMapped) onChannelMapped([left, right]);
    };

    // Render pairs based on maxChannels (or default 32)
    const renderPairs = () => {
        const limit = maxChannels && maxChannels > 0 ? maxChannels : 32;
        const pairs = [];
        // Ensure even number of channels for pairs
        const loopLimit = limit % 2 === 0 ? limit : limit + 1;

        for (let i = 0; i < loopLimit; i += 2) {
            const left = i;
            const right = i + 1;
            const isSelected = selectedPair[0] === left && selectedPair[1] === right;

            // Activity detection
            const leftActive = activeChannels.includes(left);
            const rightActive = activeChannels.includes(right);
            const hasSignal = leftActive || rightActive;

            pairs.push(
                <div
                    key={`pair-${i}`}
                    onClick={() => handlePairSelect(left, right)}
                    className={`
                    flex items-center gap-2 p-2 rounded-md cursor-pointer border transition-all
                    ${isSelected
                            ? 'bg-primary/10 border-primary text-primary dark:bg-primary/20'
                            : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-100 dark:bg-muted/30 dark:border-transparent dark:text-muted-foreground dark:hover:bg-muted/50'}
                `}
                >
                    <div className="flex flex-col gap-1 w-6 items-center">
                        <div className={`w-2 h-2 rounded-full ${leftActive ? 'bg-green-500 animate-pulse' : 'bg-gray-300 dark:bg-zinc-600'}`} title={`Ch ${left + 1} Signal`} />
                        <div className={`w-2 h-2 rounded-full ${rightActive ? 'bg-green-500 animate-pulse' : 'bg-gray-300 dark:bg-zinc-600'}`} title={`Ch ${right + 1} Signal`} />
                    </div>
                    <div className="flex-1 text-xs flex flex-col justify-center min-w-0">
                        <span className="font-mono truncate">In {left + 1}/{right + 1}</span>
                        <span className={`text-[10px] text-green-600 dark:text-green-500 font-bold leading-none mt-0.5 transition-opacity duration-200 ${hasSignal ? 'opacity-100' : 'opacity-0'}`}>
                            SIGNAL
                        </span>
                    </div>
                </div>
            );
        }
        return pairs;
    };

    return (
        <div className="space-y-3 p-4 bg-gray-50 dark:bg-zinc-950/50 rounded-lg border border-gray-200 dark:border-border">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold flex items-center gap-2 text-gray-900 dark:text-white">
                    <MdGraphicEq className="text-primary" />
                    入力チャンネルマッピング
                </h3>
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full bg-green-500 animate-pulse`} />
                    <span className="text-[10px] text-muted-foreground">Scanning...</span>
                </div>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
                音声信号が入っているチャンネルを選択してください。<br />
                緑色のインジケーターが点灯しているチャンネルがアクティブです。
            </p>

            <div className={`grid grid-cols-4 gap-2 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-zinc-700 ${maxChannels && maxChannels > 16 ? 'max-h-60' : 'max-h-auto'}`}>
                {renderPairs()}
            </div>
        </div>
    );
};

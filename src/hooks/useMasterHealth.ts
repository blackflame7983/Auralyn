import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { EngineRuntimeStats, ProcessingHealthSnapshot } from '@/api/audio';
import { delay } from '@/hooks/internal/schedule';
import { invalidateRuntimeStats, useRuntimeStats } from '@/hooks/useRuntimeStats';

// 出力の統計と、処理の停滞・途切れの表示を保つ。統計が止まっても古い警告を残さない。
export function useMasterHealth(isRunning: boolean, onStatsChange?: (stats: EngineRuntimeStats | null) => void) {
    const stats = useRuntimeStats();
    const [eventHealth, setEventHealth] = useState<ProcessingHealthSnapshot | null>(null);
    const eventHealthTimer = useRef<(() => void) | null>(null);
    const [hasRecentGlitch, setHasRecentGlitch] = useState(false);
    const glitchTimer = useRef<(() => void) | null>(null);
    const previousGlitchCount = useRef<number | null>(null);
    const previousRunning = useRef(isRunning);
    const clearEventHealth = useCallback(() => {
        eventHealthTimer.current?.();
        eventHealthTimer.current = null;
        setEventHealth(null);
    }, []);
    useEffect(() => {
        if (previousRunning.current !== isRunning) invalidateRuntimeStats();
        previousRunning.current = isRunning;
        previousGlitchCount.current = null;
        glitchTimer.current?.();
        setHasRecentGlitch(false);
    }, [isRunning]);

    useEffect(() => {
        const unlisten = listen('audio-started', () => {
            previousGlitchCount.current = null;
            glitchTimer.current?.();
            setHasRecentGlitch(false);
            clearEventHealth();
        });
        return () => { void unlisten.then(stop => stop()).catch(() => {}); };
    }, [clearEventHealth]);

    useEffect(() => () => { glitchTimer.current?.(); }, []);

    useEffect(() => {
        let disposed = false;
        const clear = () => { if (!disposed) clearEventHealth(); };
        // 統計が来ない間も、失効と同じ 2.5 秒でイベント由来の停止を残さない。
        const unlistenHealth = listen<ProcessingHealthSnapshot>('audio-processing-health', event => {
            if (disposed) return;
            eventHealthTimer.current?.();
            setEventHealth(event.payload);
            eventHealthTimer.current = delay(2500, clear);
        });
        const unlistenLifecycle = Promise.all(
            ['audio-stopped', 'audio-error', 'audio-stream-error'].map(name => listen(name, clear)),
        );
        return () => {
            disposed = true;
            eventHealthTimer.current?.();
            void unlistenHealth.then(stop => stop()).catch(() => {});
            void unlistenLifecycle.then(stops => stops.forEach(stop => stop())).catch(() => {});
        };
    }, [clearEventHealth]);
    useEffect(() => { clearEventHealth(); }, [stats, clearEventHealth]);
    useEffect(() => { if (!isRunning) clearEventHealth(); }, [isRunning, clearEventHealth]);
    const health = eventHealth ?? stats?.processingHealth ?? null;

    useEffect(() => {
        onStatsChange?.(stats);
        if (!stats) { previousGlitchCount.current = null; return; }
        const previous = previousGlitchCount.current;
        if (previous !== null && stats.glitchCount > previous) {
            setHasRecentGlitch(true);
            glitchTimer.current?.();
            glitchTimer.current = delay(10000, () => setHasRecentGlitch(false));
        }
        previousGlitchCount.current = stats.glitchCount;
    }, [stats, onStatsChange]);

    return { stats, health, hasRecentGlitch, processingStalled: isRunning && health?.state === 'stalled' };
}
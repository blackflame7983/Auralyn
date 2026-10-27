import { createContext, useContext } from 'react';
import type { EngineRuntimeStats, LatencyStageBreakdown } from '@/api/audio';

export const RuntimeStatsContext = createContext<{ stats: EngineRuntimeStats | null; running: boolean }>({ stats: null, running: false });
export const useRuntimeStats = () => useContext(RuntimeStatsContext);

// 現在の音声世代に結び付かない値を設定の現状として表示しない。
export function currentStageBreakdown(stats: EngineRuntimeStats | null, running: boolean): LatencyStageBreakdown | null {
    const metadata = stats?.latencyMetadata;
    const stage = metadata?.stageBreakdown;
    const queue = stats?.queueDiagnostics;
    if (!running || metadata?.schemaVersion !== 1 || !metadata.streamRunning || !stage || stage.schemaVersion !== 1
        || !stage.current || stage.queryBasis !== 'queriedAtRuntimeStats' || typeof stage.streamEpoch !== 'string'
        || !(metadata.processingContext === 'broadcastWorker' ? stage.streamEpoch === metadata.streamEpoch : queue?.state === 'running' && queue.epoch === stage.streamEpoch)
        || typeof stage.nr?.enabled !== 'boolean' || typeof stage.builtinVoiceEnabled !== 'boolean' || typeof stage.builtinReverbEnabled !== 'boolean'
        || typeof stage.globalBypass !== 'boolean' || !Array.isArray(stage.vst) || stage.vst.length > 32) return null;
    return stage;
}

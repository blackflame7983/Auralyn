import type { VoicePreviewRequest, VoicePreviewSnapshot } from '@/api/voiceCheckPreview';
export function previewSnapshot(request: VoicePreviewRequest, patch: Partial<VoicePreviewSnapshot> = {}): VoicePreviewSnapshot {
    return {
        epoch: 'engine-epoch', sessionId: request.sessionId, operationId: request.operationId,
        recordingId: null, state: request.action === 'close' ? 'closed' : 'idle', positionMs: 0, durationMs: 0,
        source: 'processed', loopPlayback: true, levelMatch: false, levelMatchAvailable: false,
        metadata: null, recordingStale: false, devices: [], error: null, owner: null, conflict: null,
        levelMatchAttenuationDb: [0, 0], safetyAttenuationDb: 0, ...patch,
    };
}

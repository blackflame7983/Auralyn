import type { LiveOutputConfig } from '@/api/liveOutput';

// 音楽鑑賞で配信向けの欄を隠すとき、保存済みの値が既定から外れていれば戻し先を残す（#642）。
// 既定はエンジンの live_output と同じ。未設定の項目は既定として扱う。
export function liveOutputConfigInUse(config: Partial<LiveOutputConfig> | null | undefined) {
    if (!config) return false;
    const trimChanged = (value: number | undefined) => value != null && value !== 1;
    return Boolean(config.deviceId)
        || config.splitProcessing === true
        || config.monitorMuted === true
        || trimChanged(config.monitorTrim)
        || trimChanged(config.broadcastTrim)
        || config.monitorSinging != null
        || config.monitorTalk != null;
}

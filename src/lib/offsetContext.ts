import type { ActiveAudioConfig } from '@/api/audio';
import type { LiveOutputConfig } from '@/api/liveOutput';
import type { MixConfig, MixLevels, MixSource, OffsetContext } from '@/api/mixing';

// 往復測定のdeviceIdentityと同じく、IDがない旧設定は名前で識別する。
function identity(id?: string | null, name?: string | null): string | null {
    return id?.trim() || (name?.trim() ? `name:${name.trim()}` : null);
}

export function currentOffsetContext(
    audio: ActiveAudioConfig | null | undefined,
    source: MixSource | null | undefined,
    broadcast: LiveOutputConfig | null | undefined,
): OffsetContext | null {
    const voiceInputId = identity(audio?.input_id, audio?.input);
    const outputId = identity(audio?.output_id, audio?.output);
    const channels = audio?.routing?.inputChannels;
    if (!voiceInputId || !outputId || !channels || !source || !broadcast || audio?.input_source?.kind === 'process_loopback') return null;
    if (source.kind === 'device' ? !source.config.inputId : !source.config.appKey || !source.config.rawEndpointId) return null;
    // JSONの配列で区切り文字を含むIDも衝突させず、PIDや表示名は保存しない。
    const accompaniment = source.kind === 'device'
        ? JSON.stringify(['device', source.config.inputId, ...source.config.inputChannels])
        : JSON.stringify(['process_loopback', source.config.appKey, source.config.rawEndpointId]);
    return { voiceInputId, voiceChannels: [...channels], accompaniment, outputId, broadcastId: broadcast.deviceId };
}

export type OffsetContextField = keyof OffsetContext;
export function offsetContextChanges(saved: OffsetContext, current: OffsetContext): OffsetContextField[] {
    return (['voiceInputId', 'voiceChannels', 'accompaniment', 'outputId', 'broadcastId'] as const).filter(key =>
        key === 'voiceChannels'
            ? saved.voiceChannels[0] !== current.voiceChannels[0] || saved.voiceChannels[1] !== current.voiceChannels[1]
            : saved[key] !== current[key]);
}

export function offsetStatus(levels: MixLevels, current: OffsetContext | null): 'none' | 'confirmed' | 'unconfirmed' | 'unknown' {
    if (levels.offsetMs === 0) return 'none';
    if (!current) return 'unknown';
    return levels.offsetContext && offsetContextChanges(levels.offsetContext, current).length === 0 ? 'confirmed' : 'unconfirmed';
}

// 確認の記録だけが異なっても、音量・入力元の変更として表示しない。
export function mixingConfigurationValue(config: MixConfig | null): string {
    if (!config) return JSON.stringify(null);
    const { offsetContext: _context, ...levels } = config.levels;
    return JSON.stringify({ ...config, levels });
}

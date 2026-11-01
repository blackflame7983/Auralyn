export type OutputRouting = { mode: 'legacy' } | { mode: 'insert' }
    | { mode: 'independent'; channels: [number, number] };

export interface ChannelRouting {
    inputChannels?: [number, number];
    outputRouting: OutputRouting;
}

export function readOutputRouting(value: unknown): OutputRouting | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    if (item.mode === 'legacy' || item.mode === 'insert') return { mode: item.mode };
    if (item.mode === 'independent' && Array.isArray(item.channels) && item.channels.length === 2
        && item.channels.every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 65535)) {
        return { mode: 'independent', channels: [item.channels[0], item.channels[1]] };
    }
    return undefined;
}

// 項目のない保存済み設定は、従来のASIO返却方法を維持する。
export function channelRoutingFor(config: { host: string; inputChannels?: [number, number]; outputRouting?: OutputRouting }): ChannelRouting {
    return config.host.toLowerCase() === 'asio'
        ? { inputChannels: config.inputChannels, outputRouting: config.outputRouting ?? { mode: 'legacy' } }
        : { inputChannels: [0, 1], outputRouting: { mode: 'independent', channels: [0, 1] } };
}

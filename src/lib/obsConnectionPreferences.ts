import { message, type MessageKey } from '@/i18n/messages';

/** 接続先だけを共有する。ウィザードへ保存済みパスワードを渡さない。 */
export function readObsEndpoint(): { host: string; port: number } {
    const fallback = { host: 'localhost', port: 4455 };
    try {
        const saved: unknown = JSON.parse(localStorage.getItem('vst_host_obs_config') ?? 'null');
        if (!saved || typeof saved !== 'object') return fallback;
        const value = saved as Record<string, unknown>;
        return {
            host: typeof value.host === 'string' && value.host.trim() ? value.host.trim() : fallback.host,
            port: typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 ? value.port : fallback.port,
        };
    } catch { return fallback; }
}

const failureKeys = {
    authentication: 'obsConnectionFailure.authentication',
    timeout: 'obsConnectionFailure.timeout',
    refused: 'obsConnectionFailure.refused',
    other: 'obsConnectionFailure.other',
} as const satisfies Record<string, MessageKey>;
export interface ObsConnectionFailureNotice {
    code: keyof typeof failureKeys;
    key: typeof failureKeys[keyof typeof failureKeys];
    args?: { port: number };
}

/** 生の接続エラーには資格情報が含まれ得るため、分類と試行ポートだけを返す。 */
export function obsConnectionFailureNotice(error: unknown, port: number): ObsConnectionFailureNotice {
    const message = String(error).toLowerCase();
    if (message.includes('401') || message.includes('auth')) {
        return { code: 'authentication', key: failureKeys.authentication };
    }
    if (message.includes('timeout') || message.includes('timed out')) {
        return { code: 'timeout', key: failureKeys.timeout, args: { port } };
    }
    if (message.includes('connection refused') || message.includes('failed to connect')) {
        return { code: 'refused', key: failureKeys.refused, args: { port } };
    }
    return { code: 'other', key: failureKeys.other, args: { port } };
}

/** 既存caller向けの固定日本語互換。APIは現在localeを読み取らない。 */
export function obsConnectionFailure(error: unknown, port: number): string {
    const value = obsConnectionFailureNotice(error, port);
    return message('ja', value.key, value.args);
}

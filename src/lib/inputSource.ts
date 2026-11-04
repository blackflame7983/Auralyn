export type InputPurpose = 'voice' | 'music';
export type InputSource = { kind: 'device'; config: { purpose: InputPurpose } }
    | { kind: 'process_loopback'; config: { appKey: string; appName: string; rawEndpointId: string; purpose: InputPurpose } };
export interface InputSourceRequest { source: InputSource; candidateId?: string }
export interface ProcessInputCandidate { id: string; appKey: string; name: string; routes: { id: string; name: string; muted: boolean }[] }
export const deviceInput = (): InputSource => ({ kind: 'device', config: { purpose: 'voice' } });

// 保存設定には実行中プロセスのIDを許さない。未知の形式をマイクへ読み替えない。
export function readInputSource(value: unknown): InputSource | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !['kind', 'config'].includes(k)) || !v.config || typeof v.config !== 'object') return undefined;
    const c = v.config as Record<string, unknown>;
    if (c.purpose !== 'voice' && c.purpose !== 'music') return undefined;
    if (v.kind === 'device' && Object.keys(c).every(k => k === 'purpose')) return { kind: 'device', config: { purpose: c.purpose } };
    if (v.kind === 'process_loopback' && Object.keys(c).every(k => ['appKey', 'appName', 'rawEndpointId', 'purpose'].includes(k))
        && typeof c.appKey === 'string' && /^[a-f0-9]{64}$/i.test(c.appKey)
        && typeof c.appName === 'string' && c.appName.length > 0 && c.appName.length <= 260 && !/[\\/\x00-\x1f]/.test(c.appName)
        && typeof c.rawEndpointId === 'string' && c.rawEndpointId.length > 0 && c.rawEndpointId.length <= 4096 && !/[\x00-\x1f]/.test(c.rawEndpointId)) {
        return { kind: 'process_loopback', config: { appKey: c.appKey, appName: c.appName, rawEndpointId: c.rawEndpointId, purpose: c.purpose } };
    }
    return undefined;
}

import { expect, it } from 'vitest';
import { liveOutputConfigInUse } from '../streamingSettings';

const idle = { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false, splitProcessing: false, monitorSinging: null, monitorTalk: null };

it('分離出力は、保存値が既定から外れているときだけ使用中', () => {
    expect(liveOutputConfigInUse(null)).toBe(false);
    expect(liveOutputConfigInUse(undefined)).toBe(false);
    expect(liveOutputConfigInUse(idle)).toBe(false);
    expect(liveOutputConfigInUse({ deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false })).toBe(false);
    expect(liveOutputConfigInUse({ ...idle, deviceId: 'cable' })).toBe(true);
    expect(liveOutputConfigInUse({ ...idle, splitProcessing: true })).toBe(true);
    expect(liveOutputConfigInUse({ ...idle, monitorMuted: true })).toBe(true);
    expect(liveOutputConfigInUse({ ...idle, monitorTrim: 0.5 })).toBe(true);
    expect(liveOutputConfigInUse({ ...idle, broadcastTrim: 0.5 })).toBe(true);
    expect(liveOutputConfigInUse({ ...idle, monitorSinging: { active: false } as never })).toBe(true);
    expect(liveOutputConfigInUse({ ...idle, monitorTalk: { active: false } as never })).toBe(true);
});

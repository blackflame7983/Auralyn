import { readDisplayPurpose, saveDisplayPurpose, type DisplayPurpose } from './displayPurpose';
import { withInputPurpose } from './inputSource';
import { readAudioPreferences, type AudioPreferences } from './audioPreferences';
import { usageDeviceFromPreferences, writeUsageDevice, type UsageDeviceRecord } from './usageDevices';

export type UsageSetupGoal = 'obs' | 'discord' | 'listening' | 'music' | 'other';

export function setupGoalForUsage(target: DisplayPurpose): UsageSetupGoal {
    if (target === 'music') return 'music';
    try {
        const saved = localStorage.getItem('vst_host_setup_goal');
        const goal = saved === 'local' ? 'listening' : saved;
        if (goal === 'obs' || goal === 'discord' || goal === 'listening' || goal === 'other') return goal;
    } catch { return 'obs'; }
    return 'obs';
}

export function preferencesFromUsage(record: UsageDeviceRecord): AudioPreferences {
    const process = record.inputSource.kind === 'process_loopback';
    return {
        host: record.host,
        input: process ? undefined : record.input,
        inputId: process ? undefined : record.inputId,
        output: record.output,
        outputId: record.outputId,
        sampleRate: record.sampleRate,
        bufferSize: record.bufferSize,
        inputSource: record.inputSource,
    };
}

interface CommitOptions {
    target: DisplayPurpose;
    record: UsageDeviceRecord;
    running: boolean;
    restart: (record: UsageDeviceRecord) => Promise<{ sampleRate: number; bufferSize: number }>;
    save: (config: AudioPreferences, options?: { audioStarted: true }) => Promise<void>;
    restore: (config: AudioPreferences, running: boolean) => Promise<void>;
}

export async function commitUsageSwitch({ target, record, running, restart, save, restore }: CommitOptions): Promise<UsageDeviceRecord> {
    const previousDisplay = readDisplayPurpose();
    const previous = readAudioPreferences();
    const applied: UsageDeviceRecord = { ...record, inputSource: withInputPurpose(record.inputSource, target) };
    let audioChanged = false;
    let displayChanged = false;
    try {
        if (running) {
            const actual = await restart(applied);
            applied.sampleRate = actual.sampleRate;
            applied.bufferSize = actual.bufferSize;
        }
        await save(preferencesFromUsage(applied), running ? { audioStarted: true } : undefined);
        audioChanged = true;
        saveDisplayPurpose(target);
        displayChanged = true;
        if (previous && previousDisplay !== target) {
            const leaving = usageDeviceFromPreferences(previous, previousDisplay);
            if (leaving) writeUsageDevice(previousDisplay, leaving);
        }
        writeUsageDevice(target, applied);
        return applied;
    } catch (error) {
        if (displayChanged) saveDisplayPurpose(previousDisplay);
        if (audioChanged && previous?.host) {
            try { await restore(previous, running); } catch { /* 表示は戻してある。戻しの失敗は最初のエラーに重ねない。 */ }
        }
        throw error;
    }
}

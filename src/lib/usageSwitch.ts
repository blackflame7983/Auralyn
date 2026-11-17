import { REVIEW_KEY } from '@/api/migration';
import { DISPLAY_PURPOSE_EVENT, DISPLAY_PURPOSE_KEY, readDisplayPurpose, saveDisplayPurpose, type DisplayPurpose } from './displayPurpose';
import { withInputPurpose } from './inputSource';
import { readAudioPreferences, type AudioPreferences } from './audioPreferences';
import type { ChannelRouting } from './audioChannelRouting';
import { USAGE_DEVICES_KEY, usageDeviceFromPreferences, usageRouting, writeUsageDevice, type UsageDeviceRecord } from './usageDevices';

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
    const routing = usageRouting(record);
    return {
        host: record.host,
        input: process ? undefined : record.input,
        inputId: process ? undefined : record.inputId,
        output: record.output,
        outputId: record.outputId,
        sampleRate: record.sampleRate,
        bufferSize: record.bufferSize,
        inputSource: record.inputSource,
        inputChannels: routing.inputChannels ?? [0, 1],
        outputRouting: routing.outputRouting,
    };
}

const SWITCH_KEYS = ['vst_host_audio_config', USAGE_DEVICES_KEY, DISPLAY_PURPOSE_KEY, REVIEW_KEY];

/** 指定した保存値を控え、返した関数で元の文字列のまま書き戻す。すべて戻せたときだけ true。 */
export function snapshotStorage(keys: readonly string[]): () => boolean {
    const saved = keys.map(key => [key, localStorage.getItem(key)] as const);
    return () => {
        let restored = true;
        for (const [key, value] of saved) {
            try {
                if (value === null) localStorage.removeItem(key);
                else localStorage.setItem(key, value);
            } catch { restored = false; }
        }
        window.dispatchEvent(new Event(DISPLAY_PURPOSE_EVENT));
        return restored;
    };
}

/** 切り替えに失敗したとき、元の状態へ戻せたか。戻せなかったときは音が止まったままのことがある。 */
export class UsageSwitchError extends Error {
    constructor(cause: unknown, public readonly restored: boolean, /** 元へ戻せなかった理由。戻せたときや理由が無いときは空。 */ public readonly restoreReason = '') {
        super(cause instanceof Error ? cause.message : String(cause));
    }
}

export const snapshotUsageStorage = () => snapshotStorage(SWITCH_KEYS);

// いまの接続を、離れる使い道の記録として残す。入力の用途が表示と合わないときは残さない。
function rememberLeaving(previousDisplay: DisplayPurpose, target: DisplayPurpose, previous: AudioPreferences | null) {
    if (!previous || previousDisplay === target) return;
    const leaving = usageDeviceFromPreferences(previous, previousDisplay);
    if (leaving) writeUsageDevice(previousDisplay, leaving);
}

/** 切り替える前の使い道と接続。保存が済んでから、離れる使い道の記録として残す。 */
export interface LeavingUsage {
    display: DisplayPurpose;
    preferences: AudioPreferences | null;
}

export const currentUsage = (): LeavingUsage => ({ display: readDisplayPurpose(), preferences: readAudioPreferences() });

/**
 * 保留していた表示の切り替えを、接続の保存が済んだ時点で確定する。
 * 離れる使い道の記録と表示のどちらかを残せなければ、両方を元の文字列へ戻して例外を投げる。
 */
export function commitDisplaySwitch(leaving: LeavingUsage, target: DisplayPurpose): void {
    const rewind = snapshotStorage([DISPLAY_PURPOSE_KEY, USAGE_DEVICES_KEY]);
    try {
        rememberLeaving(leaving.display, target, leaving.preferences);
        saveDisplayPurpose(target);
    } catch (error) {
        rewind();
        throw error;
    }
}

interface CommitOptions {
    target: DisplayPurpose;
    record: UsageDeviceRecord;
    running: boolean;
    restart: (record: UsageDeviceRecord) => Promise<{ sampleRate: number; bufferSize: number; routing?: ChannelRouting }>;
    /** 新しい接続の保存と、VST の復元まで。 */
    save: (config: AudioPreferences, options?: { audioStarted: true }) => Promise<void>;
    /** 元の接続へ戻す。engine が true のときは元の接続で再起動し、VST も戻す。画面の保持値も元へそろえる。 */
    restore: (config: AudioPreferences, engine: boolean) => Promise<void>;
    /** 再起動が始まる前に失敗したとき、元の音声がまだ動いているか。 */
    engineIntact?: () => Promise<boolean>;
}

export async function commitUsageSwitch({ target, record, running, restart, save, restore, engineIntact }: CommitOptions): Promise<UsageDeviceRecord> {
    const previousDisplay = readDisplayPurpose();
    const previous = readAudioPreferences();
    const rewind = snapshotUsageStorage();
    const applied: UsageDeviceRecord = { ...record, inputSource: withInputPurpose(record.inputSource, target) };
    let restarted = false;
    let saveStarted = false;
    try {
        if (running) {
            const actual = await restart(applied);
            restarted = true;
            applied.sampleRate = actual.sampleRate;
            applied.bufferSize = actual.bufferSize;
            if (record.host.toLowerCase() === 'asio' && actual.routing) {
                applied.inputChannels = actual.routing.inputChannels ?? applied.inputChannels;
                applied.outputRouting = actual.routing.outputRouting;
            }
        }
        saveStarted = true;
        await save(preferencesFromUsage(applied), running ? { audioStarted: true } : undefined);
        rememberLeaving(previousDisplay, target, previous);
        saveDisplayPurpose(target);
        writeUsageDevice(target, applied);
        return applied;
    } catch (error) {
        const outcome = await rollback();
        throw new UsageSwitchError(error, outcome.restored, outcome.reason);
    }

    // 再起動が失敗しても、元のエンジンは止まっていることがある。動いていれば触らず、止まっていれば戻す。
    async function rollback(): Promise<{ restored: boolean; reason: string }> {
        const stillRunning = running && !restarted && engineIntact ? await engineIntact().catch(() => false) : false;
        const engine = running && !stillRunning;
        let restored = true;
        let reason = '';
        if (previous?.host) {
            if (engine || saveStarted) {
                try { await restore(previous, engine); } catch (cause) {
                    restored = false;
                    reason = cause instanceof Error ? cause.message : String(cause);
                }
            }
        } else if (engine) {
            restored = false;
        }
        return { restored: rewind() && restored, reason };
    }
}

/**
 * セットアップで決めた使い道の機器と表示を残す。いまの音声設定が、その用途の記録にできないときは投げる。
 * セットアップの前の接続（leaving）は、離れる使い道の記録としてあわせて残す。
 */
export function rememberSetupUsage(purpose: DisplayPurpose, leaving?: LeavingUsage | null): void {
    const saved = readAudioPreferences();
    const record = saved && usageDeviceFromPreferences(saved, purpose);
    if (!record) throw new Error('使い道の機器を保存できません');
    if (leaving) rememberLeaving(leaving.display, purpose, leaving.preferences);
    writeUsageDevice(purpose, record);
    saveDisplayPurpose(purpose);
}

import { afterEach, expect, it } from 'vitest';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { deviceInput, type InputSource } from '@/lib/inputSource';
import type { AudioPreferences } from '@/lib/audioPreferences';
import { parseUsageDevice, readUsageDevices, USAGE_DEVICES_KEY, usageDeviceFromPreferences, usageRouting, writeUsageDevice, type UsageDeviceRecord } from '@/lib/usageDevices';
import { commitDisplaySwitch, commitUsageSwitch, currentUsage, preferencesFromUsage, rememberSetupUsage } from '@/lib/usageSwitch';

const musicSource: InputSource = { kind: 'device', config: { purpose: 'music' } };
const record = (purpose: 'voice' | 'music' = 'music'): UsageDeviceRecord => ({
    host: 'WASAPI', input: 'CABLE Output', inputId: 'cable', output: 'USB Headphones', outputId: 'phones',
    sampleRate: 48000, bufferSize: 512, inputSource: purpose === 'music' ? musicSource : deviceInput(),
});

afterEach(() => localStorage.clear());

it('使い道ごとの機器を読み、未知の形式は使わない', () => {
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music: record(), extra: true }));
    expect(readUsageDevices()).toEqual({});
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 2, music: record() }));
    expect(readUsageDevices()).toEqual({});
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music: { ...record(), future: 1 } }));
    expect(readUsageDevices().music).toBeUndefined();
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music: { ...record(), inputSource: deviceInput() } }));
    expect(readUsageDevices().music).toBeUndefined();
    localStorage.setItem(USAGE_DEVICES_KEY, 'not-json');
    expect(readUsageDevices()).toEqual({});
    expect(parseUsageDevice({ ...record(), input: 'bad\u0000' }, 'music')).toBeNull();
});

it('正しい記録だけを残し、もう一方の使い道は保つ', () => {
    writeUsageDevice('music', record());
    writeUsageDevice('voice', record('voice'));
    expect(readUsageDevices()).toEqual({ music: record(), voice: record('voice') });
    const process: UsageDeviceRecord = {
        host: 'WASAPI', output: 'Headphones', sampleRate: 44100, bufferSize: 128,
        inputSource: { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Player', rawEndpointId: 'end', purpose: 'music' } },
    };
    writeUsageDevice('music', process);
    expect(readUsageDevices().voice).toEqual(record('voice'));
    expect(readUsageDevices().music).toEqual(process);
    expect(parseUsageDevice({ ...process, input: 'Mic' }, 'music')).toBeNull();
});

it('保存済みの接続から、用途が合う機器だけを取り出す', () => {
    const prefs: AudioPreferences = { host: 'WASAPI', input: 'Mic', output: 'Phones', sampleRate: 48000, bufferSize: 512, inputSource: deviceInput() };
    expect(usageDeviceFromPreferences(prefs, 'voice')?.input).toBe('Mic');
    expect(usageDeviceFromPreferences(prefs, 'music')).toBeNull();
    expect(usageDeviceFromPreferences({ ...prefs, inputSource: undefined }, 'voice')?.inputSource).toEqual(deviceInput());
});

const previousConfig: AudioPreferences = { host: 'WASAPI', input: 'Mic', output: 'Speakers', sampleRate: 48000, bufferSize: 512, inputSource: deviceInput() };
function seedPrevious() {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    localStorage.setItem('vst_host_audio_config', JSON.stringify(previousConfig));
}
const rewritesConfig = async (config: AudioPreferences) => { localStorage.setItem('vst_host_audio_config', JSON.stringify(config)); };

it('再起動のあとで保存が失敗したら、元の接続で再起動し直し、表示・音声設定・記録を元に戻す', async () => {
    seedPrevious();
    localStorage.setItem('vst_host_migration_review_required', 'true');
    const before = Object.fromEntries(['vst_host_audio_config', 'auralyn_display_purpose', 'auralyn_usage_devices', 'vst_host_migration_review_required'].map(key => [key, localStorage.getItem(key)]));
    const restore = viRestore();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: true,
        restart: async () => ({ sampleRate: 48000, bufferSize: 512 }),
        save: async config => { await rewritesConfig(config); localStorage.removeItem('vst_host_migration_review_required'); throw new Error('保存できない'); },
        restore: restore.fn,
    })).rejects.toMatchObject({ message: '保存できない', restored: true });
    expect(restore.calls).toEqual([{ engine: true, host: 'WASAPI' }]);
    expect(readDisplayPurpose()).toBe('voice');
    expect(readUsageDevices().music).toBeUndefined();
    for (const [key, value] of Object.entries(before)) expect(localStorage.getItem(key)).toBe(value);
});

it('実行中に再起動そのものが失敗して元の音声も止まったときは、元の接続で再開する', async () => {
    seedPrevious();
    const restore = viRestore();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: true,
        restart: async () => { throw new Error('機器が見つかりません'); },
        save: async () => { throw new Error('保存まで進まない'); },
        restore: restore.fn,
        engineIntact: async () => false,
    })).rejects.toMatchObject({ message: '機器が見つかりません', restored: true });
    expect(restore.calls).toEqual([{ engine: true, host: 'WASAPI' }]);
    expect(readDisplayPurpose()).toBe('voice');
});

it('再起動の前に失敗して元の音声が動いたままなら、再起動も保存値の同期もしない', async () => {
    seedPrevious();
    const restore = viRestore();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: true,
        restart: async () => { throw new Error('マイクの許可がありません'); },
        save: async () => { throw new Error('保存まで進まない'); },
        restore: restore.fn,
        engineIntact: async () => true,
    })).rejects.toMatchObject({ restored: true });
    expect(restore.calls).toEqual([]);
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic' });
});

it('保存の途中で VST の復元が失敗しても、音声設定と記録を元に戻し、再起動し直す', async () => {
    seedPrevious();
    const restore = viRestore();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: true,
        restart: async () => ({ sampleRate: 48000, bufferSize: 512 }),
        save: async config => { await rewritesConfig(config); throw new Error('VST を戻せません'); },
        restore: restore.fn,
    })).rejects.toThrow('VST を戻せません');
    expect(restore.calls).toEqual([{ engine: true, host: 'WASAPI' }]);
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic', output: 'Speakers' });
    expect(readDisplayPurpose()).toBe('voice');
});

it('元の接続にも戻せなかったときは、戻せなかったことを知らせ、保存値だけは元にする', async () => {
    seedPrevious();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: true,
        restart: async () => { throw new Error('機器が見つかりません'); },
        save: async () => {},
        restore: async () => { throw new Error('元の機器も開けません'); },
        engineIntact: async () => false,
    })).rejects.toMatchObject({ message: '機器が見つかりません', restored: false });
    expect(readDisplayPurpose()).toBe('voice');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic' });
});

it('止まっているときに保存が失敗しても、再起動せずに保存値と画面の保持値を戻す', async () => {
    seedPrevious();
    const restore = viRestore();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: false,
        restart: async () => { throw new Error('再起動しない'); },
        save: async config => { await rewritesConfig(config); throw new Error('保存できない'); },
        restore: restore.fn,
    })).rejects.toThrow('保存できない');
    expect(restore.calls).toEqual([{ engine: false, host: 'WASAPI' }]);
});

it('ASIO の入力チャンネルと出力の経路を記録に持ち、再起動と保存へそのまま渡して、無い項目は既定にする', async () => {
    seedPrevious();
    const asio: UsageDeviceRecord = { ...record(), host: 'ASIO', inputChannels: [2, 3], outputRouting: { mode: 'independent', channels: [4, 5] } };
    expect(parseUsageDevice(asio, 'music')).toEqual(asio);
    expect(parseUsageDevice({ ...asio, inputChannels: [2] }, 'music')).toBeNull();
    expect(parseUsageDevice({ ...asio, outputRouting: { mode: 'unknown' } }, 'music')).toBeNull();
    const saved: AudioPreferences[] = [];
    let restartedWith: UsageDeviceRecord | undefined;
    await commitUsageSwitch({
        target: 'music', record: asio, running: true,
        restart: async next => { restartedWith = next; return { sampleRate: 48000, bufferSize: 512 }; },
        save: async config => { saved.push(config); },
        restore: async () => {},
    });
    expect(usageRouting(restartedWith ?? asio)).toEqual({ inputChannels: [2, 3], outputRouting: { mode: 'independent', channels: [4, 5] } });
    expect(saved[0]).toMatchObject({ inputChannels: [2, 3], outputRouting: { mode: 'independent', channels: [4, 5] } });
    expect(readUsageDevices().music).toMatchObject({ inputChannels: [2, 3], outputRouting: { mode: 'independent', channels: [4, 5] } });
    // 経路の無い記録は、前の使い道の経路を引き継がず既定にする。
    const bare: UsageDeviceRecord = { ...record('voice'), host: 'ASIO' };
    expect(preferencesFromUsage(bare)).toMatchObject({ inputChannels: [0, 1], outputRouting: { mode: 'legacy' } });
    expect(usageRouting(record())).toEqual({ inputChannels: [0, 1], outputRouting: { mode: 'independent', channels: [0, 1] } });
});

it('保存済みの ASIO 接続から、経路ごと記録を取り出す', () => {
    const prefs: AudioPreferences = { host: 'ASIO', input: 'Interface', output: 'Interface', sampleRate: 48000, bufferSize: 256, inputSource: deviceInput(), inputChannels: [2, 3], outputRouting: { mode: 'insert' } };
    expect(usageDeviceFromPreferences(prefs, 'voice')).toMatchObject({ inputChannels: [2, 3], outputRouting: { mode: 'insert' } });
    expect(usageDeviceFromPreferences({ ...prefs, host: 'WASAPI' }, 'voice')?.inputChannels).toBeUndefined();
});
it('音声を保存したあと表示の保存に失敗したら、両方を元に戻す', async () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    const previous: AudioPreferences = { host: 'WASAPI', input: 'Mic', output: 'Speakers', sampleRate: 48000, bufferSize: 512, inputSource: deviceInput() };
    localStorage.setItem('vst_host_audio_config', JSON.stringify(previous));
    const restore = viRestore();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
        if (key === 'auralyn_display_purpose') throw new Error('容量不足');
        return original.call(this, key, value);
    };
    try {
        await expect(commitUsageSwitch({
            target: 'music', record: record(), running: false,
            restart: async () => { throw new Error('再起動しない'); },
            save: async config => { localStorage.setItem('vst_host_audio_config', JSON.stringify(config)); },
            restore: restore.fn,
        })).rejects.toThrow('容量不足');
    } finally {
        Storage.prototype.setItem = original;
    }
    expect(readDisplayPurpose()).toBe('voice');
    expect(restore.calls).toEqual([{ engine: false, host: 'WASAPI' }]);
    const restored = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}') as { input?: string };
    expect(restored.input).toBe('Mic');
});

it('止まっているときは再起動せず、成功したら使い道と機器を残す', async () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'Mic', output: 'Speakers', sampleRate: 48000, bufferSize: 512, inputSource: deviceInput() }));
    let restarted = false;
    const applied = await commitUsageSwitch({
        target: 'music', record: record(), running: false,
        restart: async () => { restarted = true; return { sampleRate: 96000, bufferSize: 128 }; },
        save: async config => { localStorage.setItem('vst_host_audio_config', JSON.stringify(config)); },
        restore: async () => { throw new Error('戻さない'); },
    });
    expect(restarted).toBe(false);
    expect(readDisplayPurpose()).toBe('music');
    expect(applied.input).toBe('CABLE Output');
    expect(readUsageDevices().music?.output).toBe('USB Headphones');
    expect(readUsageDevices().voice?.input).toBe('Mic');
});

function viRestore() {
    const calls: { engine: boolean; host: string }[] = [];
    return { calls, fn: async (config: AudioPreferences, engine: boolean) => { calls.push({ engine, host: config.host }); localStorage.setItem('vst_host_audio_config', JSON.stringify(config)); } };
}

const voicePrefs: AudioPreferences = { host: 'WASAPI', input: 'Mic', output: 'Speakers', sampleRate: 48000, bufferSize: 512, inputSource: deviceInput() };
const musicPrefs: AudioPreferences = { host: 'WASAPI', input: 'CABLE Output', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512, inputSource: musicSource };

it('保留した切り替えを確定すると、離れる使い道の記録と表示を残す', () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    commitDisplaySwitch({ display: 'voice', preferences: voicePrefs }, 'music', musicPrefs);
    expect(readDisplayPurpose()).toBe('music');
    expect(readUsageDevices().voice).toMatchObject({ input: 'Mic', output: 'Speakers' });
    expect(readUsageDevices().music).toMatchObject({ input: 'CABLE Output', output: 'USB Headphones' });
});

it('保留した切り替えの確定で、保存した接続の記録を残せなければ、表示も離れる使い道の記録も元へ戻して投げる', () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    const before = JSON.stringify({ version: 1, voice: record('voice'), music: { ...record(), output: 'Old Speakers' } });
    localStorage.setItem(USAGE_DEVICES_KEY, before);
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
        if (key === USAGE_DEVICES_KEY && !failed) { failed = true; throw new Error('容量不足'); }
        return original.call(this, key, value);
    };
    try {
        expect(() => commitDisplaySwitch({ display: 'voice', preferences: voicePrefs }, 'music', musicPrefs)).toThrow('容量不足');
    } finally {
        Storage.prototype.setItem = original;
    }
    expect(readDisplayPurpose()).toBe('voice');
    expect(localStorage.getItem(USAGE_DEVICES_KEY)).toBe(before);
});

it('保留した切り替えの確定で、保存した接続が無いときや記録にできないときは、何も残さず投げる', () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    expect(() => commitDisplaySwitch({ display: 'voice', preferences: voicePrefs }, 'music', null)).toThrow('使い道の機器を保存できません');
    expect(() => commitDisplaySwitch({ display: 'voice', preferences: voicePrefs }, 'music', { ...musicPrefs, output: undefined })).toThrow('使い道の機器を保存できません');
    expect(readDisplayPurpose()).toBe('voice');
    expect(localStorage.getItem(USAGE_DEVICES_KEY)).toBeNull();
});

it('保留した切り替えの確定で表示を残せなければ、離れる使い道の記録も元へ戻して投げる', () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
        if (key === 'auralyn_display_purpose') throw new Error('容量不足');
        return original.call(this, key, value);
    };
    try {
        expect(() => commitDisplaySwitch({ display: 'voice', preferences: voicePrefs }, 'music', musicPrefs)).toThrow('容量不足');
    } finally {
        Storage.prototype.setItem = original;
    }
    expect(readDisplayPurpose()).toBe('voice');
    expect(localStorage.getItem(USAGE_DEVICES_KEY)).toBeNull();
});

it('どちらの記録も無い利用者が初めて音楽鑑賞のセットアップを終えると、離れる配信の接続も記録する', () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    localStorage.setItem('vst_host_audio_config', JSON.stringify(voicePrefs));
    const leaving = currentUsage();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(musicPrefs));
    rememberSetupUsage('music', leaving);
    expect(readDisplayPurpose()).toBe('music');
    expect(readUsageDevices().music).toMatchObject({ input: 'CABLE Output', output: 'USB Headphones' });
    expect(readUsageDevices().voice).toMatchObject({ input: 'Mic', output: 'Speakers' });
});

it('離れる接続を渡さない、または同じ使い道のままのセットアップは、もう一方の記録を作らない', () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    localStorage.setItem('vst_host_audio_config', JSON.stringify(voicePrefs));
    rememberSetupUsage('voice', currentUsage());
    expect(readUsageDevices().music).toBeUndefined();
    expect(readUsageDevices().voice).toMatchObject({ input: 'Mic' });
    localStorage.removeItem(USAGE_DEVICES_KEY);
    rememberSetupUsage('voice');
    expect(readUsageDevices().music).toBeUndefined();
});

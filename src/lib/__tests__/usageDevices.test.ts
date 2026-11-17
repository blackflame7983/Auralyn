import { afterEach, expect, it } from 'vitest';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { deviceInput, type InputSource } from '@/lib/inputSource';
import type { AudioPreferences } from '@/lib/audioPreferences';
import { parseUsageDevice, readUsageDevices, USAGE_DEVICES_KEY, usageDeviceFromPreferences, writeUsageDevice, type UsageDeviceRecord } from '@/lib/usageDevices';
import { commitUsageSwitch } from '@/lib/usageSwitch';

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

it('切り替えに失敗したら表示を変えず、保存済みの音声設定を戻す', async () => {
    localStorage.setItem('auralyn_display_purpose', 'voice');
    const previous: AudioPreferences = { host: 'WASAPI', input: 'Mic', output: 'Speakers', sampleRate: 48000, bufferSize: 512, inputSource: deviceInput() };
    localStorage.setItem('vst_host_audio_config', JSON.stringify(previous));
    const restore = viRestore();
    await expect(commitUsageSwitch({
        target: 'music', record: record(), running: true,
        restart: async () => ({ sampleRate: 48000, bufferSize: 512 }),
        save: async () => { throw new Error('保存できない'); },
        restore: restore.fn,
    })).rejects.toThrow('保存できない');
    expect(readDisplayPurpose()).toBe('voice');
    expect(restore.calls).toEqual([]);
    expect(readUsageDevices().music).toBeUndefined();
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
    expect(restore.calls).toEqual([{ running: false, host: 'WASAPI' }]);
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
    const calls: { running: boolean; host: string }[] = [];
    return { calls, fn: async (config: AudioPreferences, running: boolean) => { calls.push({ running, host: config.host }); localStorage.setItem('vst_host_audio_config', JSON.stringify(config)); } };
}

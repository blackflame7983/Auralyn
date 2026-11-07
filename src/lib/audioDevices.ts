import type { AudioDevice } from '@/api/audio';

export const displayAudioHost = (host: string) => {
    const known = host.trim().toLowerCase();
    return known === 'wasapi' ? 'WASAPI' : known === 'asio' ? 'ASIO' : host;
};

export const isPlaybackInput = (name: string) => /cable|voicemeeter|stereo\s*mix|ステレオ\s*ミキサー|再生リダイレクト|loopback|ループバック|what\s*u\s*hear|wave\s*out/i.test(name);

// 不明・複数の既定を先頭候補で補わず、入力は再生音の取り込みを除外する。
export function defaultAudioDevice(devices: AudioDevice[], input: boolean): AudioDevice | undefined {
    const defaults = devices.filter(device => device.is_default && (!input || !isPlaybackInput(device.name)));
    const device = defaults.length === 1 ? defaults[0] : undefined;
    return device && (device.id || devices.filter(other => other.name === device.name).length === 1) ? device : undefined;
}

// IDが双方にある場合はIDで照合し、片側にない場合だけ一意な名前へ戻す。
export function resolveAudioDevice(devices: AudioDevice[], host: string, name?: string | null, id?: string | null) {
    const candidates = devices.filter(device => device.host.toLowerCase() === host.toLowerCase());
    const exact = id ? candidates.find(device => device.id === id) : undefined;
    if (exact) return exact;
    const matches = candidates.filter(device => device.name === name);
    return matches.length === 1 && (!id || !matches[0].id) ? matches[0] : undefined;
}
export const connectionDeviceKey = (host: string, device?: Pick<AudioDevice, 'id' | 'name'>) =>
    host && device ? `${host.toLowerCase()}\u0000${device.id ?? device.name}` : '';

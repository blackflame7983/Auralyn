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

import { deviceDisplayName } from '@/lib/audioRouting';

// 上の帯の音の経路。機器名は短い表示名にし、未設定（入力か出力が空）のときは出さない。
// 音楽鑑賞は再生元 → 出力。配信・通話は送り先が分かるときだけ末尾に足す。
export function formatAudioRoute(input: string | undefined, output: string | undefined, destination: string | undefined, music: boolean): string | null {
    const from = input ? deviceDisplayName(input).trim() : '';
    const to = output ? deviceDisplayName(output).trim() : '';
    if (!from || !to) return null;
    if (music || !destination) return `${from} → ${to}`;
    return `${from} → ${to} → ${destination}`;
}

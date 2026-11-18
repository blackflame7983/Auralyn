import { deviceDisplayName } from '@/lib/audioRouting';
import { ROUTE_JOIN } from '@/lib/routeFit';

// 上の帯の音の経路。機器名は短い表示名にし、未設定（入力か出力が空）のときは出さない。
// 音楽鑑賞は再生元 → 出力。配信・通話は送り先が分かるときだけ末尾に足す。
export function formatAudioRoute(input: string | undefined, output: string | undefined, destination: string | undefined, music: boolean): string | null {
    const from = input ? deviceDisplayName(input).trim() : '';
    const to = output ? deviceDisplayName(output).trim() : '';
    if (!from || !to) return null;
    if (music || !destination) return `${from}${ROUTE_JOIN}${to}`;
    return `${from}${ROUTE_JOIN}${to}${ROUTE_JOIN}${destination}`;
}

// 送り先の表示。受け側の名前があれば「 · 」でつなぐ。短い形は、帯が狭いときに全文の代わりに出す（長い順）。
export function routeDestination(label: string, shortLabel: string, receiver: string): { full: string; compact: string[] } {
    const suffix = receiver ? ` · ${receiver}` : '';
    const compact = [`${shortLabel}${suffix}`, shortLabel].filter((form, index, all) => form !== `${label}${suffix}` && all.indexOf(form) === index);
    return { full: `${label}${suffix}`, compact };
}

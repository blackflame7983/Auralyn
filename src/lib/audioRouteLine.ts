import type { MessageKey } from '@/i18n/messages';
import { deviceDisplayName } from '@/lib/audioRouting';
import type { PreparationUse } from '@/lib/preparation';
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

// 送り先の用途ごとの名前。上の帯の経路と、接続の確認の図は、同じ形を使う。自分の声を聴くときは受け側の名前を添えない。
const usageDestinationKeys: Record<PreparationUse, { full: MessageKey; short: MessageKey }> = {
    obs: { full: 'prep.obs', short: 'prep.obsShort' },
    discord: { full: 'prep.call', short: 'prep.callShort' },
    other: { full: 'prep.other', short: 'prep.otherShort' },
    listening: { full: 'prep.local', short: 'prep.localShort' },
};
export function usageDestination(t: (key: MessageKey) => string, usage: PreparationUse, receiver: string) {
    const keys = usageDestinationKeys[usage];
    return routeDestination(t(keys.full), t(keys.short), usage !== 'listening' ? receiver.trim() : '');
}

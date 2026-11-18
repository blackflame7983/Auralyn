// 上の帯の経路を区切る記号。formatAudioRoute と同じ並びにする。
export const ROUTE_JOIN = ' → ';

export function routeSegments(route: string): string[] {
    return route.split(ROUTE_JOIN).filter(part => part.length > 0);
}

export interface RouteFit {
    // 先頭から隠す区切りの個数。幅が足りていれば 0。
    hidden: number;
    // 送り先の表示。0 は全文、1 以降は短い形の候補（長い順）の何番目か。
    variant: number;
    // どの形でも入らず、最も短い形を末尾で省略するとき。
    clipped: boolean;
}

const FITS: RouteFit = { hidden: 0, variant: 0, clipped: false };

function span(widths: readonly number[], separator: number): number {
    return widths.length === 0 ? 0 : widths.reduce((sum, width) => sum + width, 0) + separator * (widths.length - 1);
}

// 経路を、送り先（最後の区切り）を切らずに収める。
// 1) 全文。2) 先頭から区切りを「…」に替えて、送り先を全文で残す。
// 3) それでも入らなければ、機器名を「…」に替えたまま送り先を短い形にする（長い順）。
// 4) 最も短い形でも入らないときだけ、その形を末尾で省略する。
// widths は区切りごとの幅、compact は送り先の短い形の幅（長い順）。
export function fitRoute(widths: readonly number[], compact: readonly number[], separator: number, ellipsis: number, available: number): RouteFit {
    const count = widths.length;
    if (count <= 1 || available < 1) return FITS;
    if (span(widths, separator) <= available) return FITS;
    const lead = widths.slice(0, count - 1);
    const last = widths[count - 1] ?? 0;
    for (let hidden = 1; hidden < count; hidden += 1) {
        const rest = [...lead.slice(hidden), last];
        if (ellipsis + separator + span(rest, separator) <= available) return { hidden, variant: 0, clipped: false };
    }
    const hidden = count - 1;
    for (let index = 0; index < compact.length; index += 1) {
        if (ellipsis + separator + (compact[index] ?? 0) <= available) return { hidden, variant: index + 1, clipped: false };
    }
    return { hidden, variant: compact.length, clipped: true };
}

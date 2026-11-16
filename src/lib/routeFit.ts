// 上の帯の経路を区切る記号。formatAudioRoute と同じ並びにする。
export const ROUTE_JOIN = ' → ';

export function routeSegments(route: string): string[] {
    return route.split(ROUTE_JOIN).filter(part => part.length > 0);
}

// 入りきらない区切りは先頭から隠す。最後の区切り（送り先）は残す。
// 返す数は、先頭から隠す区切りの個数。幅が足りていれば 0。
export function hiddenRoutePrefix(widths: readonly number[], separator: number, ellipsis: number, available: number): number {
    const count = widths.length;
    if (count <= 1 || available < 1) return 0;
    const total = widths.reduce((sum, width) => sum + width, 0) + separator * (count - 1);
    if (total <= available) return 0;
    let hidden = 0;
    for (let index = 0; index < count - 1; index += 1) {
        const rest = widths.slice(index + 1);
        const restWidth = rest.reduce((sum, width) => sum + width, 0) + separator * (rest.length - 1);
        if (ellipsis + separator + restWidth <= available) return index + 1;
        hidden = index + 1;
    }
    return hidden;
}

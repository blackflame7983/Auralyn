/** ウィンドウの寸法は論理px、座標と作業領域は物理px。 */
export type DisplayPurpose = 'voice' | 'music';
export interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
    /** 保存時の表示倍率。旧形式の保存値では省略される。 */
    scale?: number;
}
export interface WorkArea {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}
export interface FrameSize { width: number; height: number }
export interface WindowPlan {
    minWidth: number;
    minHeight: number;
    bounds: WindowBounds;
}

export const WINDOW_POLICY: Record<DisplayPurpose, { minWidth: number; minHeight: number; initialWidth: number; initialHeight: number }> = {
    voice: { minWidth: 960, minHeight: 640, initialWidth: 1024, initialHeight: 768 },
    music: { minWidth: 900, minHeight: 600, initialWidth: 1024, initialHeight: 768 },
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 保存値は任意のlocalStorageから来るため、範囲外・壊れた値を復元しない。 */
export function parseWindowBounds(value: unknown): WindowBounds | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (!finite(v.x) || !finite(v.y) || !finite(v.width) || !finite(v.height)
        || Math.abs(v.x) > 100000 || Math.abs(v.y) > 100000
        || v.width < 1 || v.width > 10000 || v.height < 1 || v.height > 10000
        || typeof v.maximized !== 'boolean'
        || (v.scale !== undefined && (!finite(v.scale) || v.scale < 0.25 || v.scale > 8))) return null;
    return { x: v.x, y: v.y, width: v.width, height: v.height, maximized: v.maximized,
        ...(v.scale === undefined ? {} : { scale: v.scale as number }) };
}

/** 接続中モニターから保存位置と最大限重なるものを選び、消失時は最も近いものへ戻す。 */
export function selectWorkArea(areas: WorkArea[], bounds: WindowBounds, fallbackScale = 1): WorkArea | null {
    const usable = areas.filter(a => finite(a.x) && finite(a.y) && a.width > 0 && a.height > 0 && a.scale > 0);
    if (!usable.length) return null;
    const sourceScale = bounds.scale ?? fallbackScale;
    const score = (area: WorkArea) => {
        // 候補モニターごとに倍率を変えると同じウィンドウの矩形が変わる。
        const right = bounds.x + bounds.width * sourceScale;
        const bottom = bounds.y + bounds.height * sourceScale;
        const overlap = Math.max(0, Math.min(right, area.x + area.width) - Math.max(bounds.x, area.x))
            * Math.max(0, Math.min(bottom, area.y + area.height) - Math.max(bounds.y, area.y));
        const centerX = bounds.x + bounds.width * sourceScale / 2;
        const centerY = bounds.y + bounds.height * sourceScale / 2;
        const dx = Math.max(area.x - centerX, 0, centerX - (area.x + area.width));
        const dy = Math.max(area.y - centerY, 0, centerY - (area.y + area.height));
        return { overlap, distance: dx * dx + dy * dy };
    };
    return usable.reduce((best, area) => {
        const a = score(area), b = score(best);
        return a.overlap > b.overlap || (a.overlap === b.overlap && a.distance < b.distance) ? area : best;
    });
}

/** ウィンドウの装飾分も含め、利用可能領域を超える下限を設定しない。 */
export function planWindow(bounds: WindowBounds, purpose: DisplayPurpose, area: WorkArea, frame: FrameSize): WindowPlan {
    const scale = area.scale;
    const maxWidth = Math.max(1, (area.width - Math.max(0, frame.width)) / scale);
    const maxHeight = Math.max(1, (area.height - Math.max(0, frame.height)) / scale);
    const minWidth = Math.min(WINDOW_POLICY[purpose].minWidth, maxWidth);
    const minHeight = Math.min(WINDOW_POLICY[purpose].minHeight, maxHeight);
    const width = Math.min(maxWidth, Math.max(minWidth, bounds.width));
    const height = Math.min(maxHeight, Math.max(minHeight, bounds.height));
    const outerWidth = width * scale + Math.max(0, frame.width);
    const outerHeight = height * scale + Math.max(0, frame.height);
    return {
        minWidth, minHeight,
        bounds: {
            x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - outerWidth))),
            y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - outerHeight))),
            width, height, maximized: bounds.maximized,
            ...(bounds.scale === undefined ? {} : { scale: area.scale }),
        },
    };
}

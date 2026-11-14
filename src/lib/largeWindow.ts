/** 段階 H の仮の寸法。実機（WebView2）で測ってから、この定数と `src/index.css` の同じ数値、`docs/DESIGN.md` 10.8 を一緒に変える。 */
export const largeWindow = {
    /** ホームの2段目を出す窓の高さ（px）。`@media (min-height)` と一致させる。 */
    tier2MinHeight: 860,
    /** ホームの接続の列を出す窓の幅（px）。`@media (min-width)` と一致させる。 */
    connectColumnMinWidth: 1400,
    /** ページを2列にする、ページの幅（px）。コンテナクエリと一致させる。 */
    pageColumnsMinWidth: 1100,
    /** 1列のときの home-content の上限（px）。 */
    homeContentMax: 1180,
    /** 接続の列があるときの home-content の上限（px）。 */
    homeContentWideMax: 1480,
    scaleBasisWidth: 1700,
    scaleBasisHeight: 960,
    scaleMin: 1,
    scaleMax: 1.5,
    /** 倍率を丸める単位。 */
    scaleStep: 0.01,
} as const;

/** floating-ui が出す translate は見た目の座標。html の zoom が重ねて掛ける前に、倍率で割る。 */
export function unzoomTranslate(transform: string, zoom: number): string {
    if (!Number.isFinite(zoom) || zoom === 1) return transform;
    return transform.replace(/translate\(\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/g, (_match, x: string, y: string) => `translate(${Number(x) / zoom}px, ${Number(y) / zoom}px)`);
}

/** ドラッグの移動量も見た目の座標なので、同じように割る。zoom が 1 のときは変えない。 */
export function unzoomDrag(transform: { x: number; y: number }, zoom: number): { x: number; y: number } {
    if (!Number.isFinite(zoom) || zoom === 1) return transform;
    return { ...transform, x: transform.x / zoom, y: transform.y / zoom };
}

/** `min(幅 / 基準幅, 高さ / 基準高さ)` を下限〜上限に収め、刻みごとに丸める。基準より小さい窓は 1。 */
export function uiScale(width: number, height: number): number {
    const raw = Math.min(width / largeWindow.scaleBasisWidth, height / largeWindow.scaleBasisHeight);
    const clamped = Math.min(largeWindow.scaleMax, Math.max(largeWindow.scaleMin, raw));
    const inverse = 1 / largeWindow.scaleStep;
    return Math.round(clamped * inverse) / inverse;
}

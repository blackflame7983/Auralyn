/** 次の描画のあとに1回だけ動かす。呼び出し側は解除関数を保持できる。 */
export function afterFrame(run: () => void): () => void {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
}

/** 指定時間のあと1回だけ動かす。待ちのあいだに解除すると動かない。 */
export function delay(ms: number, run: () => void): () => void {
    const id = window.setTimeout(run, ms);
    return () => window.clearTimeout(id);
}

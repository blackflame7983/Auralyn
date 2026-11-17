// 既存の待ちと周期を、コンポーネントの外へ移す。間隔と解除の意味は変えない。

export function delay(ms: number, run: () => void): () => void {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
}

export function every(ms: number, run: () => void): () => void {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
}

export function afterFrame(run: () => void): () => void {
    const frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
}

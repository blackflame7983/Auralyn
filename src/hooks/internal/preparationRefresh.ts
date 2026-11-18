// 準備状態の定期取得。間隔の所有者はここだけにし、表示側から生タイマーを呼ばない。
export function startPreparationRefresh(refresh: () => void): () => void {
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
}

/** 出力音量・ミュートの変化から取り直すときの最短の間隔。スライダーの連続操作で取り直しを連打しない。 */
export const OUTPUT_CHANGE_GAP_MS = 200;

/**
 * 変化の通知を、先頭はすぐ、続く通知は間隔の終わりに1回へまとめて実行する。
 * 実行のたびに最新の状態を読むので、まとめた通知の途中の値は読まなくてよい。
 */
export function createOutputChangeScheduler(run: () => void, gapMs: number = OUTPUT_CHANGE_GAP_MS) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = Number.NEGATIVE_INFINITY;
    const fire = () => { timer = null; lastRun = Date.now(); run(); };
    return {
        request() {
            if (timer !== null) return;
            const wait = Math.min(gapMs, lastRun + gapMs - Date.now());
            if (wait <= 0) fire(); else timer = setTimeout(fire, wait);
        },
        cancel() { if (timer !== null) clearTimeout(timer); timer = null; },
    };
}

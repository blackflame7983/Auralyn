// 実行中の経過時間。開始時刻が分からないときは出さない（呼び出し側が null を渡す）。
// 1時間未満は MM:SS、それ以上は HH:MM:SS。推測で埋めない。

export function formatElapsed(startedAt: number, now: number): string | null {
    if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null;
    const elapsed = Math.floor((now - startedAt) / 1000);
    if (elapsed < 0) return null;
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const pad = (value: number) => String(value).padStart(2, '0');
    if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    return `${pad(minutes)}:${pad(seconds)}`;
}

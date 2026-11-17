// 準備状態の定期取得。間隔の所有者はここだけにし、表示側から生タイマーを呼ばない。
export function startPreparationRefresh(refresh: () => void): () => void {
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
}

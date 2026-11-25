# GPUI 移行の決定

GPUI で画面を作り直すときの、理由つきの決定。新しい決定は上に足し、取り消すときは消さずに取り消しの理由を書く。
書き方の知見は [knowledge.md](knowledge.md)。移行の分岐点は [audio-session-controller.md](../plans/audio-session-controller.md) 13.2（J-11）。

| 日付 | 決定 | 理由 |
| :--- | :--- | :--- |
| 2026-11-25 | 画面の振る舞いの規則（メーターの読み・一言の判定など）は、GPUI に依存しない `auralyn-ui-model` に置く。部品はその結果を描くだけにする | GPUI なしの `cargo test` で確かめられ、AI や人が部品を直すときに読む範囲が小さくなる。GPUI の判定が通ったら `src-tauri/crates/` へ移す |
| 2026-11-25 | 依存の向きは アプリ → 部品（GPUI）→ 振る舞い・トークン → `auralyn-core` の一方向にし、クレートの境界で守る | 逆向きの依存を Lint ではなく `cargo` で防げる |
| 2026-11-25 | 試作は main に入れず、別のブランチだけに置く。main は Tauri の構成のまま | J-11 の分岐点の方針 |
| 2026-11-25 | GPUI の判定が通れば Tauri は捨てる。TypeScript 側との共存は、GPUI の動作や検証にどうしても必要な箇所だけ考える | 利用者の方針 |

# GPUI 移行の決定

GPUI で画面を作り直すときの、理由つきの決定。新しい決定は上に足し、取り消すときは消さずに取り消しの理由を書く。
書き方の知見は [knowledge.md](knowledge.md)。移行の分岐点は [audio-session-controller.md](../plans/audio-session-controller.md) 13.2（J-11）。

| 日付 | 決定 | 理由 |
| :--- | :--- | :--- |
| 2026-11-25 | GPUI 版を `src-gpui/` として main に入れ、本実装を始める。振る舞いの規則は `src-tauri/crates/auralyn-ui-model` へ移す。`src-gpui` は `src-tauri` と別のワークスペースのまま、ビルド領域は `src-tauri/target` を共有する | 試作の判定（[gpui-prototype-checklist](../plans/gpui-prototype-checklist.md)）で13項目中 合格10・条件付き3・不合格0。利用者が作る方向へ進めると決めた。別のワークスペースにするのは、GPUI の依存で Tauri 版の `Cargo.lock` とビルドを変えないため |
| 2026-11-25 | 色・角丸は `design/tokens.json` を `auralyn-core` 経由で読み、GPUI の側に値を書かない | 手で写すとトークンとのずれを検出できない。正本を JSON 側へ移すか（`index.css` を生成物にするか）は未決 |
| 2026-11-25 | 画面の振る舞いの規則（メーターの読み・一言の判定など）は、GPUI に依存しない `auralyn-ui-model` に置く。部品はその結果を描くだけにする | GPUI なしの `cargo test` で確かめられ、AI や人が部品を直すときに読む範囲が小さくなる。GPUI の判定が通ったら `src-tauri/crates/` へ移す（2026-11-25 に移した） |
| 2026-11-25 | 依存の向きは アプリ → 部品（GPUI）→ 振る舞い・トークン → `auralyn-core` の一方向にし、クレートの境界で守る | 逆向きの依存を Lint ではなく `cargo` で防げる |
| 2026-11-25 | （取り消し：同日、上の `src-gpui/` の決定で置き換えた）試作は main に入れず、別のブランチだけに置く。main は Tauri の構成のまま | J-11 の分岐点の方針。判定が済んだので取り消した |
| 2026-11-25 | GPUI の判定が通れば Tauri は捨てる。TypeScript 側との共存は、GPUI の動作や検証にどうしても必要な箇所だけ考える | 利用者の方針 |

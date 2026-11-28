# Auralyn (.gemini)

共通の作業入口はルート `AGENTS.md`。モデル名・世代にかかわらず、その参照先の現行方針を適用する。

## ブランチ

- 開発の主軸は `main`。新機能や修正は `codex/` プレフィックスのブランチで作業し、`main` へ直接コミットしない。
- push・PR作成前に差分と検証結果を提示し、明示承認を待つ。

## バージョン

- 判定・タグ・反映の正本は `docs/VERSIONING.md`（版の値は直下 `Cargo.toml` の `[workspace.package] version`）。
- AIは前回公開版からの全差分・互換性・検証結果から番号を提案し、提案だけでタグ作成や公開は行わない。

## 構成

- 画面は `src-gpui/`（GPUI Kit）。書き方は `docs/gpui/knowledge.md`、決定は `docs/gpui/decisions.md`。
- 中核は `crates/vst-host`（音声エンジン・VST3 スキャナーのサイドカーと JSON-RPC）、画面の規則は `crates/auralyn-ui-model`、文言とデザイントークンは `crates/auralyn-core`。
- 音声コールバックの無割当・非ブロッキング方針を維持する。

## スキル

`.agent/skills` に、version-management・secure-coding などのスキルがある。

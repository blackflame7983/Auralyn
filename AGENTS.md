# Auralyn の作業入口

## 正本と適用範囲

- 共通作業方針に加え、`.agent/rules/core_rules.md` と `docs/CODING_GUIDELINES.md` を守る。
- バージョン判定・タグ・リリース提案の正本は [docs/VERSIONING.md](docs/VERSIONING.md)。バージョンに関する旧スキルやモデル別説明より優先する。
- 配布条件は `docs/RELEASE_PLAN.md`、`SOURCE-DISTRIBUTION.md`、`config/release-policy.json` を参照する。
- ビルドと検証は `docs/BUILD_GUIDE.md` と `docs/TESTING.md`。依存更新の判断は `docs/DEPENDENCY_MAINTENANCE.md`。
- `docs/plans/` の計画や過去のチェック済み記録を、現在の実装・検証済みの証拠として扱わない。

## 作業の進め方

- 開始時に Git 状態を確認し、目的別の `codex/` ブランチで作業する。既存の未コミット・未追跡・ignored ファイルを保護する。
- 日本語で説明し、調査と実装、ローカル確認と実機・公開確認を区別する。
- モデル名・世代を規約へ固定しない。利用するモデルにかかわらず、現行コード・公式文書・実行結果で判断する。
- 小さく検証可能な変更に分ける。依存のメジャー更新や音声処理の置換を、規約整理に混ぜない。
- JSON-RPC、サイドカー分離、音声コールバックの無割当・非ブロッキング方針を維持する。
- リリース相談時は前回公開版からの全差分を確認し、`VERSIONING.md` の形式で番号・理由・互換性・未検証事項を提案する。コミット接頭辞だけで自動判定しない。
- `git push` と PR 作成の前に差分と検証結果を示し、明示承認を待つ。タグ作成・公開・デプロイも対象が明示された許可の範囲で行う。

# Auralyn の作業入口

## 最初に確認すること

- 現在のGit状態と実装を確認し、目的別の`codex/`ブランチで作業する。未コミット・未追跡・ignoredファイルと別作業の成果物を保護する。
- 機能から探すときは[feature-map](docs/feature-map.md)、設計は[CODING_GUIDELINES](docs/CODING_GUIDELINES.md)、検査の詳細は[GARDENING](docs/GARDENING.md)を読む。
- バージョン判定・タグ・リリース提案の正本は [docs/VERSIONING.md](docs/VERSIONING.md)。バージョンに関する旧スキルやモデル別説明より優先する。
- 配布条件は `docs/RELEASE_PLAN.md`、`SOURCE-DISTRIBUTION.md`、`config/release-policy.json` を参照する。
- ビルドと検証は `docs/BUILD_GUIDE.md` と `docs/TESTING.md`。依存更新の判断は `docs/DEPENDENCY_MAINTENANCE.md`。
- 利用者向けドキュメント（`user-docs/`、アプリのヘルプ、公式サイトへの同期）の正本は [docs/USER_DOCS.md](docs/USER_DOCS.md)。
- `docs/plans/` の計画や過去のチェック済み記録を、現在の実装・検証済みの証拠として扱わない。

## GPUI で画面を作るとき

- 基準：GPUI Kit 0.11.0（`gpui-pre` 0.3.14、`gpui-component` 0.11.0）、Windows 10/11。ほかの版や Zed 本体の `gpui` の API を書かない。API は記憶や例ではなく、この版の依存クレートのソースで確かめる。
- 分からないことは推測で実装しない。未決の問いとして挙げる。
- 画面は `src-gpui/`（`src-tauri` とは別のワークスペース）。書き方と落とし穴は [docs/gpui/knowledge.md](docs/gpui/knowledge.md)、理由つきの決定は [docs/gpui/decisions.md](docs/gpui/decisions.md)。作って分かったことはここへ足す。
- 振る舞いの規則（メーターの読み・判定など）は GPUI に依存しない `src-tauri/crates/auralyn-ui-model` に置き、`cargo test` で確かめる。部品は描くだけにする。
- GPUI 版の確認は Windows の実機で行い、確かめ方は [src-gpui/README.md](src-gpui/README.md)。実機の合否は、確かめた日・手順・結果を PR に書く。クラウドでの型検査の成功を実機の合格にしない。Tauri 版は GPUI 版が置き換えるまで main で動くまま保つ。

## 作業の進め方

- 開始時に Git 状態を確認し、目的別の `codex/` ブランチで作業する。既存の未コミット・未追跡・ignored ファイルを保護する。
- 日本語で説明し、調査と実装、ローカル確認と実機・公開確認を区別する。
- 調査・説明・レビューの依頼では、変更も求められていない限り編集しない。実装依頼は許可済みの変更と関連検証まで完了する。
- モデル名・世代を規約へ固定しない。利用するモデルにかかわらず、現行コード・公式文書・実行結果で判断する。
- 小さく検証可能な変更に分ける。依存のメジャー更新や音声処理の置換を、規約整理に混ぜない。
- ビルド開始前と作業完了時は [ビルド領域・容量管理](docs/BUILD_GUIDE.md#ビルド領域容量管理) に従う。既存領域の再利用を先に検討し、専用領域を増やす場合は保持理由と終了後の整理を決める。
- PowerShell での作業の注意は [BUILD_GUIDE](docs/BUILD_GUIDE.md#エージェントが-powershell-で作業するときの注意) の該当の節に従う。
- JSON-RPC、サイドカー分離、音声コールバックの無割当・非ブロッキング方針を維持する。
- リリース相談時は前回公開版からの全差分を確認し、`VERSIONING.md` の形式で番号・理由・互換性・未検証事項を提案する。コミット接頭辞だけで自動判定しない。
- `git push` と PR 作成の前に差分と検証結果を示し、明示承認を待つ。タグ作成・公開・デプロイも対象が明示された許可の範囲で行う。
- PR前の独立レビューを維持する。実装依頼だけからpush・PR・マージ・公開を推測しない。
- 破壊的操作・課金・外部サービスへの書き込みは、対象が許可された範囲だけで行う。資格情報や個人情報を出力・ログ・コミットへ含めない。

## ガードを迂回しない

- タスクを通すためにLint・型・テスト・CIの設定や検査対象を緩めない。検査器自体の変更は目的と影響を提示し、人間の明示許可を得る。
- 人間の許可なく`eslint-disable`、`@ts-ignore`、`@ts-expect-error`、`# noqa`、`# type: ignore`、Rustの`allow/expect`、テストのskipを新規追加しない。
- 既存違反の指紋を更新して追認しない。編集した宣言の違反を修正し、不要な例外を取り除く。例外の扱いは[GARDENING](docs/GARDENING.md)に従う。
- コードで表現できることをコメントで説明しない。ハックを正当化せず、状態設計・完了通知・責務の分離で原因を直す。仕様・数学的根拠、公開API、`SAFETY:`、ライセンスの説明は保つ。
- 人間から修正指示を受けたら、修正とともに、Lint・型・テストで再発を防ぐ方法を必ず1つ提案する。

## 実装後の確認

- 未コミット変更は`npm run verify -- --changed`。コミット済みの機能は`--feature <名前>`、全フロント検証は`--full`。静的検査だけなら`--static`。
- Tauri 版の画面の変更は[feature-map](docs/feature-map.md)に対応する`--feature <名前> --browser`または該当Playwright試験で確認する（CIでは回らない）。GPUI 版は`--rust`と実機で確かめる。どちらも実行時例外・フォーカス・狭い窓・日英を確認する。
- Rust変更はビルド領域を確認して`npm run verify -- --static --rust`。RT変更は既存の無割当・解放・状態遷移試験も確認する。検査の成功を実音声・聴感・長時間運転の合格にしない。
- 複雑なUI・非同期フローを変えたら、ユーザー視点のMermaid状態遷移図を差分説明に示す。イベント・失敗・取消・再試行を明示し、図だけを動作の証拠にしない。
- 関連する必須検査の成功後は、新しい差分・失敗・未解決の懸念がなければ同じ検査を繰り返さない。
- 実行した確認、失敗、未実施事項、残るリスクを区別して報告する。

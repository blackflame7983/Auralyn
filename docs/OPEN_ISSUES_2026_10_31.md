# 未解決Issueの対応記録（2026-10-31）

GitHubのOpen Issue全13件を現行ソースと照合した。作業ブランチは `codex/open-issues-20261031`。この記録はローカル実装完了時点の実装・検証結果であり、マージ・配布・実機受入の完了を意味しない。以下の実装記録時点ではGitHubへのコメント、Issue更新・クローズ、push、PR作成は行っていない。

## Issueごとの結果

| Issue | 今回の結果 | 残る条件 |
| --- | --- | --- |
| [#150](https://github.com/blackflame7983/Auralyn/issues/150) | ファイル不在をHostで判別し、名前・影響の確認、原文と固有プロファイルのバックアップ後に明示保存して保護解除する出口を実装。アクセス失敗は不在扱いしない。保存原文・実ラック・世代・state・保存失敗を検証し、通常の音声やVSTを操作せず保存する | 実Tauriで削除・移動したVST、再起動、自動保存再開、バックアップからの復元の受入。移動先の指定は未実装 |
| [#151](https://github.com/blackflame7983/Auralyn/issues/151) | 現行契約を調査し、[一体切替案](plans/LIVE_MODE_VST_TRANSACTION.md)へ必要なEngine/Host契約と受入を記録。機能は未実装 | 無音成立ACK、出力世代隔離、全件復元と内蔵処理完了、永続復旧原本、停止・緊急ミュート優先を実装・検証する必要がある |
| [#152](https://github.com/blackflame7983/Auralyn/issues/152) | ホームとVSTパネルを同じ中央領域へ配置し、間の余白を外側へ移動。最大幅と予約幅を同じ時間で遷移させる。即時操作・低減設定を維持 | Windows実ウィンドウ最大化・実DPIでの受入 |
| [#153](https://github.com/blackflame7983/Auralyn/issues/153) | 常設説明を1行へ整理し、対象範囲を既存情報ボタンへ移動。雑談の残響ONは明示確認後、登録用コピーだけOFF。保存成功後にもう片方を調整する入口を表示 | 実Tauriでの登録・再起動・実音声の受入 |
| [#154](https://github.com/blackflame7983/Auralyn/issues/154) | 最後のクリップから10秒で警告色を弱め、記録は手動解除まで保持。経過秒数を表示。入力・フッター・大型メーターへ共通適用 | 実音声のクリップと実画面での視認性 |
| [#155](https://github.com/blackflame7983/Auralyn/issues/155) | 音切れの日本語表示を最後のカウンタ増加から10秒保持し、クリックで詳細へ移動。詳細を10秒以上見た後も常設入口へフォーカス復帰 | 実際の音切れとの対応・実画面・読み上げ |
| [#156](https://github.com/blackflame7983/Auralyn/issues/156) | 大型メーターが隠れる間だけ入口の印とVSTパネル内の説明を表示。操作不可のホームだけに説明を置かない。実バー高に合わせ目盛りを間引き、20px以上の文字間隔を確保 | 実Tauri・実DPIでの表示受入 |
| [#98](https://github.com/blackflame7983/Auralyn/issues/98) | 未作成・失効の個別理由は現行コードに実装済み。NR・内蔵処理・固定ゲインの理由と未知時の扱いを再確認し、DOM14件とRust3件が成功。新規の実装変更なし | 実機・読み上げ・再起動・異常終了・OBS等の受入が残るためIssue全体の完了ではない |
| [#109](https://github.com/blackflame7983/Auralyn/issues/109) | 現行のホーム・パネル・大型メーターのブラウザモック検証を追加。#152/#156の改善を実装 | 実Windowsの用途別復元、実VST GUI、実DPI、Narrator、音声経路と受け側の確認 |
| [#111](https://github.com/blackflame7983/Auralyn/issues/111) | 既存の音楽用途・仮想ケーブル導線・方式調査とIssueの実施順を確認 | 仮想ケーブル経路の実機受入と、二重再生・自己循環を防げる直接取り込み方式の限定検証が先に必要。直接取り込みは未実装 |
| [#93](https://github.com/blackflame7983/Auralyn/issues/93) | 時間を合わせた現行NR/DeepFilterNet3比較の受入条件を確認。既定NRの置換は行っていない | 同条件のモデル・使用許諾のある素材による音質・CPU・遅延比較、実機・聴感が未実施。採否は未決定 |
| [#72](https://github.com/blackflame7983/Auralyn/issues/72) | 実機・実Host・聴感・アクセシビリティの集約条件を確認 | WASAPI/ASIO、OBS、実DPI/Narrator、許諾音声、長時間運転等の手動受入。今回の自動試験で代替しない |
| [#92](https://github.com/blackflame7983/Auralyn/issues/92) | 子Issueを全件照合し、上記の実装と残件を区別 | 子Issueの未完了条件を満たした後の統合評価。親Issueは未完了 |

## 検証結果

- `npm test -- --run --maxWorkers=4`: 129ファイル・1,318件成功。その後のレビュー修正（詳細のフォーカス復帰、保護解除保存失敗の原文復元）は対象2ファイル・48件成功。最終差分で全件を再実行した結果とは区別する。
- 最終差分で `npx tsc --noEmit`、`npx vite build`、`git diff --check` が成功。
- `npx playwright test e2e/browser/open-issues.spec.ts e2e/browser/home-responsive.spec.ts e2e/browser/streamer-refinement.spec.ts --output test-results/open-issues-20261031-verified`: 29件すべて成功。3テーマ、最小/通常/広幅/縦長、動きを減らす設定、キーボード開閉、メーターの非表示と復帰を確認。画像も目視した。IPCモックの試験であり、実音声・実DPI・Narratorの受入ではない。
- 途中のブラウザ試験では、遷移中に別フレームで取得した寸法の比較が失敗した。有限アニメーションの完了待ちと同一フレームの寸法取得へ修正後、上記29件が成功。別の途中実行で縦長メーターを見つけられない失敗も発生し、単独再実行と最終29件では成功した。原因を確定したことにはしない。
- `cargo fmt --all -- --check`、`cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`: 成功。
- `cargo test --locked --lib`: 511件成功、1件ignore（任意の時間計測）。#150の不在/アクセスエラー分類テストを含む。
- `cargo test --locked --lib --bins --test audio_queue_contract --test msix_coexistence`: Dドライブの空き容量不足（os error 112）でライブラリアーカイブ作成に失敗。バイナリ・当該統合テストの実行成功とは扱わない。既存キャッシュを削除する操作は行っていない。
- 独立レビューで音切れ詳細のフォーカス復帰不具合を検出して修正し、再レビューで解消を確認。レビュー担当によるテストの独立再実行とは区別する。

## 保存と権限

既存の未追跡 `.claude/` と `target/` は編集・削除していない。通常のアプリ設定、デバイス、OBS設定の変更、録音・試聴、リリース操作は行っていない。ローカル実装完了時点では、変更は未コミットの差分として保持した。


## PR作成前の独立確認

ユーザーのcommit・push・PR作成の指示を受け、最新main（`4ba3db1e`、実装時HEADと同じファイル内容）へfast-forwardし、対象26ファイルを固定して独立レビュー・検証を実施した。

- コードレビューはPASS。有効なP0〜P3の指摘なし。
- 最終差分のVitestは129ファイル・1,320件、型検査も成功。
- `cargo test --locked` 全体も成功（親テスト集計518件成功・4件ignore）。ignoreは実機録音・OTT寿命・OTT GUI・任意時間計測であり、実機受入とは区別する。
- 前回容量不足だったRustの `--lib --bins --test audio_queue_contract --test msix_coexistence` は、空き容量が増えた状態で再実行して成功（lib511件、queue2件、MSIX2件）。`--test integration_test --test repro_ott` も実sidecar IPC1件成功。実機録音とOTT GUIはignoreのままで、受入済みとは扱わない。既存キャッシュの削除は行っていない。
- Viteビルド、ブラウザ29件、Rust書式・all-targets check/clippyは、固定した候補ファイルの一致を確認し、上記の最終検証結果を引き継いだ。

GitHubへのIssue更新・クローズは今回のPR作成と分け、実機受入の残条件は維持する。#151は未実装の設計案である。

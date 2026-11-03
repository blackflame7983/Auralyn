# 配信ミックス UI の対応と確認（2026-11-03）

Issue #234〜#254 の21件を、各 Issue の本文・完了条件と現行コードで照合しました。
#234〜#252・#254 の20件はローカル実装と関連試験で確認しています。
#253 は実 Tauri のキーボード操作・言語・窓幅・拡大表示まで確認しましたが、実際のスクリーンリーダー発話と、音声稼働中のホーム表示は未確認です。21件すべての完了とは判定しません。

対象ブランチは `codex/ui-issues-234-254-20261103` です。音声処理を置き換えず、既存の世代・revision照合と、音声callbackの無割当・非ブロッキング方針を維持しています。GitHub の Issue の状態変更・コメント、PR 作成は実施していません。

## Issueごとの照合

「確認済み」はこの記録に示すローカル試験の範囲です。実際の音の到達や聴感の受入を含みません。

| Issue | 完了条件への対応 | 確認結果と根拠 |
| --- | --- | --- |
| [#234](https://github.com/blackflame7983/Auralyn/issues/234) | オーディオタブの第1階層にオケと配信 VST を並列配置。名前・順序・用語を DESIGN.md へ反映 | 確認済み。`AudioSettingsModal`、ブラウザ・実 Tauri |
| [#235](https://github.com/blackflame7983/Auralyn/issues/235) | 区画を開くと自動取得。下書きを保ち、競合時は最新状態の再取得で確認 | 確認済み。`MixingPanel.test.tsx`、`PostMixPanel.test.tsx` |
| [#236](https://github.com/blackflame7983/Auralyn/issues/236) | 設定がある場合だけ本番帯へ音符アイコン・音量・ミュート・停止状態を表示。状態から設定へ移動 | 確認済み。`mixing.spec.ts` の IPC モック操作。表示条件は DESIGN.md。実稼働は #253 に残す |
| [#237](https://github.com/blackflame7983/Auralyn/issues/237) | アプリ入力、設定変更名、エラー、出力説明、ミックス名を日英カタログ経由に変更 | 確認済み。`MixingContracts.test.tsx`、カタログ試験、英語ブラウザ・実 Tauri |
| [#238](https://github.com/blackflame7983/Auralyn/issues/238) | Rust の日本語固定の混合行を廃止。構造化データをフロントで翻訳 | 確認済み。Rust の差分契約試験、英語の専用表 |
| [#239](https://github.com/blackflame7983/Auralyn/issues/239) | 分離出力・主入力へスクロールとフォーカスを移動。準備状態を定期取得 | 確認済み。前提変更後の自動更新を DOM 試験で確認 |
| [#240](https://github.com/blackflame7983/Auralyn/issues/240) | 声・オケ・VSTを即時反映のスライダーと % 表示へ統一。要求を直列化し競合を拒否 | 確認済み。キー操作、連続操作、失敗、古い応答を DOM・ブラウザで確認 |
| [#241](https://github.com/blackflame7983/Auralyn/issues/241) | 共通の PluginList・PluginCard・PluginBrowserModal を使用。削除は確認付き。有効・ミュート・音量・並べ替え・編集を共用 | 確認済み。実 TDR Nova の追加・キー並べ替え・実sidecarの順序照合。未反映音量がある間は保存を禁止 |
| [#242](https://github.com/blackflame7983/Auralyn/issues/242) | 機器の実チャンネル数から1始まりの入力ペアを作り、機器変更時は先頭ペアへ | 確認済み。範囲外の選択肢がなく、有効な既定ペアになることを DOM 試験 |
| [#243](https://github.com/blackflame7983/Auralyn/issues/243) | 無効理由を優先順位付きでボタンの近くへ表示し、aria-describedby で関連付け | 確認済み。前提・候補・原音ミュート・確認・競合・動作中を試験。実発話は #253 |
| [#244](https://github.com/blackflame7983/Auralyn/issues/244) | 停止要求は動作中だけ、用途説明はアプリ入力・音楽だけに表示。保存範囲は要点と閉じた詳細へ | 確認済み。チェック済み保存の経路も同じ詳細表示を使用 |
| [#245](https://github.com/blackflame7983/Auralyn/issues/245) | 待ち時間は実周波数から ms へ換算。不明時は不明と表示。フレーム値は診断へ移動し用語を整理 | 確認済み。44.1/48 kHz・0・未取得の換算試験。用語集を更新 |
| [#246](https://github.com/blackflame7983/Auralyn/issues/246) | 動作中と編集中を区分。保存との差は異なる場合だけ表示。読み直しの上書き先を明記 | 確認済み。DOM・ブラウザ・実 Tauri |
| [#247](https://github.com/blackflame7983/Auralyn/issues/247) | 共通のカード・ボタン・入力スタイルへ統一し、無効化・初期化・削除を区別 | 確認済み。900×600、1024×768、英語150%で操作と横はみ出しを確認 |
| [#248](https://github.com/blackflame7983/Auralyn/issues/248) | 保存範囲を5つのラジオ選択へ変更し、各範囲を説明。声だけの場合はカテゴリを選択 | 確認済み。各範囲から従来と同じ保存フラグ・全カテゴリを送る DOM 試験 |
| [#249](https://github.com/blackflame7983/Auralyn/issues/249) | 専用の MixingConfigurationDiff で入力・音量・ミュート・返し・時間差・VST順を行別表示 | 確認済み。欠落警告と適用禁止、VST状態本文を公開しない契約を試験 |
| [#250](https://github.com/blackflame7983/Auralyn/issues/250) | 経路の変更時に確認。音量操作や同じ経路の再適用では再要求しない | 確認済み。条件と二重再生・循環防止の説明を DESIGN.md へ記録し DOM 試験 |
| [#251](https://github.com/blackflame7983/Auralyn/issues/251) | 操作名と不在・破損・競合・非対応等の分類を表示し、原文は閉じた詳細へ | 確認済み。分類・原文・失敗後の表示を日英で試験 |
| [#252](https://github.com/blackflame7983/Auralyn/issues/252) | システムの閉じた診断に取得・クロック・配信VST進行を追加。実応答の状態と処理済み数をDTOへ | 確認済み。0と未取得の区別、閉じている間の取得抑止、Rust状態応答の転送を試験 |
| [#253](https://github.com/blackflame7983/Auralyn/issues/253) | 実 Tauri の操作・日英・窓幅・150%を記録 | 部分確認。実スクリーンリーダー発話、実エラーの発話、音声稼働中のホーム表示は未確認 |
| [#254](https://github.com/blackflame7983/Auralyn/issues/254) | オケを開かず配信 VST の準備・編集が可能。有効化にオケが必要な条件を表示 | 確認済み。オケを閉じたまま進むブラウザ・実 Tauri の導線 |

## 試験と証跡

| 検証 | 最終結果 |
| --- | --- |
| 全 Vitest | 1,525件成功、失敗0（`test-results/ui-push-final-vitest.json`） |
| Rust lib・bin・指定契約試験 | lib 687件成功、実機等の5件は理由付きignore。契約試験4件成功 |
| Clippy全対象・Rust整形 | 成功 |
| TypeScript・Vite | 成功 |
| 配布スクリプト・配布方針 | 57件成功、`release:check`成功 |
| ブラウザ全体 | 98件成功、旧操作・旧文言を参照する4件が失敗。更新後に関連11件を再実行し全成功 |
| 隔離した実 Tauri | 1件成功（実VST・日本語900×600、英語1024×768・150%） |
| 文書の日本語lint | 指摘0 |

ブラウザの全体runは `test-results/ui-234-browser-suite/`、更新後のrunは `test-results/ui-234-browser-corrected/` です。
全体runの失敗を成功へ書き換えず、再実行の結果と分けて残しています。
ネイティブの窓幅・倍率は上表の組合せで確認し、ブラウザでは900×600と1024×768の両方を英語150%で確認しました。

ブラウザ試験は IPC モックを使用します。機器の有無、実音声、VST 音質の保証には使いません。
`e2e/browser/mixing.spec.ts` は自動取得、スライダー、失敗の詳細、初期化、日英、150%、ホーム操作、連続操作とキー並べ替えを扱います。
`MixingLiveControl.test.tsx` は音声停止時の遅い応答と、編集前に始まったpollが外部変更を上書きしないことを確認します。

実 Tauri は通常設定と WebView2 保存先を分離し、音声を開始せず実 Host・sidecar・TDR Nova を使いました。
成功した最終実行の証跡は `test-results/mixing-ui-native-20261103-225110/run-final-3/` にあります。
`post-ja.png`、`mixing-ja.png`、`mixing-en-zoom.png` と各 `*-aria.txt`、接続先PID・ポートの `connection.json`、倍率の `zoom.json` を保存しています。
実 WebView2 の150%は DPR が1から1.5、1024×768の窓で内部表示領域が683×512になったことを確認しました。
これはWindows全体のDPI変更の試験ではありません。

`aria-live` の開始・移動・確定通知を待ち、実sidecarのVST順が入れ替わることを確認しました。
初期化後は実snapshotで空ラックと無効化を照合し、成功通知のアクセシビリティ情報も保存しました。
発話前のアクセシビリティ情報を取得できたことと、スクリーンリーダーが実際に発話したことは区別しています。

独立レビューでは、失敗した音量の表示残り、連続操作によるミュート要求の欠落、反映前の保存、古いpoll応答と音声停止時の競合を指摘・修正しました。
push前の独立レビューでは、時間差を空欄・範囲外・小数で編集中に音量を操作すると不正な要求が送られる経路も修正しました。送信境界で値を検証し、下書きと理由を保持して、整数へ直した時点で変更を反映します。3ケースの回帰試験を追加しています。
push後のレビューでは、次の3点を修正しました。
- #250：開いた直後の適用中の機器経路を確認済みとして扱い、同じ経路の再適用で確認を求めないようにしました。
- #239：出力先の設定を読み込み済みのときは選択欄へ直接フォーカスを移し、移動の予約が残らないようにしました。
- #249：差分表の不足VSTの警告を配信VSTの分に限り、出力の差分表との重複をなくしました。
途中の失敗runは保持しています。操作通知の待機不足、テストの旧文言、HMR混入、ズームキー未対応による失敗を最終成功へ混ぜていません。

再実行は次を使用します。実 Tauri の試験には TDR Nova と通常のWindows開発環境が必要です。

```powershell
npm test -- --run --maxWorkers=4
npx tsc --noEmit
npx vite build
npx playwright test --output test-results/ui-mixing-new-run
npm run test:e2e:native -- --mixing-ui
```

`--mixing-ui` は新しい隔離Hostだけにズーム権限を付け、対象のnative試験を明示実行します。通常のアプリ権限は変更しません。
試験中にフロントを編集するとHMRが混入するため、編集を止めるか、今回と同様に固定したVite成果物を使います。

## 残る受入確認

#253 は、スクリーンリーダーで無効理由・状態・エラーが発話されることを確認し、発話内容と操作順を記録してから完了判定します。
ホームの実稼働と取得停止も、本人が許可した入力・出力経路で別途確認します。
この作業では音声開始、Windows既定機器の変更、OBS設定の変更は行っていません。

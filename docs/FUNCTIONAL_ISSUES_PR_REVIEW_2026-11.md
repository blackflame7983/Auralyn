# 機能監査対応のPR前レビュー・再検証

2026-11-01。対象Issueは #180〜#195。
baseは `75556b2d2e1925dfb07cd0b4a0f1ee886138486d`、修正後レビューのheadは `d601ebecac40d269bf7a65a69aaddc94baab860d`。
後続の文書コミットは実装を変更しない。

## 最新mainとの統合

PR #197の設定画面改善を `57e3ca3` で統合した。
変更なし保存の抑止、変更予定の表示、音の途切れ設定への導線を保ち、接続controller・共有統計・機器ID選択を併用する。
入力ペアだけを変更した場合も、下書きとして扱って保存操作を有効にする。

## 独立レビューで修正した3件

| 優先度 | 問題 | 対応と回帰確認 |
| --- | --- | --- |
| P1 | 入力番号を物理出力番号へ流用し、8入力/2出力では無音、mono WASAPIでは片側のみになる | `6664524`。入力選択と出力割当を分離。通常音声・tone・録音再生・ラウドネスを共通化。有効なASIO Insertの同番号出力は維持。最終interleaved出力・非選択出力のゼロ・送出レベル・RT確保/解放0を検証 |
| P2 | システム再起動後の入力適用/保存失敗から通常保存で再試行すると、VST復元が抜ける | `d601ebe`。再起動意図を保持し、接続画面からも元の段階を再試行してVST復元まで行う。実モーダルでchannels/save失敗の両方を通し、Restart1回・Start0回・VST復元1回を確認 |
| P2 | 別hostのプリセットが、旧hostの候補を検索して先頭機器へ置き換わる | `d601ebe`。プリセットの対象hostで全候補から名前を解決。ASIO→WASAPIと逆方向の2番目の機器IDを確認 |

同じ独立レビュー担当による修正後レビューで3件の解消を確認し、新たなP0〜P2の指摘はなかった。

## 修正後の検証

| 対象 | 結果 |
| --- | --- |
| フロント全体 | 137ファイル・1,447件成功 |
| TypeScript / Vite build | 成功 |
| 実ブラウザ・IPCモック | settings-discovery / home-actions / settings-issues の26件成功 |
| 設定モーダルの追加回帰 | 同一/別機器のペア下書き、再起動の部分失敗再試行、別hostプリセットを含む13件成功 |
| Rust最終出力の回帰 | queue_diagnosticsの12件成功 |
| リリース用スクリプト | 56件成功。対象スクリプトに変更がないため、独立検証担当が実行した修正前結果を再利用 |

Rust全体は568件成功・3件ignored。queue契約2件・MSIX共存2件・IPC/EOF統合1件も成功し、既定機器/VST GUIを要する2件はignored。
Host・engine・scannerのbuild、cargo check全target、Clippy全targetの警告拒否、fmtも成功した。
初回はwindows/derangedのrlib不足でlinkエラーとなったが、通常の直列build後に直列の全体試験が成功した。根本原因は未確定で、製品コードの不具合とは分類していない。
独立検証担当はRust再試験ログ、native UI・実出力・設定保護の記録も読み、確認範囲内の成功を照合した。ゲート判定はPASS。

## 新しいビルドでの実出力とUI確認

修正後の同一ビルドのHost・engine・scannerを専用領域へコピーし、SHA-256を記録した。
Hostは `--auralyn-temporary`、フロントは修正後distのpreview、IPCモックなしで確認した。

- 入力7/8から1/2へ選択しただけでは実設定は7/8のまま。保存後に実設定とlocalStorageが1/2で一致。
- 設定を開いたまま明示Stop→Startを行い、停止・開始・チャンネル監視再開のイベントを確認。Hostは正常終了、pageerrorは0。
- 実mono WASAPI入力・stereo CABLE出力のengineから997 Hz/-30 dBFSのtoneを送出。別engineがCABLE Outputから1.5秒録音した。
- 録音は48 kHz・stereo・72,000 frames。左右peakはともに0.03162384、左右で996.667 Hzを検出。左右差とraw/processed差は0。

これは実際の出力を別の入力から捕まえた確認であり、先行検証の「出力をmuteしたままraw/processedを比較する」試験とは区別する。
通常音声と録音再生は同じ最終出力関数を使い、機器を開かない回帰試験で経路を確認した。
この短時間の実出力確認はRust再試験と一部並行しており、送信側の統計にはglitch 5、underflow 3回・1,570 framesのゼロ埋めが残る。発生時点は分けていない。
発声・聴感・音切れなし・異なる入出力数のASIO実機・長時間稼働は今回の合格範囲に含めない。
終了後は通常設定7,732ファイルの全SHA-256が一致し、追加・欠落・変更は0だった。既存のVoicemeeterとlocalhost:1420は維持し、試験用Host/sidecar/previewは終了した。

## 生証拠の保存先と消失の記録

初回のブラウザ再検証でPlaywrightの既定outputDir `test-results` が初期化され、Git管理外だった先行検証の生ログ・録音・コピーしたバイナリが失われた。
[先行検証の集計JSON](verification/native-functional-20261101.json)、測定値、ソース、コミットは残っている。
初回失敗以降の本PR前検証では既定出力先を使わず、専用の外部ディレクトリへ保存した。

`C:/Users/black/AppData/Local/Temp/Auralyn-functional-pr-7but4rk_/`

[修正後の集計JSON](verification/functional-pr-20261101.json)をGitへ記録し、この領域に新しいバイナリハッシュ、独立検証ログ、実UI画像、実出力の録音・解析、設定の前後ハッシュを保持する。
設定原本と録音を含むためGitには追加しない。ブラウザ試験を行う場合は既存の証拠を含む親ディレクトリをoutputDirに指定しない。
先行検証の時間・メモリ比較を、このPR前検証で再計測した値として扱わない。

## 残る確認

[先行実機検証](NATIVE_FUNCTIONAL_VALIDATION_2026-11.md)に記録したWASAPI開始直後のゼロ埋め、Realtek/Creative ASIOの開始不可は未解決の制約として残る。
通常のOBS最終ミックス、聴感、長時間稼働、ASIO入出力数違い・奇数・32ch超の実機確認も別途必要。

# 再評価後の改善と検証

2026-11-01。基準はPR #198を取り込んだ `b3b03fb`。
専用ブランチ `codex/post-audit-quality` で対応した。
元の2作業ツリーの未コミット・未追跡・ignoredファイルを変更しない。

## Issueと対応範囲

| Issue | 実装した対応 | 残る条件 |
| --- | --- | --- |
| [#190](https://github.com/blackflame7983/Auralyn/issues/190) | 入力callbackの所有状態、出力コマンドの受理とretire、入力routing・録音・メーター、送出ラウドネスを分離 | 起動関数は約1,864行から約1,429行。出力callbackと起動手順のさらなる整理は継続 |
| [#191](https://github.com/blackflame7983/Auralyn/issues/191) | 音づくりとシステムのモデル・表示を分離。親は1,563行から834行。詳細欄と未保存値を保持 | 共有統計の購読は親の1つ。接続・移行・VST復元の手順は維持 |
| [#199](https://github.com/blackflame7983/Auralyn/issues/199) | Windows/Node24のPR品質workflow。全Vitest・型・Vite・配布スクリプト/方針・全Chromium試験。権限read-only、同じPRの旧実行を取消 | 未pushのためGitHub上のjob成功は未確認。branch protectionは変更しない |
| [#200](https://github.com/blackflame7983/Auralyn/issues/200) | SHA-256と同一計画を使うAB/BA反復runner、CPU平均/範囲/標準偏差・private最大を保存。失敗応答・欠測・非有限値を成功集計から除外 | 任意名の外部Playwright出力先は自動識別できない。計測結果を置く専用外部領域を指定する |
| [#201](https://github.com/blackflame7983/Auralyn/issues/201) | 最初のqueue消費までの不足を総数の内数として公開し、画面で開始時/稼働後を区別。旧engineの欠測は0にしない | 先頭のゼロ埋め自体は残る。欠損解消・聴感の合格を示さない |
| [#202](https://github.com/blackflame7983/Auralyn/issues/202) | native形式・能力を実ドライバーで観測し、確認できた形式非対応と能力未取得を区別。WASAPI等の次の操作を案内 | 整数形式ASIOの変換処理は未実装。対応する機器が増えたとは主張しない |
| [#203](https://github.com/blackflame7983/Auralyn/issues/203) | 全ブラウザ試験で判明した誤期待を修正。間引き後の目盛り全体の包含・間隔、パネル予約幅の遷移、元のホーム幅への復帰を検証 | 900～2560pxはブラウザのviewport。実DPIは別の受入 |

行数は可読性の補助情報であり、性能改善や機能の合格条件には使わない。
コールバックの割当・解放・待機・I/Oを増やさない方針を維持する。
起動順・失敗時の回収・同じ要求のfallbackを変える最適化は混ぜない。

## 自動検証と独立確認

- フロント全体: 137ファイル・1,455件成功。型チェック、Vite buildも成功。
- 配布スクリプト56件と配布方針チェックが成功。
- 全Chromium試験85件成功。初回の既存メーター/パネル試験2件の失敗は #203 で修正した。
- 新しい診断表示の試験では、当初の全文字列出現件数の期待が過剰だった。対象行の内容を確認する試験へ直し、全体を再実行した。
- Rust lib 570件成功・4件ignored、queue/MSIX契約は各2件成功。各bin、全target check、Clippy、fmtが成功。
- 実IPC/EOF統合は1件成功。既定機器録音・OTT GUIの自動統合2件はignoredのまま。実機は下記の明示条件で別途確認した。
- 手動のASIO能力レポート1件を明示実行。通常のignored試験成功へ読み替えない。
- 反復runnerの機器不要試験は5件成功。workflowは公式配布のactionlint 1.7.12で検査し、成功した。
- 独立レビューで、任意のexpectを省略したコマンドの拒否を性能試行が見落とすP2を1件検出した。応答型とError拒否を常に検査し、修正後レビューはPASS。
- 独立検証で最終17ファイルのSHA-256一致と検証結果を確認した。記録文書の追加はその後に行う。

## 実機で確認した範囲

通常Hostの設定を使わず、明示した機器へ現行sidecarから実IPCで要求した。
初回callbackから出力gain0・muteを指定し、発声は行わない。
検証したengineのSHA-256は `1418c58466108ebddbe3da8ffc4a0ca03e0499aa398010f521db196db855712f`。

### ASIOとVST・録音

Voicemeeter Insert Virtual ASIOの96kHz/512、22入力/22出力で開始した。
OTT VST3の読込、エディターOpen要求、約2秒録音、バイパス、ミュート、エディターを開いたままのアンロードを確認した。
raw/processedのWAVを実際にexportし、正のframe数と全サンプルの有限値を確認した。
processedは96kHz、stereo、192,512 frames、peak 0.3483553。rawと同じ形状で、差分RMSは0.1131784。
入力15/16への切替も受理し、停止・子プロセスの正常終了を確認した。error eventは0。
これはGUIの要求成功であり、エディター描画・音質・聴感の合格ではない。

### WASAPIの開始時不足

同じ2chマイク入力→stereo CABLE出力を48kHzで3回開始・停止した。
各回の開始2秒後とさらに3秒後の統計を比較した。
全3回でゼロ埋めは2,527 frames、開始区間の内数も2,527 frames。その後3秒間の増加は0だった。
開始区間は「最初にqueueの実入力を消費するcallbackまで」と定義し、その最初の部分読出しの不足も含む。
48kHz換算で約52.6ms分のゼロ出力だが、物理遅延や声の先頭欠損時間の直接測定ではない。
ASIO互換の出力→入力play順は変えておらず、カウンタを隠して音切れ解消と扱わない。

別の物理mono入力→stereo出力も同じ手順で3回確認した。
総ゼロ埋めは2,050／7,878／4,058 frames、最初の消費までの内数は2,016／2,050／2,016 framesだった。
いずれも2秒後からの3秒間は増加0。最初の消費後にも立上り区間の不足があるため、この区切りを「安定運転に入った時刻」とは扱わない。

## 反復したエンジン負荷比較

変更前engineは先行PR検証のSHA-256と一致し、`d601ebe`から基準`b3b03fb`までのRust差分は0だった。
変更後は上記の現行ビルドを使用した。両版とも同じdevビルド条件。
Voicemeeter Insert ASIO、96kHz/512、22ch、出力gain0・mute、VSTなしで、起動後2秒待ち、各条件を8秒観測した。
前→後→後→前→前→後の順で各3回、全6試行が正常終了し、command拒否・error eventは0。
ブラウザ・Cargo・テストの終了後に比較し、計測プロセス自身のCPUは含めない。

| 条件 | 前CPU平均 | 後CPU平均 | 前private観測最大 | 後private観測最大 |
| --- | --- | --- | --- | --- |
| 既定 | 32.35% | 32.02% | 16.02 MiB | 15.53 MiB |
| 監視ON | 35.61% | 34.93% | 16.02 MiB | 15.53 MiB |
| 監視OFF | 31.40% | 31.73% | 16.02 MiB | 15.53 MiB |

CPUの100%は1論理コア相当。既定の各試行平均の範囲は前30.71～34.43%、後31.18～33.13%。
監視ON/OFFも前後の範囲が重なり、一律の改善・劣化を断定しない。
メモリは100ms間隔のprivate bytesの観測最大であり、OSが保持する瞬間最大commitやHost/WebView全体の最大値ではない。
構造分離を大幅なCPU/メモリ削減として説明せず、この短い条件で大きな回帰を検出しなかった結果として扱う。
[集計JSON](verification/post-audit-quality-20261101.json)に試行別平均、範囲・標準偏差、最大メモリ、バイナリ/計画ハッシュを残す。

### 開始できないASIOの切り分け

| Driver | 既定入力 | 既定出力 | 判定 |
| --- | --- | --- | --- |
| Creative Sound Blaster ASIO | 6ch / I32 / 96kHz / 384 | 4ch / I32 / 96kHz / 384 | 現在のF32処理要件と不一致 |
| Realtek ASIO | 2ch / I16 / rate0 / 1024 | 8ch / I24 / rate0 / 1024 | 形式不一致。既定rateも有効値を取得できない |
| Voicemeeter Insert Virtual ASIO | 22ch / F32 / 96kHz / 512 | 同左 | 起動・録音成功 |

vendor固定cpalのASIO出力は、要求するsample_formatとdriverのnative形式が一致しない場合にbuildを拒否する。
既定形式だけをF32へ読み替えても変換処理にはならないため、検証を迂回する変更は行わない。
Realtek/Creativeへの実Startは期待どおりエラーを返し、WASAPIへ変更する案内を含むことを確認した。

## 証拠の保持と残る受入

生ログ、WAV、反復ごとの計画・集計、バイナリは次の専用外部領域へ保持する。

`C:/Users/black/AppData/Local/Temp/Auralyn-post-audit-20261101/`

Playwrightは毎回新しいサブディレクトリを使い、既存証拠の親をoutputDirに指定しない。
過去に消失した証拠の復元や、今回未実施のGitHub CI成功は主張しない。
残る受入は既存 [#72](https://github.com/blackflame7983/Auralyn/issues/72)、設定画面固有の実DPI/読み上げは [#179](https://github.com/blackflame7983/Auralyn/issues/179) を継続する。
入出力数違い・奇数・32ch超のASIO実機、通常OBSミックス、発声・聴感、数時間の連続運転は未確認。
今回の確認だけでIssue全体を閉じず、実装と受入を区別して追跡する。

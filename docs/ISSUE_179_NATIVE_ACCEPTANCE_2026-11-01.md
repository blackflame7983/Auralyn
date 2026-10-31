# #179 実機受入の追加記録

2026年11月1日（日本時間）、`codex/issues-167-179-settings` の未コミット候補を、現行ソースからビルドした隔離Host・engine・scannerで確認した。
#179は一部確認済みであり、完了扱いにはしない。自動検証の一覧は [設定画面の受入記録](ISSUES_167_179_ACCEPTANCE.md) を参照する。

## 環境と証拠

Windows 11、WebView2、Voicemeeterの仮想ASIO/WASAPI、インストール済みOTTを使用した。
アプリ識別子・設定・WebView保存先を一時領域へ分離し、IPCは実Host・実sidecarへ接続した。
Viteの1427番ポート所有者が今回の起動PIDと一致することも確認した。

証拠の原本は `C:/Users/black/AppData/Local/Temp/Auralyn-issue179-5a7IWq/results`。
同じ内容を `test-results/issue179-real-20261101` に複製した。どちらも配布成果物ではなく、リポジトリ側はignoredである。
JSON、CSV、画面画像と、合成試験信号だけのWAVを保持している。秘密情報を含むOBS接続設定は掲載しない。

## 実キーとホットキー競合

実UIからミュート切替をAlt+Shift+F11へ保存した。
OSへのキー入力により、Auralynが前面の場合はミュートON、Voicemeeterが前面の場合はOFFとなり、実イベントは `[true, false, true]` だった。

別の試験プロセスがAlt+Shift+F9を登録した状態で、その組合せへの保存を試した。
競合の説明が表示され、取得した旧割当と保存ファイルのバイト列が維持された。
予約プロセス終了後、変更を取り消し、元のF11が再びミュートを切り替えることを確認した。
証拠は `hotkeys-real.json` と `hotkeys-real.png`。

## 独立した実OBSへの適用・復元

OBSのプログラムを一時領域へ複製し、portableモード、専用WebSocketポート、空のAcceptanceシーンで起動した。
通常のOBS設定ファイルは前後のハッシュが一致した。

実UIで接続し、変更予定の確認、取消、再確認、適用、履歴からの復元、切断まで実行した。
取消時に入力が作られないこと、適用時に「Auralyn マイク」が作られること、復元時に取り除かれることを実OBSの取得APIで照合した。
作成した入力は `device_id=disabled`、シーン項目も無効であり、実際の声・配信・録画への到達試験ではない。
証拠は `obs-real.json`、`native-obs-applied.png`、`native-obs-restored.png`。

## ASIOの8chを超える入力

`Voicemeeter Insert Virtual ASIO`、入力22ch・出力22ch、96 kHz、512サンプルで開始した。
画面には21/22までの11入力ペアがあり、監視イベントは32要素だった。
入力15/16を選び、保存されたゼロ始まりのペア `[14, 15]` を確認した。

Voicemeeter AUX Inputへ997 Hz、−40 dBFSの合成信号を送った。
15/16の監視ピークは送出前後が0、送出中が両方約0.010002だった。
同ペアの加工前録音は96 kHz・2ch・32bit浮動小数点、305664フレーム（約3.184秒）。両chの997 Hz成分の振幅は約0.009995だった。
選択した高番号ペアから録音地点までの到達を確認できた。

既存の7/8にも約0.39の信号があった。15/16だけが有信号という結果ではない。
今回の0.01の信号は画面の「信号あり」のしきい値0.05より低いため、その表示の受入には使えない。
通常出力はミュートしており、ASIO最終出力・OBS・聴感は未確認。
入力数と出力数が同じ機器の試験なので、機能監査で挙げた入力数と出力数が異なる場合の問題も未確認・未修正である。
証拠は `asio-ui.json`、`asio-tone.json`、`asio-raw-summary.json`、`asio15-16-raw.wav` と入力一覧画像。

## WASAPIの保存して再起動

入力CABLE Output、出力Voicemeeter AUX Input、48 kHzで、実UIのバッファを512から1024へ変更して「保存して再起動」を押した。
OTTを実IPCで読み込み、バイパス状態（enabled=false）、muted=false、個別gain=0.7にした。
再起動前後のbackendスナップショットで、入出力ID、レート、OTTのパス・状態・gain、全体gain=1の保持を確認した。
再起動後は1024サンプル、running=true、streamFailed=falseだった。
OTTを有効にした加工音や、画面のVST追加操作を確認した試験ではない。

CABLEへ997 Hz、−40 dBFSを送り、AUX出力のループバックで997 Hz成分を20 ms窓で集計した。
UI操作の完了は640 ms。再起動付近にゼロまたは小振幅の窓があり、その後は再び信号が得られた。
操作前の500〜2200 msは85/85窓、操作後の4000〜14000 msは500/500窓がRMSしきい値0.003を超えた。
低振幅窓は記録上2700〜3370 msに存在したが、その間には有信号窓もある。
この値を連続した無音時間とは扱わない。callback時刻・20 ms窓による観測であり、耳までの厳密な無音時間や聴感の合格は未確認。
証拠は `wasapi-restart-state.json`、`wasapi-restart.csv`、`wasapi-restart-measurement.json`。

## 未確認事項と終了状態

- Windowsの125%・150%の実DPI。CSS拡大による既存ブラウザ試験とは別である。今回のscaleFactorは1で、OS倍率は変更していない。
- Narratorの実際の読み上げ内容・順序・理解可能性。起動と更新案内の表示だけでは受入済みとしない。
- 実マイク、通常のASIO→OBS最終ミックス、実録画・配信、聴感、長時間運転、複数のレート・物理機器での比較。
- 入出力チャンネル数が異なるASIO機器、15/16の「信号あり」表示、有効な複数VSTでの再起動復元。

隔離Host、engine、試験OBS、専用Vite、信号生成・ホットキー予約プロセスは終了した。
通常のWindows既定デバイス・ミキサールーティングは変更していない。
Narratorは試験で起動したが、終了操作がアクセス拒否となり、停止は確認できていない。必要ならCapsLock+EscまたはInsert+Escで終了する。
`native-environment.json` の「停止済み」という初期記録は、終了結果を照合して訂正した。
最後の画面操作はComputer UseがブラウザURLを十分に判定できず停止したため、以降の画面受入は実施していない。

## 再確認用の補助コード

`scripts/issue179-native-session.mjs` は `node scripts/issue179-native-session.mjs` で隔離Hostを起動し、接続情報を `test-results/issue179-session.json` に出力する。
空きポートを確認し、今回起動したViteの起動通知を待つ。既存Viteが1427を使用中のとき、起動を拒否する確認も実施した。
OBSの専用試験は、そのHostを起動した状態で `node scripts/issue179-obs-runner.ts` を実行する。
ASIOの画面確認は `e2e/native/asioAcceptance.ts`、OBSの操作と照合は `e2e/native/obsAcceptance.ts` にある。

`scripts/issue179-*.rs` は今回の機器名・レートに限定した手動補助コードであり、Cargoの通常テスト対象には含まれない。
ASIO/WASAPI構成取得、ホットキー予約、合成信号送出、ループバック集計を分けている。
信号送出を含むものは、通常の自動検証やPR前チェックとして無条件に再実行しない。今回の手動操作全体を一括再現するハーネスでもない。

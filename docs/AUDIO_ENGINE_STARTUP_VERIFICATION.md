# Audio Engine起動と音楽再生の確認

## 今回の変更範囲

- ASIOの入力・出力を構築してからplayでドライバーを開始する。構築途中のASIOStart → ASIOStop → ASIOStartを避ける。入出力のバッファ準備自体は各方向で行う。
- デバイス一覧のASIO項目は登録名から作り、一覧取得だけではドライバーをロードしない。開始時も選択した登録名・IDだけをロードする。
- 未起動ASIOのチャンネル数は0（未取得）、バッファ範囲は未取得として返す。入出力に登録名を表示するが、接続・入出力の対応・能力は開始時に確認する。稼働中の機器は実際に取得した能力で補完する。
- チャンネル数が未取得の間は入力ペアを選択できない。音声開始後・未取得キャッシュからの設定再表示で能力を取得する。バッファ候補には960 samplesなどの非2冪の実稼働値も保持する。
- 入出力の構築順・play順、サンプルレート選択、バッファ選択、DSP、エラー時の再試行方針は維持する。

自動テストは機器を開かないモックによる確認。起動時間短縮、他アプリの再生継続、ドライバー固有の動作は、下記の実機確認記録と区別して扱う。

## 実機確認の記録

2026-10-29、利用者から「これまで止まっていた音楽アプリが再生継続できることを確認した」と報告された。当該環境での再生継続を確認済みとする。アプリ名・ドライバーの版・操作条件の詳細、起動時間の定量比較、他の機器や長時間の安定性は未確認。

## 準備

1. 変更前後で同じ配布形態・ビルド種別を使う。以前の計測値がない場合、今回の値だけで短縮率を出さない。
2. Auralyn・Voicemeeterのバージョン、ASIOドライバー名、サンプルレート、バッファ、VST構成、音楽アプリ名と出力先を控える。最初は普段の設定を変えない。
3. このリポジトリの開発アプリを終了し、ルートで `npm run rebuild-engine` を実行する。古いsidecarと取り違えないため、ビルド成功とコピー先を確認する。インストール済みアプリのsidecarは置換しない。
4. 同じPowerShellで次を実行する。既存の `RUST_LOG` は控え、確認後に戻す。

```powershell
$env:RUST_LOG = 'info,vst_host_lib::audio_engine::core=debug'
npm run tauri dev
```

起動ログの `[AudioEngine] exe=... modified=...` と、再ビルドした実行ファイルが一致することを確認する。ログには機器名・パスが含まれるため、共有前に必要部分だけ抜き出す。

ビルド先ドライブの容量が不足している場合は、既存キャッシュを削除せず、空きのあるドライブへ `CARGO_TARGET_DIR` を指定する。現在の `npm run rebuild-engine` は既定の `src-tauri/target/debug` からコピーするため、この場合は代わりに次を使う。アプリを終了し、既存の `src-tauri/bin` のsidecarを別の場所へ控えてから行う。

```powershell
$env:CARGO_TARGET_DIR = 'C:/auralyn-build'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_INCREMENTAL = '0'
cargo build --manifest-path src-tauri/Cargo.toml --locked --bin audio_engine --bin plugin_scanner
# 成功した場合だけコピーする。
if ($LASTEXITCODE -ne 0) { throw 'sidecar build failed' }
Copy-Item "$env:CARGO_TARGET_DIR/debug/audio_engine.exe" 'src-tauri/bin/audio_engine-x86_64-pc-windows-msvc.exe'
Copy-Item "$env:CARGO_TARGET_DIR/debug/plugin_scanner.exe" 'src-tauri/bin/plugin_scanner-x86_64-pc-windows-msvc.exe'
npm run tauri dev
```

この指定はそのPowerShell内だけで使う。比較する旧版にも同じビルド条件を指定し、確認後は控えた環境変数を戻す。`DEBUG=0` はデバッグシンボルを省く指定で、上記のログ出力は維持される。

## 確認順

| 操作 | 記録・確認すること |
| --- | --- |
| 音楽だけを30秒程度再生 | Auralyn起動前に安定して再生できる。再生位置が進む。 |
| 音楽を流したままAuralynを起動 | 起動操作から音声稼働までの時間。音切れの長さ、再生位置の停止・一時停止表示・アプリのエラーの有無。 |
| 設定を開き「再検出」 | ASIO名が表示される。音楽とAuralynの音声が継続する。名前の表示だけで機器の接続確認済みとは扱わない。 |
| 同じASIO設定で停止・開始 | 入出力と音量を維持して再開できる。音楽への影響を記録する。 |
| 設定のエンジン再起動 | 再開・VST復元の状態を確認する。これは既存のプロセス再生成経路であり、通常開始と分けて記録する。 |
| 別の音楽アプリで同じ操作 | 症状の出ていたアプリを含め、音声だけの途切れとプレーヤー自体の停止を区別する。 |

初回起動と停止・再開始をそれぞれ3回程度測り、各回の値を残す。必要なら次にVSTなしで比較し、VST準備時間の影響を分ける。

ログの `[StartupPhase]` にある `device_resolve`、`capability_output`、`capability_input`、`processor_prepare`、`input_build`、`output_build`、`stream_play` を比較する。`us` はマイクロ秒（1000 us = 1 ms）。これらは各区間の時間で、アプリ全体の起動時間やASIOStop単体の計測値ではない。`Fallback`、`Stream Error`、自動再接続が出た回は、通常成功した回と分ける。

保存レートとVoicemeeterの現在レートが一致しているかも記録する。レート変更による中断は今回の変更後も発生し得る。比較のために変更する場合は元の値を控え、一項目ずつ変更する。

## 回帰確認

- ASIOの入出力、停止・再開始、VST追加・削除・復元、ミュート、チャンネル選択を確認する。
- 未起動のASIOでバッファを選択できる。非対応設定は開始時にエラーまたは既存の既定設定への再試行となり、実際の開始値が画面へ反映される。
- 機器の未接続・古い登録が残る場合に、開始失敗を正常稼働として表示しない。
- WASAPI共有でも起動・停止・再検出を確認する。44.1kHz・48kHz、通常使用の96kHz、対応する複数バッファで比較する。
- 通常のVST構成で連続再生し、音切れ・CPU・音質を確認する。OBSなど受け側への到達と、長時間の安定性はそれぞれ別に記録する。

結果には、確認した条件、所要時間、音楽の状態、ログの該当箇所、未確認条件を残す。聴感による確認だけでASIOのAPI呼び出し回数や全ドライバーでの互換性を保証しない。

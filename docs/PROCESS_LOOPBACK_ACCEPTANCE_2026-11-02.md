# Chrome・VLCのプロセス入力と連続運転の確認

2026-11-02の段階1に対する実機確認記録。Windows 11 Pro、ビルド26300。未コミット。
Chrome・VLCをそれぞれ65分運転し、取得失敗と取得側不連続はともに0だった。
TDR Novaを通した処理の継続と原音用デバイスの復元は確認できたが、出力callbackの遅延を記録したため、音切れゼロや段階1全体の合格とはしない。
試聴用アプリの準備と、実UIからのChrome・VLCの個別開始も確認した。
耳での二重再生・音切れ・音質の評価は利用者が行う。[試聴手順](PROCESS_LOOPBACK_AUDITION.md)を参照する。

## 実アプリからSRC・VSTへ通した

素材は試験用に合成した44.1 kHz・16 bit・stereo・16秒のWAVをループ再生した。
自動試験のレベルは約−54 dBFS。市販の曲・配信サイト・保護コンテンツは使っていない。

| 対象 | 再生方法 | 原音用デバイス | Auralynの出力 |
| --- | --- | --- | --- |
| Chrome 156.0.8078.74 | 所有する一時プロファイルのheadless Chrome。HTML `audio`要素、出力先APIで別デバイスへ指定 | FS2333、出力デバイス側をミュート | WASAPI、Voicemeeter Input、48 kHz |
| VLC 3.0.23 | 所有する別インスタンス。WASAPIの出力先指定、設定読込み・メディアライブラリ・メタデータ通信を無効化 | Realtek Digital Output、出力デバイス側をミュート | WASAPI、Voicemeeter Input、44.1 kHz |

両方とも、製品Engineのプロセス取得（48 kHz）→可変比SRC→インストール済みのTDR Nova VST3→WASAPI出力を使う。
バッファの要求値は512。音楽の用途を選び、声向けの処理は通さない。
最初に入出力ピークの非ゼロ、VST有効数1、一時停止後の再開を確認し、その後の連続運転はEngineの全体ミュートを有効にした。
全体ミュートはVST通過後の本人用出力を無音にするため、取得・SRC・VSTの処理は継続する。長時間の出力ピーク0はこの操作による。

試験は隔離したEngine設定を使い、`AURALYN_DISABLE_PERF_TWEAKS=1`で実行した。
通常の性能調整を無効にした条件であり、通常起動と同一条件ではない。この差だけを遅延の原因と断定しない。
同時に2系統を動かし、途中に試聴用アプリのビルドとUI確認も行っている。
独立した2つのEngineによる試験であり、マイク＋伴奏のミックスや1つのEngineでの複数入力の実証ではない。

## 両アプリとも65分を完走し、遅延の警告が残った

両アプリとも3,900秒を完走し、原音用デバイスのミュート・音量・既定ロールを復元できた。
Voicemeeter Inputの同じ設定も保持している。

| 観測項目 | Chrome | VLC |
| --- | ---: | ---: |
| 連続運転 | 3,900.0秒 | 3,900.0秒 |
| 取得失敗／取得側不連続／タイムスタンプ異常／非有限サンプル | なし／0／0／0 | なし／0／0／0 |
| 有効なVST数 | 1 | 1 |
| 入力キュー範囲（容量16,384フレーム） | 1,244〜2,219 | 0〜2,319 |
| SRC補正の観測範囲 | −834〜+1,070 ppm | −1,074〜+2,000 ppm |
| 入力待ちからのリセット／その際の破棄 | 0回／0フレーム | 241回／29,654フレーム |
| コールバック遅延の累計（`glitch_count`） | 673 | 580 |
| 最大コールバック遅れ | 11,640 µs | 11,423 µs |
| 最大コールバック処理時間 | 3,142 µs | 1,670 µs |

VLCでは16秒のファイル終端で再生を開き直しており、ログの`repeating item`も241回だった。
この入力待ち・再開を、連続した素材の再生で常時音が途切れないという結果へ読み替えない。
キュー最小0や補正上限への到達も含めて記録し、通常のクロック差だけによる挙動と混同しない。

`glitch_count`は直前のcallbackの再生時間に対して呼出しが半周期超遅れた回数であり、実際に耳で確認した音切れの回数ではない。
並行運転中にはChromeとVLCで同じ時間帯に増え、VLC終了後のChrome単独運転でも増えた。原因は特定していない。
データ取得の継続に成功しても、音切れゼロや製品全体の安定性合格とは判定しない。

## 試験スクリプトの不具合でChromeを取り直した

最初のChrome（Web Audio、`app-chrome-754626c3b4`）は約25分で監視JSONの置換がWindowsの読み取りと競合し、`WinError 5`で試験スクリプトが終了した。
終了直前の取得失敗・不連続・タイムスタンプ異常・非有限サンプルは0。これは1時間の成功には含めない。
スクリプトは所有する子プロセスを終了し、原音用デバイスのミュートを元に戻した。

監視JSONの置換を短時間再試行し、表示用snapshotだけが競合しても連続運転を止めず、追記ログを残すよう修正した。
読み取りロックを250 ms保持する再現試験でも更新できたことを確認し、ChromeはHTML `audio`要素で最初から65分を取り直して完了した。
VLCは中断せず65分を完了した。

## 試聴用アプリは通常設定から分けた

`test-results/process-input-audition-20261102/Start-Audition.cmd`から起動する。
フロントを埋め込んだHostとsidecarを揃え、通常版の`src-tauri/bin`を差し替えていない。
この専用アプリで次を確認した。

- 開発サーバーなしで起動し、MCPは起動したHost自身のポートへ接続。
- 設定画面からChrome・VLCを個別に選択して保存・開始し、Host→Engineで非ゼロの取得と有効なTDR Nova 1件を確認。確認中の返しはミュート。
- VST構成だけの「入力試聴 TDR Nova」を実UIで適用。プロファイル適用だけでは音声を開始しない。
- 接続設定にはPIDや候補IDを保存せず、次回は再選択が必要。停止後に全体ミュートを解除。

試聴用の`samples/sample-44100.wav`は、自動試験の合成素材を64倍にしたもの（ピーク約0.105、約−20 dBFS）。
`samples/Chrome-listen.html`は再生ボタンを押すまで音を出さない。
実UIによる開始確認は短時間であり、Host画面を含めた65分の運転とは区別する。

## 証拠は専用環境に保存した

集計・証拠ファイルのSHA-256は、ignoredの`test-results/process-input-audition-20261102/acceptance-results.json`に保存する。
Chromeは`src-tauri/target/process-loopback-probe/app-chrome-fd795d261a`、VLCは同じ親の`app-vlc-e420febbef`に、最終`summary.json`、約2秒ごとの`samples.jsonl`、原音用デバイスの復元記録がある。
実UIの両アプリ開始は試聴環境内の`verification-1793613854930`、最終の停止中起動確認は`verification-latest.json`から参照する。

試聴環境と両長時間試験のEngineは同一で、SHA-256は`c0408eceeef31721ddb4f9e1e0df302400710df8b53370a0c67e19935a02d320`。
TDR Nova VST3は`90481b7d7f5bc30a3509908c1732d1cc310ca804daa8d2c40334d2869f0eaf65`。
検証用probeのミュートguard上限は連続試験のため2時間へ広げた。製品の音声処理は今回変更していない。
関連確認はprobeの単体試験8件とClippy、Rustfmt、追加スクリプトの構文確認、試聴用TypeScript・Viteビルド。
probeの検証は段階0と同じ一時manifestを使い、製品全体のテスト再実行とは扱わない。

## 再現する場合は音声を開始する明示試験として扱う

入口は[scripts/verify_process_app_soak.py](../scripts/verify_process_app_soak.py)。
`--kind chrome|vlc`、`--engine`、`--probe`、`--vst`、`--raw-endpoint`、`--output-endpoint`を指定し、`--seconds 3900`で実行する。
Chromeの今回の取り直しには`--chrome-media-kind audio-element --rate 48000`、VLCには`--rate 44100`を指定する。
probeのビルドは[段階0の記録](PROCESS_LOOPBACK_STAGE0.md)、Engineは[ビルド手順](BUILD_GUIDE.md)に従う。
未使用・非既定の原音用デバイスだけを指定し、返し用出力と分ける。

試聴環境の作成は[scripts/prepare-process-input-audition.mjs](../scripts/prepare-process-input-audition.mjs)。
`CARGO_TARGET_DIR`で指定した場所のビルド済みEngineを複写し、Host・scanner・埋込みフロントをビルドする。
実UIの確認は[scripts/verify-process-input-audition.mjs](../scripts/verify-process-input-audition.mjs)に専用環境とMCP CLIのパスを渡す。
`--exercise-sources`は所有するChromeとVLCが上記の別出力先で再生中の場合に限り使い、実際に音声処理を開始する。
通常の自動テストには追加していない。

## 聴感と対象外の条件は受入として残す

Windows音量ミキサーによる手動経路、通常のChromeプロファイル・拡張機能・各配信サイト、VLC以外のプレイヤー、別のVST、別のデバイス・ドライバーへの対応は、この結果だけでは保証しない。
デバイス切断、子プロセスの再生成、保護コンテンツ、ASIOマイク実機、許諾済み配信素材によるNR評価も別途必要。
段階1の受入全体を完了したものとはせず、段階2〜3への着手や公開判断も行わない。

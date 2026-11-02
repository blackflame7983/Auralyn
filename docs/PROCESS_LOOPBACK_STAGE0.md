# プロセス取得の段階0：隔離probeと実機で確認した範囲

確認日: 2026-11-02。追跡: [Issue #233](https://github.com/blackflame7983/Auralyn/issues/233)。
設計と合否条件は[実装計画](plans/PROCESS_LOOPBACK_AND_MIXING.md)を参照する。

指定した試験用プロセスの音をWASAPIで取得するprobeを実装した。
追加検証では、未使用の別再生先を**出力デバイス側でミュートしても取得音が残る**ことを2つの再生先で確認した。
一方、アプリのセッションをミュート／音量ゼロにすると取得音もゼロになる。両操作は区別する。
別再生先での30分の取得と、本人用のVoicemeeter Inputへの短い返しをデータで確認し、段階1のローカル実装へ進めた。
聴感・Chrome／音楽アプリ固有の動作・切断試験を含む受入全体は未完了である。段階1の結果は[実装・検証記録](PROCESS_LOOPBACK_STAGE1.md)に分ける。

## 実装したもの

- `src-tauri/examples/process_loopback_probe.rs` と同名ディレクトリ：製品の開始処理と分離したCLI。全ての有効な再生エンドポイントからの候補列挙、PID＋生成時刻の照合、プロセスツリーの取得を行う。
- 既存の`windows` 0.62.2による`ActivateAudioInterfaceAsync`と、`#[implement]`によるagileな完了通知。開始待ちの期限は5秒とする。
- 取消・期限切れ後の通知は採用しない。OSのactivationを強制取消できたとは扱わず、引数は遅い完了まで保持する。未完了の要求は同一probe内で一つに制限し、再試行で資源を無制限に増やさない。
- 48kHz・stereo・f32のPCMを有界キューで録音workerへ渡す。録音先は新規ファイルだけを受け付け、既存の録音を上書きしない。
- [実機runner](../scripts/verify_process_loopback_probe.py)：専用ディレクトリへコピーしたsourceだけを起動・取得・回収する。合成信号と生ログはignoredの`src-tauri/target/process-loopback-probe/`へ保存する。

当初はexampleだけでAPIを検証した。追加検証後は、同じ既存の`windows`／`windows-core` 0.62.2を製品の入力adapterにも使用する。解決版やCPALの更新は行っていない。
`process-loopback-probe` featureは、試験用exampleを明示的にビルドするための入口として残す。
製品への接続範囲は[段階1の記録](PROCESS_LOOPBACK_STAGE1.md)を参照する。既定デバイスやOBS設定は変更しない。
sourceが音量ミキサーで変更するのは、自分自身の試験用セッションだけである。

## 再現する

リポジトリルートからビルドする。

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml --example process_loopback_probe --features process-loopback-probe
```

以下は音声デバイスを開始しない単体試験で、PCM処理のRust側の確保・解放、無音パケット、不正パケット、取消後の通知と引数の寿命を確認する。

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml --example process_loopback_probe --features process-loopback-probe
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --example process_loopback_probe --features process-loopback-probe -- -D warnings
```

候補一覧の取得はキャプチャを開始しない。

```powershell
src-tauri/target/debug/examples/process_loopback_probe.exe list
```

実機試験は以下のコマンドで明示的に開始する。
既定では、ミュート／音量ゼロの試験用sourceを使い、音声待ち、取消、対象終了、録音ファイルの保護を確認する。
取得できる基準信号との比較には、追加のフラグが必要になる。

```powershell
python scripts/verify_process_loopback_probe.py
# 997Hz・振幅0.002（約-54dBFS）の基準音を9秒間だけ再生する。
python scripts/verify_process_loopback_probe.py --allow-low-volume-tone
```

runnerは実行ごとに新しい保存先を作り、結果のJSONに実行ファイルのSHA-256と取得統計を残す。
`functional_pass`はprobeの取得・終了処理の確認結果であり、`single_endpoint_gate`とは別の判定である。
`single_endpoint_gate`は当初の同一再生先での試験を表す。今回の計画変更でrunnerや既存結果を書き換えておらず、別再生先の出力デバイス側ミュートの合否を表すものではない。
基準音を許可しなかった場合は、原音抑止後も信号を取得できるかの合否を判定しない。

CLIで個別に取得するときは、候補のPIDと生成時刻をそのまま指定する。
生成時刻が異なる対象へは接続しない。CLIの取得時間は1秒〜1時間、取消時刻はmsで指定する。録音先は絶対パスを使う。

```text
process_loopback_probe.exe capture <pid> <created> <seconds> <new.wav> [cancel-ms]
```

## 実機で観測した結果

Windows 11 Pro、build 26300。有効な再生エンドポイント17件を列挙した。
sourceは既定再生先一つだけを使っており、物理出力が一台だけのPC全体を検証したものではない。
以下は同じ再生先を使う構成での短時間の比較である。

| sourceの状態 | 取得時間 | 取得フレーム | 非ゼロの取得フレーム | 判定 |
| --- | --- | --- | --- | --- |
| セッションをミュート | 3秒 | 142,560 | 0 | 信号生成は続くが、取得音もゼロになる |
| セッション音量を0 | 3秒 | 143,520 | 0 | 同様に取得音もゼロになる |
| ミュートなし・振幅0.002の基準音 | 3秒 | 143,520 | 142,013 | 指定プロセスの信号取得は成立した |

各caseでsource側の信号生成を確認した。録音workerへの転送破棄、非有限サンプル、WASAPIの不連続フラグは、この短い試験では全て0だった。
取得開始前の音や実際の耳までを測った結果ではなく、音切れゼロ・聴感・長時間の保証には使わない。
PID生成時刻の不一致、開始前の取消、既存WAVへの上書きは拒否された。
250ms後に取消する試験では取得経過249msで終了し、対象プロセスの終了でも取得が終了した。取消要求から停止までの遅延を計測した値ではない。
最終の生ログはignoredの`src-tauri/target/process-loopback-probe/verify-326e8f36f5/summary.json`にある。
実測したprobeのSHA-256は`c2e4f4285f210b87228adbec454ebace8ee9e2f2279900a7f72d52d9775fbf67`。配布版の識別ではない。

初回の寿命試験では、`PROPVARIANT`の自動解放がRust所有のBLOBを解放し、heap corruptionを検出した。
外側の`PROPVARIANT`を`ManuallyDrop`にし、BLOBの所有者だけで解放するよう修正した。寿命試験と実機試験は修正後に実行している。

初回probe時点のローカル確認は、exampleの単体5件、警告をエラーにするexampleのClippy、通常featureの`cargo check --locked --all-targets`、変更したRustの書式確認が成功した。
Python runnerの構文と文書リンクも確認した。製品UI、実Tauri、OBSの最終音声を確認した結果ではない。

## Stream Gear Mixerの調査と、今回変更した条件

起動中のSGM画面で、APP入力のアプリ選択、INST MON、配信側のSTREAM FXを確認した。
同梱説明書p.9は、元アプリを使っていない別再生先へ送り、その出力デバイス側をミュートするよう案内している。アプリのセッションをミュートすると取得音も消える、という説明は今回のAuralynの実測と整合する。
説明書p.36では、STREAM FXは配信側の声＋オケへ適用し、通常の本人用モニターには適用しない。
資料の版・SHA-256・確認範囲は[SGM説明書の追加照合](COMPETITOR_SGM_MANUAL_2026-10.md)に記録した。画面の閲覧と資料照合であり、SGMの原音抑止や音声品質を実測したものではない。

この結果を踏まえ、原音を送る別再生先を使える環境をプロセス入力の対象とし、使えない環境では仮想ケーブル入力を使う。
本人が聴くヘッドホンが一台でも、Windows上に別の有効な再生エンドポイントがある環境は対象候補になる。
単一エンドポイントだけでのプロセス入力は新しい対応条件に含めず、仮想ケーブルを代替経路として残す。

## 追加検証：別再生先の出力デバイス側ミュート

通常アプリの出力先やWindows既定は変更せず、所有する試験sourceだけを未使用の再生先へ送った。
アプリのセッションはミュートなし・音量1のまま、原音用の出力デバイスのミュートだけを一時的に有効にした。
開始前のミュート状態を復元用JSONへ記録し、正常終了・途中失敗の両方で戻す。既定や使用中の再生先は、変更前に拒否する。

| 条件 | 観測 | 証拠（ignored） |
| --- | --- | --- |
| FS2333、997 Hz、3秒 | 143,520フレーム、142,013非ゼロ、破棄・不連続・timestamp error各0 | `src-tauri/target/process-loopback-probe/route-ba28a862ae/summary.json` |
| Realtek Digital Output、659 Hz、5秒 | 239,040フレーム、237,536非ゼロ。別sourceの997 Hzを同時再生した1秒区間のFFTでは、997 Hz帯は659 Hzに対して約−175 dB | `src-tauri/target/process-loopback-probe/route-4113b2a8e0/summary.json` |
| 同上→本人用のVoicemeeter Input | SRC経由236,640フレーム、最大キュー2,400、欠落・破棄0、出力失敗なし | 同上 |
| FS2333、30分 | 86,394,720フレーム、86,389,976非ゼロ。破棄・不連続・timestamp error・非有限値各0 | `src-tauri/target/process-loopback-probe/long-route-20261102/summary.json` |

30分の集計を上記のignored領域へ複写し、WAVと生ログの原本はCドライブの専用一時領域に保持した。
30分は取得側の試験であり、製品のSRC・VSTを含めた長時間運転ではない。
FFTは指定した合成信号の1区間の結果で、他アプリの音が常に混ざらない保証にはしない。
全試験で、再生先のミュート・音量・既定ロールが試験前と一致することを確認した。

追加runnerは[別再生先の検証](../scripts/verify_process_loopback_route.py)。本人用出力は利用者が指定したVoicemeeter Inputを使った。
返しのデータ転送は確認したが、耳で原音の抑止・加工音・音質を確認した結果ではない。

### APIと速度差補正の採用判断

`wasapi`を追加せず、既存の`windows` APIを専用MTAスレッドで包む。完了通知を`#[implement]`で受け、activationは5秒、準備の応答は6秒の期限を持つ。取消後の遅い完了から取得を再開しない。
48 kHz・stereo・f32で取得し、出力側で`rubato` 0.14.1の`SincFixedOut`を使う。目標キュー2,048フレーム、容量16,384フレーム、補正上限±2,000 ppmとする。
目標キューは取得rateで約42.7 msの設計値で、耳やOBSまでの総遅延を実測した値ではない。
±1,500 ppmを含む正負の合成クロック、44.1／48／96 kHzの実SRC消費量、無音待ち・不足・満杯・再開とRTのalloc/free 0を単体で確認する。
`queue_recovery`の反復破棄を通常の速度差追従には使わない。

最初のビルドではDドライブの容量不足で失敗した。ファイル削除は行わず、追加probeの実機試験はCドライブの独立manifestでビルドした。
このprobeビルドは製品の依存全体の検証とは扱わない。製品はリポジトリのlockfileと別のCドライブtargetを使って確認する。

## 残る受入確認

- Chromeと一般の音楽アプリ、それぞれの再起動・子プロセスの作り直し・保護コンテンツ・mono／素材rate変更。
- 別再生先の切断・無効化と、元アプリが既定出力へ戻る場合の原音の再開。
- 別再生先と仮想ケーブルの両経路での実際の聴感、原音／加工音の一経路での比較、許諾済み配信素材でのNR評価。
- 製品のSRC・VSTを含む1時間以上の運転とASIOマイクの実機回帰。

OSが完了を返さない故障や遅い通知は、単体の状態遷移と寿命を確認したもので、Windows側に故障を注入した実証ではない。
取得が成立した環境に限って段階1をローカル実装する判断と、全受入条件の完了・公開判断を分ける。
全環境でケーブル不要、単一エンドポイント対応、音楽鑑賞対応済みとは表示しない。

後続の[段階1のChrome・VLCの確認](PROCESS_LOOPBACK_ACCEPTANCE_2026-11-02.md)では、製品SRCとTDR Novaを含む各65分のEngine運転を完了した。
callback遅延と素材リピート境界の待機を記録しており、聴感や上記の未検証条件を完了した扱いにはしない。

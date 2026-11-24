# テスト計画書 (Verification Plan)

本アプリケーションの品質、安定性、および使いやすさを確認するための自動・手動テストの手順です。

日常の入口は`npm run verify -- --changed`、全フロントは`--full`、Rustの関連検証は`--static --rust`。
準備・出力・既存負債の扱いは[GARDENING](GARDENING.md)、機能からの探索は[feature-map](feature-map.md)を参照する。

類似アプリとの比較やリソース使用量を含む評価の軸は [EVALUATION_CRITERIA.md](EVALUATION_CRITERIA.md) に定める。

検証用のビルド・一時領域の作成と終了後の整理は [ビルド領域・容量管理](BUILD_GUIDE.md#ビルド領域容量管理) に従う。並行検証に必要な隔離と証跡を保ち、再生成可能な成果物を作業ごとに残し続けない。

## Tauri MCP による実アプリの確認

通常の `npm run tauri dev` と配布設定は、意図的に `withGlobalTauri: false` とする。MCPによるWebView操作・撮影には、debugビルド限定のbridgeとグローバルAPIを有効にする上書きが必要である。[セキュリティ設定](SECURITY_RUNTIME.md)を参照し、通常設定やcapabilityを変更しない。既存アプリが動作中なら音声や保存状態への影響を確認してから扱う。

リポジトリルートで、必要なsidecarを `npm run rebuild-engine` で準備した後、専用のターミナルで次を起動する。

```powershell
npm run tauri -- dev --config src-tauri/tauri.debug-global.conf.json
```

別のターミナルでCLIのセッションを開始し、状態の `connected: true` を確認する。開始コマンドの成功だけでは接続を意味しない。CLIには複数のbinがあるため、パッケージと実行binの両方を指定する。以下は確認済みのCLI版 `0.13.2` の例。

```powershell
npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp driver-session start --host 127.0.0.1 --port 9223
npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp driver-session status --json
```

接続後、保存先と操作対象を確認して撮影・操作する。次の例はアプリの設定を開いた状態で、外観タブへ切り替える。複数アプリがある場合は起動したHostに対応するポートを特定し、各操作の `--app-identifier` に指定する。9223が使用中ならbridgeの実際のポートを確認して接続する。

```powershell
npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp webview-screenshot --file before.png
npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp webview-interact --action click --selector '[role=tab][id$="-trigger-appearance"]'
npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp webview-screenshot --file after.png
npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp driver-session stop --app-identifier 9223
```

撮影は表示中の範囲をファイルに保存する。操作は音声開始や設定変更を含み得るため対象を確認する。MCPクライアントから使う場合のサーバー入口は `npm run mcp:tauri`。実アプリの画面確認は実音声・聴感の合格とは分けて記録する。

NR・内蔵処理を変更するPRでは、[歌枠の回帰手順](SINGING_REGRESSION.md)の A-1・A-3・A-5 と二系統／処理分離を確認し、条件・結果・未実施を記録する。初回基準や実機・素材がない場合は未確認として残し、準備や自動試験の成功を歌枠の合格にしない。

## 旧の通知とコマンドの応答の到着順の測定（W5）

目的は、(a) Rust が `emit` を呼んだ順序、(b) WebView が通知を受け取った順序、(c) WebView が `invoke` の応答を受け取った順序を、**分けて記録し、照合する**こと。コードの読み取りでは (a) しか分からない（互換の契約 5章・9章）。測定は実際の Tauri と音声機器を使うので、開始・停止を行ってよい環境で、操作の対象を確認してから行う。結果を、IPCモックの試験や聴感の合格とは分けて記録する。

`window.__TAURI_INTERNALS__.invoke` は Tauri 2 では書き換えられないので、WebView 側の計測点はアプリのコードに置く。`src/lib/w5Probe.ts` が、開発ビルド（`import.meta.env.DEV`）だけで、次を `window.__auralynW5` へ順に並べる。本番ビルドでは分岐ごと消える（`w5Probe.test.ts` が本番での無効を確かめる。コードが消えることは、`vite build` の出力に `__auralynW5` が残らないことで確かめる）。

- `invoke-called`／`invoke-resolved`／`invoke-rejected`：`audioApi.start`・`stop`・`restart` が `invoke` を呼んだ時点と、応答（拒否）を受けた時点。
- `listen-registered`／`listen-failed`：旧の通知（`audio-conditions-changed`、`audio-started`、`audio-stopped`、`audio-stream-error`、`audio-error`、`audio-engine-exited`、`live-modes-invalidated`）の購読が登録できた時点。
- `event`：その通知を受け取った時点。

各行は `{ i, kind, name, unix_us }`。`i` は WebView 内の記録の順、`unix_us` は壁時計で、Rust の記録と同じ基準。

1. **起動する前に、Host と子（サイドカー）の版をそろえる。この手順は、上の一般の起動手順（`npm run rebuild-engine` を含む）の代わりに、独立して行う。** 背景：Host は自分と同じフォルダー（`$env:CARGO_TARGET_DIR\debug\audio_engine.exe`）の子を最初に使う（`audio.rs` の `spawn_engine_process` の探索順）。そのファイルは、Host のビルド（`build.rs` の `tauri-build`）が、`externalBin` の元ファイル（`src-tauri/bin/audio_engine-x86_64-pc-windows-msvc.exe` と `plugin_scanner-x86_64-pc-windows-msvc.exe`）から上書きでコピーする。`externalBin` の元ファイルが1本でも無いと、どの `cargo build` でも `build.rs` が失敗する（`npm run rebuild-engine` の中の `cargo build` も同じ）。`tauri dev` の `beforeDevCommand` はサイドカーをビルドしない。古い子が残っていると、今の Host は旧い形の `Stopped`（`payload` がない）をパースエラーとして捨て、`audio-stopped` が出ない（過去にこれで誤った結果を得た）。**実測した構成は、debug の Host と release の子の組み合わせ**。リポジトリのルートの PowerShell 7 で、次を順に実行する。各段は、前の段が成功したときだけ進む（`throw` で止まる）。

   ```powershell
   # (a) 共有の target を絶対パスで指定し、externalBin を空にする（scripts/test-native-e2e.mjs と同じ既存の方法）。
   $env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri\target'
   $env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'
   # (b) 元ファイルが2本そろっていなければ（最初の環境）、サイドカーを2本作って置く。debug 版が入るが、(d) で audio_engine を上書きする。
   $bin = 'src-tauri\bin'
   if (-not ((Test-Path "$bin\audio_engine-x86_64-pc-windows-msvc.exe") -and (Test-Path "$bin\plugin_scanner-x86_64-pc-windows-msvc.exe"))) {
     npm run rebuild-engine; if ($LASTEXITCODE -ne 0) { throw 'rebuild-engine failed' }
   }
   # (c) release の子を作る。
   cargo build --release --locked --manifest-path src-tauri/Cargo.toml --bin audio_engine
   if ($LASTEXITCODE -ne 0) { throw 'release build failed' }
   $release = Join-Path $env:CARGO_TARGET_DIR 'release\audio_engine.exe'
   # (d) release の子を Tauri がコピーする元へ置き、更新時刻を今にする（Cargo は更新時刻で build.rs の再実行を判断する。古い時刻のままだと再実行されず、debug フォルダーの子が古いまま残ることがある）。
   $src = "$bin\audio_engine-x86_64-pc-windows-msvc.exe"
   Copy-Item $release $src -Force -ErrorAction Stop
   (Get-Item $src -ErrorAction Stop).LastWriteTime = Get-Date
   $srcHash = (Get-FileHash $src -ErrorAction Stop).Hash
   $releaseHash = (Get-FileHash $release -ErrorAction Stop).Hash
   if (-not $srcHash -or $srcHash -ne $releaseHash) { throw 'copy mismatch' }
   # (e) externalBin の上書きを解除し、トレースを有効にして Host を起動する（Host のビルドが、(d) の子を debug フォルダーへコピーする）。
   Remove-Item Env:TAURI_CONFIG
   $env:AURALYN_EMIT_TRACE = '1'
   # --no-watch：監視モードではコンパイルに失敗しても終わらず、終了コードで止められないため。
   npm run tauri -- dev --no-watch --config src-tauri/tauri.debug-global.conf.json *> w5-dev.log
   if (-not $? -or $LASTEXITCODE -ne 0) { throw 'tauri dev failed: see w5-dev.log' }
   ```

   `rebuild-engine` の `cargo build` は環境変数を引き継ぐので、(a) の `TAURI_CONFIG` が効き、元ファイルが無くても `build.rs` は失敗しない。`AURALYN_EMIT_TRACE` は測定用で、既定では無効（`emit` ごとの追加の費用は、無効のときは真偽値の読み取り1回）。

   (f) **起動した後で、実際の子を照合する。** 別のターミナルで次を実行し、`True` と、`debug\audio_engine.exe` のパスが出ることを確かめる。ログ（`w5-dev.log`）に `Engine IPC parse error` が1件でもあれば、その回の結果は使わない。ハッシュが合わなければ、Host を止めて (d) からやり直す。

   ```powershell
   $release = Join-Path $PWD 'src-tauri\target\release\audio_engine.exe'  # リポジトリのルートで実行する
   $debugDir = Join-Path $PWD 'src-tauri\target\debug'
   $hostProc = @(Get-CimInstance Win32_Process -Filter "Name='AuralynHost.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $debugDir 'AuralynHost.exe') })
   if ($hostProc.Count -ne 1) { throw "expected one debug Host, found $($hostProc.Count)" }
   $child = @(Get-CimInstance Win32_Process -Filter "Name='audio_engine.exe' AND ParentProcessId=$($hostProc[0].ProcessId)" | Where-Object { $_.CommandLine -notmatch '--post-mix-worker' })  # 配信VST用の子を除く
   if ($child.Count -ne 1) { throw "expected one child of the Host, found $($child.Count)" }
   $child[0].ExecutablePath
   (Get-FileHash $child[0].ExecutablePath -ErrorAction Stop).Hash -eq (Get-FileHash $release -ErrorAction Stop).Hash
   ```

   子の生の IPC の行は、同じファイルを単独で起動して標準入力へ命令（`{"type":"Stop"}` など）を送ると読める。`cargo test`、`cargo build --bin audio_engine`、`npm run rebuild-engine` は、debug フォルダーの子を debug の子に戻すので、測定の間は実行しない。**注意：今のソースから作った debug の子は、WASAPI の実機を開く `Start` で `thread 'main' has overflowed its stack`（0xC00000FD）により落ちる。debug の子では W5 を測れない。#829 で扱う。**
2. 起動したら、「Tauri MCP による実アプリの確認」のうち、**CLI のセッションを開始して `connected: true` を確かめる部分だけ**を行う。その節の起動手順（`npm run rebuild-engine` と `tauri dev`）は実行しない（release の子を debug の子で上書きするため）。
3. Rust 側の記録は、ログの `emit-trace` の行。`seq` は呼んだ順の通し番号、`kind=emit` は `emit` を呼ぶ直前、`kind=return` は `start_audio`・`stop_audio`・`restart_audio_engine` が結果を返す直前、`unix_us` は壁時計、`thread` は呼んだスレッド。
4. WebView 側の記録は、アプリを開いた時点で入っている。購読の登録の完了（`listen-registered`）が揃ってから測る。`window.__auralynW5.length` を、場面の前後に控える。
5. 画面から次の場面を、それぞれ10回以上行う（同じ機器・同じ設定）。呼ぶのは、画面と同じ `audioApi`（開発ビルドでは、WebView から `import('/src/api/audio.ts')` で得られる）。A：開始の成功＝`audioApi.start(host, input, output, bufferSize, sampleRate, inputId, outputId, undefined, routing)`（保存した設定の値）。B：開始の失敗＝同じ `start` の入力と出力を `'no-such-device'` にし、機器 ID と `routing` を渡さない。C：停止（接続あり）＝`audioApi.stop()`。D：停止（接続なし）＝開発セッションで子のプロセスを終了させ、**次の2つの両方**を確かめてから（reader が無効になったこと＝`audio-engine-exited` と `audio-error` を WebView が受け取ったこと、**かつ**、対象の子の PID が OS 上で終わったこと＝`Get-Process -Id <PID>` が見つからないこと。通知を受け取っても、`try_wait()` が終了をまだ返さなければ、停止は終了済みの接続の後始末の経路（`reap_confirmed_stopped_connection`）に入らない） `audioApi.stop()`。次の回のために、`start` で子を起動し直す。E：再起動＝A と同じ引数の `audioApi.restart(...)`。**観測の区間は、始まりを `invoke-called`、終わりを各呼び出しの応答（`invoke-resolved` または `invoke-rejected`）の 700ms 後**とし、その間に届いた通知を、その場面に数える。
6. `JSON.stringify(window.__auralynW5)` を `webview-execute-js` で読み、`emit-trace` の行と、名前の出現順で突き合わせる。記録するのは、(a) Rust が呼んだ順（`seq`）、(b) 通知を WebView が受け取った順（`event` の `i`）、(c) 応答を受け取った順（`invoke-resolved`。**開始の失敗（B）の応答は `invoke-rejected`**。成功だけでなく、拒否の応答も同じ列で照合する）、(d) (a) と (b)、(a) と (c) が食い違った回数と場面。`emit` を呼んだのに `event` が来なかった通知は、欠落として別に数える。同じ場面の `unix_us` の差（Rust の `emit` から `event` まで、`return` から `invoke-resolved`／`invoke-rejected` まで）も控える。`audio-stopped` は、**B と C に限って**、`audio-conditions-changed` の後、応答の前に届くことを確かめる。**D では出ない**（子へ `Stop` を送らず、`kill_engine` の経路を通る）。A と E でも出ない。
7. 結果は互換の契約（9章）へ、機器・設定・回数とあわせて追記する。測定前は「未測定」とする。

ホームの状態別主操作（#160〜#163）は `e2e/browser/home-actions.spec.ts` で確認する。960×640 の開始操作、機器IDの引継ぎ、開始失敗と開始後の設定失敗、設定からの復旧後の警告解除、送り先選択へのスクロール・キーボードフォーカス、3テーマのセグメント寸法と注意域メーターを扱う。本番保護中の経路維持と入力ペアの再適用禁止は `src/lib/__tests__/startHomeAudio.test.ts` で確認する。これらはIPCモック・ローカル試験であり、実機での開始・実音声の到達は別途確認する。

ASIOの入出力（#205〜#207）は `e2e/browser/asio-routing.spec.ts` で、入力3/4と独立出力1/2、同番号へ返すinsert、保存後の再表示を確認する。設定画面のDOM試験では初回接続・旧設定の互換モード・同名機器ID・保存のみの再試行を扱う。`useAudioConnectionController.test.tsx` は実レート／バッファの同期で選択機器が戻らないことも確認する。Rustの `channel_routing_tests` と `queue_diagnostics` は開始前の範囲検証、異なる入出力数、最初のフレームの転送先とRT無割当を確認する。

新規ASIO接続は最初の入力ペアと独立出力1/2を既定とし、既存の出力設定がないデータは従来の返却方法を維持する。能力未取得の機器は開始時に検証し、信号検出だけで入力を変更しない。実機では、入力3/4→出力1/2、insert3/4→3/4、mono、旧保存設定からの起動、プロファイル／配信設定の適用・復元を別途確認する。ブラウザ試験はドライバーの動作や聴感の証拠には含めない。

ASIOのnative形式はF32・I16・I24・I32を扱う。整数形式はストリームの構築前に変換領域を確保し、音声callbackで再確保しない。`native_stream` の試験で端値・非有限値・上限超過時の無音化と失敗通知を確認する。変換器の単体成功を、その形式の実ドライバー開始成功へ読み替えない。F64は固定版CPALのASIO構築で未対応であるため拒否する。既定レート0は欠測として扱い、失敗時に無効な既定値へ再試行しない。

WASAPIは入力を先に開始し、制御スレッドで要求バッファ2個分の入力到着を待ってから出力を開始する。待機は100 ms～1秒で打ち切り、入力失敗・未到着では出力を開始しない。ASIOの共有driverは従来の出力→入力順を維持する。要求サイズと実際のcallbackサイズは異なる場合があり、この準備だけで開始時・稼働後の不足や物理遅延が解消したとは扱わない。開始応答時間、キュー滞留時間、ゼロ埋めの総数・開始区間・その後の増分を同じ機器で反復比較する。

性能比較は [NATIVE_PERFORMANCE_COMPARE.md](NATIVE_PERFORMANCE_COMPARE.md) に従い、同じdev/release構成・機器・rate/buffer・処理・ミュート条件で版を交互に各3回以上測定する。Host全体はWebViewとengineを含む子プロセスも観測する。ビルドや別の試験を同時に走らせず、private/working setの標本最大とOSのプロセス単体の生涯ピークを区別する。`glitch_count` は出力処理の入口間隔が期待周期の1.5倍を超えた回数であり、実際の音切れ数ではない。無音と処理停止の区別、および直近60秒の遅着・underflowは [ISSUE_449_IMPLEMENTATION.md](ISSUE_449_IMPLEMENTATION.md) を参照する。整数変換時間は現在の `callback_diagnostics.processing_us` に含まれないため、CPU全体と併記する。

## 自動テストの層と実行方法

- `npm run test:user-docs`：日英10ページ、見出しの印、リンク、UI名、表記、使い方の全用語を照合する（起動が書き込み制限で失敗する場合は `npm run test:user-docs -- --configLoader runner`）。

### Pull Requestの自動チェック

`.github/workflows/rustsec-audit.yml` は PR・main 更新・週次・手動で `src-tauri/Cargo.lock` を最新の RustSec DB と照合する。ローカルでも依存更新時とリリース前に `cargo audit --file src-tauri/Cargo.lock` を実行する。導入と例外の扱いは [DEPENDENCY_MAINTENANCE.md](DEPENDENCY_MAINTENANCE.md) を参照する。これは署名、実機、Rustビルドの検証とは別であり、GitHub 上の実行結果と branch protection 設定は別途確認する。

`.github/workflows/frontend-quality.yml` はPR、main更新、手動実行でWindows上のフロント品質を確認する。
Node.js 24・Python 3.12とlockfileを使い、設定指紋・ESLint・Ruff・検査器の試験、全Vitest、TypeScript、UI用語、Vite、配布スクリプト試験、配布方針チェック、ChromiumのIPCモック試験を実行する。
単体・DOM・型・配布の `checks` と、本番ビルド・Chromium試験の `browser` を別runnerで並行実行する。
最後の `frontend` は両jobの成功を要求し、失敗・取消・skipを成功扱いにしない。既存の必須チェック名は維持する。
ブラウザ試験はCIで全件を4台に分け（`--shard=1/4`〜`4/4`）、各台はファイル単位の2並列とし、ファイル内の試験は直列を保つ。分割はファイル単位で、全件を回すことは変わらない。1台でも失敗・取消になれば、必須チェック `frontend` は失敗する。手元は既定1並列で、`--workers=2` を指定して同じ並列数を試せる。
並列数・重複ケースの判断と代替ツールの試作は [2026-11-06の比較記録](CI_BROWSER_STUDY_2026-11-06.md) を参照する。
ローカルでの対応コマンドは下表と `docs/BUILD_GUIDE.md` を参照する。
失敗したブラウザの証拠は`ci-artifacts/browser`、検証CLIの詳細は`test-results/gardening`から7日間のartifactへ保存する。
既存証拠を含む `test-results` の初期化を避け、公開・デバイス開始・通常設定の変更は行わない。

これらのjobはRustビルド、実Tauri、ASIO/WASAPI、聴感、長時間運転の合格を表さない。
workflowの追加とGitHub上での実行成功は別に記録する。branch protectionへの必須チェック登録はリポジトリ管理者が設定する。
Actionsは公式リポジトリのcommitへ固定し、更新時は [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[upload-artifact](https://github.com/actions/upload-artifact) の対応runner・Node要件を確認する。

`npm run lint:terms` は、`src/i18n/messages.ts` の日本語と英語を `config/ui-terms.json` と照合する。使わないと決めた語、かぎかっこや空白だけを挟んだ同じ語句の重なり（英語は同じ単語の連続）、用語集の使う語から離れた定義を、人の評価より前に止める。CI の frontend 品質では `checks` がこの検査を実行する。

直すときは、失敗したキーの文言を `docs/DESIGN.md` 4章の使う語へ合わせる。その語が文脈上正しいときは、`config/ui-terms.json` の `allow` に `key`、`term`、`reason` を足す。用語を足したり変えたりしたときは、4章の表と `terms` の `use` を両方更新する。`use` が4章の使う語の列に無いと検査は失敗する。

`npm run lint:preview-urls` は、`e2e/` の `*.spec.ts`（画面記録の `*-shots.spec.ts` を除く）の文字列とテンプレートの断片に、`?mock=`・`?screen=`・`&screen=` が無いか調べる。コメントと正規表現リテラルは対象外。複数の文字列をつないで組み立てた URL は見つけられない。これらは開発サーバーだけにあり、CI の本番ビルドでは開けないため、試験の模擬応答（`tauriFixture`）と UI 操作で画面を開く。`npm run verify -- --static` は `terms` の次の段でこの検査を実行する。

| 層 | 目的 | 実行 |
| --- | --- | --- |
| 単体（Node / Rust） | 計算・変換・バリデーション・IPC引数・状態遷移 | `npm run test:unit`、下記Rust検証 |
| DOM / コンポーネント（jsdom） | UI操作・表示・操作禁止・非同期応答。Storageやwindowイベントを使うロジックも含む | `npm run test:dom` |
| 実ブラウザ（IPCモック） | CSS・実際のスクロール・重なり・hit test・キーボード操作 | `npm run test:e2e` |
| 実Tauri / 実sidecar（IPCモックなし） | UIからRustへの保存、Host終了・再起動後の復元、実エンジン応答と画面反映 | `npm run test:e2e:native` |

`npm test -- --run --maxWorkers=4` はNodeとjsdomの両方を実行する。

`scripts/native-obs-timeout-check.cjs <製品Host.exe> <新規出力先>` は、音声停止・一時利用領域で実OBS接続待ち中の設定画面closeと別IPCの応答を検査する。相手はloopbackの無応答handshakeで、実OBS・通常資格情報を使わない。DOMの非表示回帰試験、物理トレイ復帰、聴感の確認とは別の証拠である。

更新ありのCSP経路は `scripts/native-updater-fixture-check.cjs prepare|dry-run|run <新規updater-fixture-名前>` を使う専用fixtureで確認できる。`prepare` は試験用鍵・asInvokerのmarker用PE・feed/configを作る。秘密鍵はcommitや検証artifactへ含めない。`run` 前に生成configを `TAURI_CONFIG` に指定してcustom-protocolのrelease Hostとsidecarをビルドし、fixtureのbinへ同じbuildをコピーする。製品CSPを変更しない。`AURALYN_TEST_PYTHON` はインストール済みPythonの絶対パスを明示する。`dry-run` はレジストリを変更せず、`run` は専用GUIDのUninstall metadataを一時作成し、値・型・子キーの一致を照合して単一削除する。通常のインストール先や既存レジストリ値を使わない。生成物は毎回新規とし、失敗時も所有記録と通常profileの前後hashを確認する。

署名CLIのhelpは環境変数の値を表示しうるため、署名鍵のある親環境のままCLIを起動しない。fixtureハーネスは子の環境をallowlist化し、signerの出力を破棄する。`run` の成功は署名付き試験PEの取得・起動までで、実NSISによる新版導入・再起動・設定保持の合格ではない。
同時worker数は既定で4に制限する。CPU数が多い環境でもDOM環境を過剰に同時起動せず、必要ならCLIの `--maxWorkers` で変更する。
Node対象は `vitest.config.ts` に明示し、DOM・Storageを使うテストへブラウザの偽物を足してNode化しない。
単純なReact setterの確認を増やさず、アプリ固有の設定タブ選択などの契約を検証する。
ロジックの境界値と、その結果を受けた画面の反応は異なる責務なので両方を維持する。

入力名によるマイク候補の判定は `wizardModel.test.ts` のNode試験に集約し、画面では未選択時の操作禁止と明示選択を確認する。
ショートカットの件数上限は保存済み8件から9件目を入力して確認し、既存8件を毎回画面から作り直さない。
ボイスチェックのpoll競合は仮想時計で検証する。要求待ち中のpoll抑止に加え、応答後にpollが動くことも確認する。
保存とエンジン再起動は別実装なので、移行の開始・チャンネル設定・確認完了の失敗条件は両入口で維持する。

初回は `npm ci` と `npx playwright install chromium` を実行する。
実ブラウザ試験は専用ポート1427のViteを起動し、既存サーバーを流用しない。
900×600のライト・ダーク・ゲーミング、1024×768の200%ページ拡大で、初回画面・設定・ライセンスの操作とフォーカス復帰を検証する。
200%ページ拡大はWindowsの実DPI変更とは別の検証である。
未定義IPCとブラウザの実行時例外は失敗にし、モックの既定成功で隠さない。
右の列の入出力メーターは、パネルを重ねても隠れない。出力の dBFS はピーク保持、バーは平滑化値である。大型メーターは置かない。
入力・出力音量、緊急ミュート、モード初回取得の通信失敗を注入し、保存値の保護、次の行動、再試行を確認する。モックでの失敗注入は実機障害の証拠とは分ける。
通常画面の評価ではミュート・復元警告のない条件を別に用意し、警告を隠して正常扱いにしない。既存の監査画像を保護する場合はPlaywrightの `--output` に新しい専用サブディレクトリを指定する。
失敗時のtraceはignoredの `test-results/` に出力する。

実Tauri試験はWindows 11 x64、Rust・C++ Build Tools・ASIO SDKを含む通常の開発環境が必要。
実行スクリプトが現行ソースからHost・engine・scannerをビルドし、同じビルドの3実行ファイルを専用領域へコピーする。
Tauriの追加設定で識別子・全アプリ保存先・WebView2を一時領域へ分離し、明示開始待ちで起動する。
言語選択を実UIから保存し、Rustの保存ファイルとHostの再起動後の復元を検証する。
診断の更新も実エンジン応答と照合し、存在しないコマンドが拒否されることを確認する。
IPCの置換や音声ストリームの開始は行わない。通常アプリのcapability・設定・OBS設定は変更しない。
終了用capabilityはE2Eの追加設定だけに付ける。
調査用の隔離領域はコンソールに表示して保持する。
Cargoの既定保存先は `src-tauri/target/native-e2e`。通常開発とは異なるdebug設定・Tauri設定で通常の成果物を入れ替えないよう分離する。
初回は専用領域へのビルド時間とディスク容量が必要になる。任意の `CARGO_TARGET_DIR` を指定した場合は、その場所をそのまま使う。
毎回の保存先隔離に伴うTauri設定の変化は残るため、実Tauri試験の再ビルドがすべて省略されるわけではない。
ブラウザ用と実Tauri用は同じ専用Viteポートを使うため、同時には実行しない。

### 開発プレビューの模擬応答（`?mock=`）

ブラウザ画面試験のIPCモックの本体は `src/dev/tauriMock.ts` にあり、`e2e/browser/tauriFixture.ts` と開発プレビューで共有する。開発サーバー（`npm run dev`）で `http://localhost:1420/?mock=<状態>` を開くと、Tauriなしのブラウザで画面を再現できる。用途は Pencil（pen.dev）などのデザインツールへの取り込みと見た目の確認で、音声処理・IPC・実機の受入には使わない。

- 状態は `live-home`（実行中・登録済みモード）、`live-home-builtin`（内蔵エフェクトON）、`stopped-home`（停止中）、`first-run`（初回セットアップ）。定義は `src/dev/previewMock.ts`。クエリを足さないときの意味は変えない。`devices=realistic` は言語に依存しない機器名（既定の `devices` は `legacy` で、実行中は `CABLE Output` / `スピーカー`、未設定の試験は `Test microphone` / `Test headphones`）。`registered=0` または `registered=1` は、その状態の歌・雑談の登録だけを上書きする。`purpose=music` は表示用途を音楽鑑賞にして保存し、`purpose=voice` はその保存値を消す。`purpose` を省いたときは、開く前からある表示用途を残す。
- 画面は `?screen=` で最初から開く。`settings-audio`（接続のページ）、`settings-sound`（音づくり）、`settings-obs`、`settings-appearance`、`settings-shortcuts`、`settings-system`（設定の各区分）、`obs-guide`、`discord-guide`、`troubleshoot`、`voice-check`、`help`、`plugin-browser`、`presets`、`template-wizard`、`license`、`stream-mix`、`vst`（`vst-panel` も同じページを開く）。起動の覆いが消えると `html` の `data-auralyn-preview` にその名前（画面指定がなければ `home`）が付く。接続・音づくり・設定は中央のページで、`[data-settings-page]` に出る。診断情報や確認などのモーダルは `#root` の外に出るため、取り込みは `body` を使う。
- 設定済みの状態では、開いたブラウザの localStorage にセットアップ完了と機器設定を書き込む。状態が持つ保存値以外は、切り替えるたびに消す。プレビュー専用のブラウザで使う。
- 未定義のIPCはプレビューでは失敗させず `window.__e2eUnexpected` に記録する。試験（`strict: true`）では従来どおり失敗させる。
- 読込は `vite.config.ts` の serve 専用プラグインで行い、本番ビルドには含まれない。Tauri上（`__TAURI_INTERNALS__` がある場合）では何もしない。
- Pencil へは、内蔵ブラウザで上記URLを開いて `#root` を取り込む。取り込み幅はブラウザの表示幅に従うため、幅を揃えたいときは CDP の `Emulation.setDeviceMetricsOverride` で指定してから取り込む。取り込んだものは静的な写しで、コードとは同期しない。
- 段階 H（広い窓）の出し分けと拡大は `e2e/browser/large-window.spec.ts` で確かめる。寸法の正本は `src/lib/largeWindow.ts`。画面記録は `RENEWAL_H_SHOTS=1` のときだけ `e2e/browser/design-renewal-h-shots.spec.ts` が `docs/verification/design-renewal-h/` を上書きする。通常の `npm run test:e2e` では撮らない。`RENEWAL_SHOTS` とは別の変数にする。

### 利用者目線の評価の撮影

開発プレビューを決まった窓で撮り、PNG と画面の文字（`document.body.innerText`）を評価者に渡す手順です。音声処理・実機の受入には使いません。通常の `npm run test:e2e` と CI の Browser tests には含まれません。撮影ファイルは `e2e/ux-eval/capture.ts` で、Playwright の設定は `playwright.ux-eval.config.ts` です。既定の設定の `testDir` は `e2e/browser` なので、このファイルは拾われません。

```powershell
npm run capture:ux-eval
```

撮影は、`CI` や `E2E_PREVIEW` が立っていても、いつも開発サーバー（`npm run dev`、`http://127.0.0.1:1427`）を起動します。`?mock=` の模擬は開発サーバーにしか入らないためです。ほかの試験が 1427 を使っているときは、`UX_EVAL_PORT` で別のポートを指定します。

出力先は `test-results/ux-eval/<日付>-<ブランチ名の最後の区間>-<短いSHA>/` です。日付は実行したマシンのローカル日付、SHA は `git rev-parse --short=8 HEAD` の8文字です。ブランチ `codex/ux-eval-capture-716` なら区間は `ux-eval-capture-716` です。フォルダーごと別の場所にするときは、環境変数 `UX_EVAL_OUT` にそのパスを指定します。

中は4つです。各フォルダーに `README.md` があり、ファイル名と状態を一覧にします。

| フォルダー | 窓 |
| --- | --- |
| `w900` | 900×600 |
| `w1024` | 1024×768 |
| `w1280` | 1280×800 |
| `w1440` | 1440×900 |

`w1440` は、ヘルプにある「窓が広いときは接続の列がホームの右に開く」を撮るためです。幅の境は 1400px（`docs/DESIGN.md` 10.8、`src/lib/largeWindow.ts` の `connectColumnMinWidth`）です。

各ショットは同名の `.png` と `.txt` です。撮る前に「音声エンジンを起動しています…」（英語は `Starting the audio engine…`）が消えるのを待ち、開いたページまたはダイアログが見えるまで待ちます。スクリーンショットは `animations: 'disabled'` です。撮る前に、撮影の都合の表示が出ていないことも確かめます（どの画面にも「そろえる」が無いこと。`voice-check` は録音の操作が使え、録音前に試聴の欄と「試聴の準備ができませんでした」が出ないこと）。テーマは `vst_host_theme`、言語は `vst_host_locale` を、ページを開く前に書きます。URL だけではテーマと言語は変わりません。

機器名はすべて `devices=realistic` です。入力の候補は `Yeti Stereo Microphone` と `CABLE Output (VB-Audio Virtual Cable)`、出力の候補は `CABLE Input (VB-Audio Virtual Cable)` と `USB Headphones` です。配信の保存値は Yeti → CABLE Input、音楽鑑賞の保存値は CABLE Output → USB Headphones です。名前は言語に依存しません。`devices` を付けないプレビューと既存のブラウザ試験は、これまでどおり `CABLE Output` と `スピーカー` です。

| ファイル | 模擬 | 画面 | 用途 | 実行 | 登録 | 言語 | テーマ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `setup-first` | `first-run` | セットアップ | 配信 | 未設定 | 未登録 | 日本語 | ダーク |
| `home-voice` | `live-home` `registered=0` | ホーム | 配信 | 実行中 | 未登録（見出しは「いまの声」） | 日本語 | ダーク |
| `home-voice-registered` | `live-home` | ホーム | 配信 | 実行中 | 登録済み（見出しは「いまの調整」） | 日本語 | ダーク |
| `home-voice-unmuted` | `live-home` | ホーム | 配信 | 実行中 | 登録済み（出力ミュートを解除してから撮る） | 日本語 | ダーク |
| `home-voice-builtin` | `live-home-builtin` | ホーム | 配信 | 実行中 | 登録済み（声を整える ON） | 日本語 | ダーク |
| `home-stopped` | `stopped-home` `registered=0` | ホーム | 配信 | 停止中 | 未登録 | 日本語 | ダーク |
| `home-voice-gaming` | `live-home` | ホーム | 配信 | 実行中 | 登録済み | 日本語 | ゲーミング |
| `home-voice-light-en` | `live-home` | ホーム | 配信 | 実行中 | 登録済み | 英語 | ライト |
| `home-music` | `live-home` `purpose=music` | ホーム | 音楽鑑賞 | 実行中 | 登録済み | 日本語 | ダーク |
| `home-music-stopped` | `stopped-home` `purpose=music` | ホーム | 音楽鑑賞 | 停止中 | 登録済み | 日本語 | ダーク |
| `home-music-en` | `live-home` `purpose=music` | ホーム | 音楽鑑賞 | 実行中 | 登録済み | 英語 | ダーク |
| `vst` | `live-home` | VST | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `vst-music` | `live-home` `purpose=music` | VST | 音楽鑑賞 | 実行中 | 登録済み | 日本語 | ダーク |
| `sound` | `live-home` | 音づくり | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `sound-music` | `live-home` `purpose=music` | 音づくり | 音楽鑑賞 | 実行中 | 登録済み | 日本語 | ダーク |
| `audio` | `live-home` | 接続 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `setup-music-input` | `first-run` | セットアップの入力の手順（音楽鑑賞を選んで進む。`wizard.musicInputHint` が見える） | 音楽鑑賞 | 未設定 | 未登録 | 日本語 | ダーク |
| `setup-music-output` | `first-run` | セットアップの出力の手順（同上） | 音楽鑑賞 | 未設定 | 未登録 | 日本語 | ダーク |
| `audio-music` | `live-home` `purpose=music` | 接続（「仮想ケーブルを使う場合の接続」を開いて、`processInput.cableHelpMusic` が見える） | 音楽鑑賞 | 実行中 | 登録済み | 日本語 | ダーク |
| `appearance` | `live-home` | 外観 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `obs` | `live-home` | OBS連携 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `system` | `live-home` | システム | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `shortcuts` | `live-home` | ホットキー | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `stream-mix` | `live-home` | 配信ミックス | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `stream-mix-en` | `live-home` | 配信ミックス | 配信 | 実行中 | 登録済み | 英語 | ダーク |
| `plugin-browser` | `live-home` | VSTを追加 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `voice-check` | `live-home` | ボイスチェック | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `presets` | `live-home` | 設定の保存・復帰 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `troubleshoot` | `live-home` | 音のトラブルを診断 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `help` | `live-home` | 使い方 | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `template-wizard` | `live-home` | 構成テンプレート | 配信 | 実行中 | 登録済み | 日本語 | ダーク |
| `obs-guide` | `live-home` | OBS連携ガイド | 配信 | 実行中 | 登録済み | 日本語 | ダーク |

上の表で `registered` や `purpose` を書いていない行は、その `mock` の既定です。`live-home` と `stopped-home` と `live-home-builtin` は登録済み、`first-run` は未登録です。音楽鑑賞の見出しは「音楽鑑賞」（英語は `Music listening`）で、歌・雑談の札は出ません。

#### 模擬データの限界

この撮影は Tauri も音声機器も動かしません。次は模擬の都合です。アプリの不具合として数えないでください。

- **ノイズ低減のモードを返さない。** `get_engine_runtime_stats` は `noiseReductionMode` を含めません。弱・強は、エンジンが返したモードとしては選ばれません。
- **出力ミュートの初期値。** 模擬の `muted` は `true` で始まります。統計が届くと、いまの状態に「音を送っていません」（音楽鑑賞は「音を出していません」）、右の列の札に「出力ミュート・音量ゼロ」（英語は `Not sending sound`・`Muted / 0%`）が出ます（#766）。撮影は統計を待ってから撮るので、この2つが出ます。解除した状態は `home-voice-unmuted` だけです。ミュート中は、実エンジンの緊急ミュート（`audio_engine/core/startup.rs`）と同じく、出力のレベルが 0 になります。右の列の出力ピークは `−∞ dBFS` で、「送る音」（音楽鑑賞は「出力の大きさ」）のバーは動きません。入力のレベルは動き続けます。解除すると出力のレベルが戻り、出力音量を掛けた値になります（`tauriMock.ts` の `__e2eMeterLevels`）。
- **ボイスチェックの試聴先は、評価用の機器名（`devices=realistic`）のときだけ返す。** `voice_check_preview` の `open`・`status`・`devices`・`stop`・`close` に答え、試聴先として `CABLE Input (VB-Audio Virtual Cable)` と `USB Headphones` を返します。録音前のボイスチェックは試聴の準備が成功し、試聴の欄は出ません。録音・再生（`start`、`prepare_*` など）は模擬しないので、録音したあとの画面（試聴の欄、比較、波形）は撮れません。`devices` を付けないプレビューと既存のブラウザ試験は、これまでどおり未定義の IPC で、試聴の準備に失敗します。「試聴の準備ができませんでした」が出たら、撮影の不備です。
- **入力の使い道は、ホームの表示と同じ。** `realisticAudioConfig` は保存値へ `inputSource` を書き、`purpose=music` なら入力の使い道も音楽鑑賞です。接続の「ホームの表示は「…」ですが、入力の使い道は「…」です。」と「そろえる」は、撮影のどの画像にも出ません。実際に不一致が起きたときの文は、ユニット試験で確かめます。
- **声の流れが平ら。** 撮影スクリプトが、実行中の画面へ入力の線形 0.1（`-20.0 dBFS`）のレベルを一定で流します。帯が真っすぐでも、ピークがその値のままでも、処理が止まっている証拠にはしません。
- **ダイアログを直接開いたときの焦点の輪。** 撮影は `?screen=` でダイアログやページを直接開きます。利用者のクリックを通らないので、ブラウザはキーボード操作の扱いにして、先頭の操作（ダイアログの×、ページの見出しなど）に `:focus-visible` の輪を出します。マウスでダイアログを開いたときは出ません。不具合として数えないでください。
- **音楽鑑賞のセットアップの仮想ケーブルの案内は、2か所にあります。** 初回のセットアップの最初の画面「何に使いますか？」の予告は OBS・Discord の側だけです。音楽鑑賞を選んで進むと、入力の手順（2番目）と出力の手順（3番目）に、それぞれの手順で操作する場所を示す文（入力は `wizard.musicInputHint`、出力は `wizard.musicOutputHint`）が出ます。`setup-music-input` と `setup-music-output` が、`first-run` から音楽鑑賞のカードを選んで進み、それぞれの文が見えている状態を撮ります。接続のページの音の元には、閉じた折りたたみ「仮想ケーブルを使う場合の接続」があり、中に `processInput.cableHelpMusic`（CABLE Input と CABLE Output の設定のしかた）があります。`audio-music` が、その折りたたみを開いた状態を撮ります。

評価者へ渡す依頼文と決定済みの一覧（`test-results/ux-eval/<フォルダー>/PROMPT.md` と `DECIDED.md`）は、リポジトリに正本がありません。評価のたびに、撮影フォルダーの中へ作ります。上の項目は、そこへ写してください。

### 画面の状態をまとめて開く（screen-matrix）

ある状態を直したときに、別の状態や別の窓で表示が崩れても次の目視まで気づけないのを、CI で止める試験です。`e2e/browser/screen-matrix.spec.ts`。`npm run test:e2e` に含まれ、CI の Browser tests（`npx vite build` のあと `npx playwright test`）でも回ります。

ホームは、実行中（`?mock=live-home`）・停止中（`?mock=stopped-home`）・未設定 × 配信・音楽鑑賞 × 900×600・1024×768・1280×800・1440×900 × 日本語・英語をすべて開きます。1440×900 は接続の列が常に開く広い窓で、英語の見出しと診断の入口が重なった崩れ（#762）を止めます。配信ミックスも、900×600・1280×800 に 1440×900 を足して開きます。未設定の名前はプレビューの定義に無いので、URL は `?mock=unconfigured` とし、`unconfigured-live.spec.ts` と同じくセットアップ済みで機器設定が無い保存値にします。ほかのページ（音づくり、VST、接続、設定の外観・ホットキー・OBS連携・システム）は実行中だけ、使い方 × 言語 × 900×600 と 1280×800 です。開発サーバーでは `html[data-auralyn-preview]` を待ちます。CI の本番ビルドにはこの印が無いので、無いときは左のレールから同じ画面を開きます。セットアップの最初の画面は、未設定で初めて開いたときに自動で開く状態を、`/` から日英 × 4つの窓（ホームと同じ）で開きます（URL に `?mock=` を付けません）。入場の動きが終わってから測ります。出力のミュートは `setOutputMuted`（`e2eHooks.ts`）で外します。測る前に `e2e/browser/helpers/waitForStableLayout.ts` で、フォントと主な区画の位置が連続3フレーム動いていないことを待ちます。

見えている要素だけを調べます。`aria-hidden` や `inert` の中、大きさ 0、不透明度 0、`visibility: hidden`、閉じた `details`、読み上げ専用の文は除きます。この判定は `helpers/visibility.ts` に1つだけあり、画面の検査（`screenAudit.ts`）と文字の折り返しの検査（`shortLines.ts`）が同じものを使います。折り返しの検査は、さらに親の `overflow: hidden` / `clip` で切り取られた文字を除き、診断の文字列も見えている文字だけから組みます。スクロール領域（`auto` / `scroll`）の中の文字は、スクロールで届くので数えます。ダイアログが開いている画面は、最前面のダイアログだけを調べます（`shortLineRoot`）。この判定の単体試験は `short-lines-helper.spec.ts` と `screen-audit-helper.spec.ts` です。違反は1件1行で、画面・状態・使い方・窓・言語・種類・短いセレクタ・文字の先頭を出します。

- **重なり。** 見えている操作（ボタン、リンク、入力、選択、`role` が button / switch / slider / tab）が、直下に文字がある要素と 2×2px を超えて重なり、親子でないとき。省略で隠れている文字の範囲は、見えている箱の内側だけを見ます。
- **はみ出し。** 文字を持つ要素で `scrollWidth` が `clientWidth + 1` より大きく、`overflow` が `hidden` か `clip` のとき。`title` に全文があるものは除きます。
- **短いラベルの折り返し。** ボタン、見出し（`h1`〜`h4`）、`label`、`data-audit-short` の、直下の文字が3行以上のとき。名前と補足を縦に積んだものは、それぞれの塊で数えます。
- **1〜2文字だけの行。** 日本語のときだけ。画面全体の文字を1文字ずつ描画位置で行に分け、3文字以上ある文のまとまりで、1〜2文字しかない行が出たもの（「反映しま／す。」のような末尾の取り残し。`helpers/shortLines.ts` の `shortWrappedLineDetails`、#708）。英語は語単位で折れるので数えません。語の途中で折れても、残りが3文字以上の行は、この検査では見つかりません。
- **文節で折り返さない日本語（セットアップの最初の画面だけ）。** 日本語を含み、複数行になるブロックで `word-break` が `auto-phrase` でないもの。「音楽を聴／く」「加工／した声」のように、行末が語や文節の途中になる折り返しを、文言が変わっても捕まえます（`unphrasedJapaneseBlocks`）。ほかの画面は、文節で折り返す仕組みをまだ入れていないので対象にしません。
- **同じ文の重複。** 見えている文字を「。」「.」「!」「?」で分け、10文字以上で助詞か英語の機能語がある文が2回以上のとき。ボタン名や行ごとの同じ操作名は数えない。ダイアログが開いているときは、その中だけを数えます。
- **空の枠と、何も続かない区切り。** カード（`rounded-card`、`sound-module-card`、`page-section`、ホーム直下の `section`）で、高さ 40px 以上なのに見出し以外の文字・操作・`canvas`・メーターが無いもの。見出しが枠をほぼ占め、その空きが 24px 未満かつ枠の半分未満の名前の行は空にしない。セットアップのカードの記号の台（`setup-choice-icon`）だけは、描かれている `svg` が直下にあれば空の枠にしない（#720）。アイコンは装飾で `aria-hidden` が付くので、読み上げではなく、描かれているかで見る。大きさで逃がさないのは、幅の広い空のカードや、拡大表示（150%）の台まで見逃す・誤って拾うため。状態の行が無い音調整のカードは、名前の行の塊が約 6rem に収まり、その下の空きが枠の半分以上のときも空の枠にする。実行中のカードは状態の行があるので、隣に合わせて伸びてもこの条件では空にしない（#673）。ただし VST が0件の外部VSTのカード（`data-empty-vst`）は実行中も中身の高さにするため、状態の行があり中身の塊が高くても、中身の下に枠の半分以上の空きが残れば空の枠にする（#769）。`hr`、`role=separator`、枠線だけの要素で、後ろに見える中身が無いもの。
- **用途の混ざり。** 音楽鑑賞のときだけ。日本語は「配信」「OBS」「通話」「歌」「雑談」。英語は語の先頭が Stream、Broadcast、OBS、Sing、Talk。

違反が出たら、表示を直します。検査が間違っているときは `e2e/browser/helpers/screenAudit.ts` を直し、直した理由を残します。まだ直さない崩れは `e2e/browser/screen-matrix.known.ts` の `knownViolations` に、当てはまる画面・状態・使い方・窓・言語と、`match`（セレクタか文字の断片）と Issue 番号を1件足します。Issue が無いものは `issue: 'new'` にします。登録した組み合わせでその違反が出なくなると、「直ったので例外を外してください」で失敗します。その行を一覧から外します。音楽鑑賞でも正しく出る語は、Issue ではなく `purposeAllowances` に `reason` を付けて足します。その文が画面から無くなったときも、同じ失敗で外すよう知らせます。

画面に足してよい印は、次の属性だけです。見た目は変えません。

- `data-audit-overlay` は、切替の途中で重ねる欄など、意図した重なりです。この中の操作は重なり検査から外します。
- `data-audit-truncate` は、省略してよい文字です。はみ出し検査から外します。
- `data-audit-short` は、ボタン・見出し・label 以外で、3行以上の折り返しを調べたい短いラベルです。

### 変更中の確認と全体確認

変更中は対象のテストファイルを `npm test -- --run <対象ファイル> --maxWorkers=4` で実行し、完了時に変更範囲に必要な全体確認を行う。
Rustの単体処理を変更中は `cargo test --locked --lib <対象名>` を使い、IPC・プロセス寿命を変更した場合は対応する統合試験も実行する。
ビルド時間とテスト本体の時間は分けて記録する。フロントだけのビルド確認には `npx vite build` を使う。
外部キューの契約試験やクラス名の確認は件数だけを理由に削除せず、実処理・実画面で同じ契約を検出できることを確認してから整理する。

### 実sidecarのプロセス境界と実機試験

`src-tauri` で `cargo test --locked --test integration_test --test repro_ott` を実行すると、
現行Cargo成果物のsidecarへ実IPCで要求し、未対応hostの拒否、空ラックの順序変更、停止、stdin EOF後の正常終了を確認する。
応答欠落・想定外応答・エラーイベント・強制終了が必要な状態は失敗にする。失敗時も起動した子プロセスを回収する。
実機録音とOTTエディタのテストは理由付きignoreとし、通常の自動テスト成功へ含めない。

以下は入出力デバイス／VST GUIを実際に使うため、その確認を行うときだけ明示実行する。

```powershell
# 既定WASAPI入出力で録音。開始・停止・readyと正の録音時間・正常終了を必須にする。
cargo test --locked --test integration_test audio_engine_hardware_recording_lifecycle -- --ignored
# インストール済みOTTを音声開始なしで読込・GUI表示・閉じる／アンロードする。
cargo test --locked --test repro_ott -- --ignored
```

OTTがない、デバイスを開けない、録音できない、エディタが開けない場合は成功へ読み替えない。
GUI応答の成功だけでは描画欠け・DPI・聴感・OBSへの到達を保証しない。以下の実機手順と分けて記録する。

### 音声エンジンの子プロセスの寿命（W 群。F1a-1、D-13）

設計は [audio-session-controller.md](plans/audio-session-controller.md) の 18.3、合格の行は [audio-session-acceptance.md](plans/audio-session-acceptance.md) の B16・B17・B17b・B18・B40a・D7・W1〜W4。
子は試験の実行ファイル自身（`compat_support.rs` の台本つきの子）で、製品と同じ手順（停止の状態で作成、Job への割り当て、`ResumeThread`）を通る。
差し替えは `#[cfg(test)]` の `engine_life::seam` だけ（Job の作成・割り当て・再開の戻り値・`try_wait`・時計。試験のスレッドごと）。本番に差し替え口はない。

```powershell
Set-Location D:\Programming\App\VSTHost\src-tauri
$env:CARGO_TARGET_DIR = 'D:\Programming\App\VSTHost\src-tauri\target'
cargo test --locked --lib audio::engine_life_tests
cargo test --locked --lib audio::post_mix::life_tests
```

| 行 | 試験 | 種別 |
|---|---|---|
| W1a | `w1a_job_creation_failure_ends_the_suspended_child_and_a_later_start_works` | 注入＋実プロセス（子が実際に終わる） |
| W1b | `w1b_assignment_failure_blocks_the_same_role_until_the_exit_is_confirmed` | 注入＋実プロセス |
| W1b' | `w1b_prime_a_job_that_refuses_the_child_leaves_no_unmanaged_process`（`ActiveProcessLimit = 1` の Job に別のプロセスを入れて渡す） | 実プロセス（OS の拒否） |
| W1c | `w1c_a_resume_result_of_zero_or_failure_ends_the_child_and_fails_the_start`（戻り値 `0`・`u32::MAX`、先に実際に再開した子）、`w1c_a_resume_result_of_two_succeeds_and_the_child_runs_once_the_external_suspend_is_released`（外の停止を `SuspendThread` で1回重ねて戻り値 `2`。起動は成功し、解くと子が動く。J-24）。確認の命令の書き込みの失敗・期限切れでも配信ミックスとオケの入力が残ることは `p2_a_write_failure_or_timeout_during_the_start_confirmation_keeps_the_post_mix_and_mixing`、通常の起動が確認を送らないことは `a_normal_start_sends_no_confirmation_command_to_the_child`。製品の経路は `the_product_spawn_creates_the_child_suspended_so_the_resume_succeeds` が `2` の場合も通る。停止が解かれない場合は `w1c_a_child_whose_external_suspend_is_never_released_is_retired_and_the_start_fails`（期限で主の子だけを回収して起動の失敗。終了を確かめられなければ `engine_unconfirmed`。次の操作で作り直せる）、確認への応答が EOF・拒否のときは `w1c_an_eof_or_a_rejection_during_the_start_confirmation_is_a_failed_start`、配信ミックスの子とオケの入力の選択が残ることは `p2_a_failed_start_confirmation_keeps_the_post_mix_child_and_the_mixing_selection` | 注入＋実プロセス |
| W2 | 主：`b17_d7_*`・`b17b_*`・`w2_a_primary_write_failure_*`・`j13_*`。配信ミックス：`post_mix::life_tests::w2_*`（停止・開始・書き込み・EOF 後の `snapshot()`・`State` の差し替え） | 注入 |
| B40a・B18 | `b40a_*`・`b18_*`（配信ミックスを挟む場合は `post_mix::life_tests::b40a_*`） | 実プロセスに、終了の確認の失敗を注入する試験 |
| W4a | `w4a_a_normal_exit_leaves_no_child_or_grandchild`（親＝試験の実行ファイルが `process::exit(0)`／`Drop` の後に終了。子と孫のハンドルで確かめる） | 実プロセス |
| W4b (1)(2)(3) | `w4b_forced_exit_*`（親だけを `TerminateProcess`。(1) は試験が持つ子のハンドルで残ったことを確かめ、そのハンドルで片付ける） | 実プロセス |

- 孫は、台本つきの子が作る別のプロセス（試験の実行ファイル。`Step::SpawnGrandchild`）。実 sidecar の `--scan` の孫ではない。
- (1)(2) は、試験の継ぎ目（`seam::on_stage`）で親を「作成の直後」「割り当ての直後」に止めてから強制終了する。
- `try_wait` を差し替える試験は、時計も仮想にして実際には待たない。子の終了は、試験のハンドルで実際に待ってから `Real` に戻す。
- W4a の `app.exit(0)` は、Tauri のアプリを使わず、親プロセスの `process::exit(0)` で代用している（Job の kill-on-close は、プロセスの終了でハンドルが閉じることで働く）。

実アプリ（実 sidecar）で確かめる手順（自動にしていない。必要なときだけ手で行い、結果を PR に記録する）：

1. アプリを起動して音声を開始する。`Get-Process AuralynHost,audio_engine` で、sidecar が1つ動いていることを確かめる。
2. 通常の終了（トレイの「終了」）の後、`Get-Process audio_engine` が空になることを確かめる。
3. もう一度起動して音声を開始し、`Stop-Process -Name AuralynHost -Force` で親だけを強制終了する。数秒以内に `audio_engine` が残らないことを確かめる。
4. 更新・アンインストールが子の残りで妨げられた場合は、Windows を再起動してから再試行する（J-15）。

#### 実アプリでの確認の結果（2026-11-21、codex/audio-session-f1a1、D-13 の条件）

構成：`npm run tauri -- dev --no-watch --config src-tauri/tauri.debug-global.conf.json`（`TAURI_CONFIG` の `externalBin` を空にして、`target\debug\audio_engine.exe` の既存の debug の子を使用）、Tauri MCP CLI 0.13.2 で `invoke` を実行。起動と終了だけの確認で、`Start` の明示操作はしていない（保存済みの設定の自動開始は、アプリが自分で行った）。音・聴感の確認ではない。

使った成果物（実行後に、ファイルから読み直した記録）：

- Host：`D:\Programming\App\VSTHost\src-tauri\target\debug\AuralynHost.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 21:54:12、47357440 バイト、SHA-256 `FFEDB027A2666C725376548F8D2CA14419A403FEE2AE0C07736B9C9AC8CD675E`）。`tauri dev` が作業ツリーからビルドした（2分24秒）。ソースは 8a826618 に、のちに 6d8ea1f4 でコミットした未コミットの変更（`spawn_engine_binary` への分割と `apply_creation_flags`）を足したもの。ビルド時点の差分の SHA は記録なし。実行後に Host は作り直していない。
- 子：`D:\Programming\App\VSTHost\src-tauri\target\debug\audio_engine.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 15:23:31、5642240 バイト、SHA-256 `D209780413B2A2024278BB479B8692C04819C988C78F901185CAE7C3C33B439D`）。この確認では作り直していない（改名して戻しただけで、内容は同じ）。ビルド時のコミットは記録なし。`audio_engine` と `bin` のソースが最後に変わったコミットは ef32e034（2026-11-20）で、それ以降は変更がないため、そのソースと同じ内容と推定する。release の子は使っていない。
- 実行したコマンド：`$env:CARGO_TARGET_DIR = <リポジトリ>\src-tauri\target`、`$env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'`、`npm run tauri -- dev --no-watch --config src-tauri/tauri.debug-global.conf.json`、`npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp driver-session start --host 127.0.0.1 --port 9223`。

- (a) 起動：主の子（PID 5140）が起動し、`IsProcessInJob` が真。`stop_audio` の後に `post_mix` の `restore_saved` で配信ミックスの子（`--post-mix-worker`）が起動し、同じく Job に入っていた。起動の失敗：主の子を `Stop-Process` し、`audio_engine.exe` を一時的に改名すると、`get_audio_devices` は「Audio Engine binary not found」で失敗した。元の名前へ戻した後の同じ操作は成功し、新しい子が起動した。この失敗は、子が見つからない経路（Job の失敗の経路ではない。Job・割り当て・再開の失敗は注入の試験で確認した）。
- (b) 通常の終了：主の子（PID 54892）が動き、`get_audio_devices`（再検出）が作る `--scan` の孫（PID 26372）が生きている状態で、`quit_app` を実行した。孫は一瞬で終わるため、監視のジョブが現れた瞬間に `NtSuspendProcess` で止めて生かした（孫は実プロセス）。監視のジョブが起動時に取った Process のハンドル（開始時刻つき）で、Host の終了コード 0、子と孫の終了を確認した。残ったプロセスはなかった。
- (c) 強制の終了：別の起動（Host 56820、主の子 47596、孫 55820＝止めた `--scan`）で、`Stop-Process -Id <Host> -Force` により Host だけを終了した（終了コード -1）。同じ方法で、子と孫がどちらも終了したことを確認した。
- 実行後、`AuralynHost`・`audio_engine` のプロセス、`.hold` に改名したファイルの残りはない。
- MSIX：行っていない。`docs/MSIX_PROTOTYPE.md` の手順は、署名用の証明書の作成と、LocalMachine の信頼するストアへの登録（管理者の操作）、`Add-AppxPackage` が要る。システムの設定を変えるので実施していない。必要なのは、(1) 試験用の証明書の信頼登録（管理者）、(2) 署名済みの MSIX のインストール、(3) 同じ確認（ネストした Job の下での主・配信ミックスの起動、通常と強制の終了）。

#### 配布用ビルド（release の Host と、その横の release の子）での確認の結果（2026-11-21）

インストーラー（NSIS）では確認していない。理由：インストーラーは PC にインストールするため、利用者がふだん使っている Auralyn を上書きするおそれがある。代わりに、`npm run tauri -- build --no-bundle` で作った release の Host と、その同じフォルダーに置かれた release の子（インストール後と同じ並び）を、ビルド先から直接起動した。`--no-bundle` にした理由：`createUpdaterArtifacts` が有効で、NSIS の成果物の段階は署名の鍵を要するため。インストーラーの生成、署名、MSIX、インストール先のパス（`Program Files` 配下など）での確認は未実施。

- ビルド：`$env:CARGO_TARGET_DIR = <リポジトリ>\src-tauri\target` のもとで `npm run tauri -- build --no-bundle`（`beforeBuildCommand` の `npm run build` が release の `audio_engine` と `plugin_scanner` を作る）。`Built application at: ...\target\release\AuralynHost.exe`、終了コード 0。ビルド時のコミットは 2a41e452（作業ツリーの未コミットの差分は、試験・文書だけ。製品のコードは同じ）。
- Host：`D:\Programming\App\VSTHost\src-tauri\target\release\AuralynHost.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 22:38:58、18089984 バイト、SHA-256 `B8C7ADE3DA013F827066DD12E9D354A4AA278228035732557B296B498CC86538`）。
- 子：`D:\Programming\App\VSTHost\src-tauri\target\release\audio_engine.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 22:37:12、5662208 バイト、SHA-256 `4367FE1657593F0BE0B80EA5F3982F7891EC163B8F56EA762E82B1FA5A19F458`）。実行中のプロセスの `ExecutablePath` がこのファイルであることを確認した。参考：`src-tauri\bin\audio_engine-x86_64-pc-windows-msvc.exe` の SHA-256 は `D43D30471C835A4AAFAB2B3BA1FD425B782749A84ECB45F41A8CF4B7B3078F75` で、上のファイルとは一致しなかった（原因は調べていない。確認に使ったのは上の `release\audio_engine.exe`）。
- 起動と操作：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` を設定して Host を直接起動し、WebView2 の DevTools プロトコル（`Runtime.evaluate`）で `window.__TAURI_INTERNALS__.invoke` を実行した（release にはデバッグ用の bridge がないため）。
- (a) 起動：主の子が起動し Job に入っていた。`stop_audio` の後、`post_mix` の `restore_saved` で配信ミックスの子が起動し、同じく Job に入っていた。子を終了して `audio_engine.exe` を一時的に改名すると `get_audio_devices` は「Audio Engine binary not found」で失敗し、戻した後の同じ操作は成功して新しい子が起動し、Job に入っていた（子が見つからない経路。Job の失敗の経路は注入の試験で確認した）。
- (b) 通常の終了：Host 40428、主の子 46860、`--scan` の孫 53860（現れた瞬間に `NtSuspendProcess` で止めて生かした実プロセス）。`quit_app` の後、Host の終了コード 0、子と孫が終了した。ハンドルは、起動のときに取った Process（開始時刻つき）。
- (c) 強制の終了：Host 66716、主の子 43032、孫 32608（止めた `--scan`）。`stop_audio` で音声を止めてから、`Stop-Process -Id <Host> -Force` で Host だけを終了した（終了コード -1）。子と孫が終了した。
- 自動の開始：起動の直後に、保存した設定で音声が自動で始まった。(a) と (c) は確かめる前に `stop_audio` で止めた。(b) は止めずに `quit_app` した（終了とともに止まった）。聴感の確認ではない。
- 後始末：実行後に `AuralynHost`・`audio_engine` のプロセスはなく、改名したファイルは元の名前に戻した。容量は足りたので、キャッシュは消していない（空き約 16 GB）。

### 落ちる・固まるVSTでの実機の確認（#462）

試験用の VST3「Auralyn Crash Test」（`src-tauri/examples/crash_vst3.rs`。配布しない）は、指定した操作で `abort` する、または止まらずに回り続ける。指定は `%TEMP%\auralyn-crash-vst3.txt`（前後の空白は無視）に書く。

- 操作名：`load`・`set_state`・`get_state`・`open_editor`・`processing_setup`・`process`。`hang:<操作名>` なら落ちずに固まる。ファイルがない・一致しないときは普通に動く。
- 落とすのは、実行ファイル名が `audio_engine` で始まるプロセスの中だけ（スキャナーでは落とさない）。`process` は `setupProcessing`／`setActive` でファイルを読んで控えるので、音声スレッドではファイルを読まない。

```powershell
$env:CARGO_TARGET_DIR = 'D:\Programming\App\VSTHost\src-tauri\target'
cargo build --manifest-path src-tauri/Cargo.toml --locked --example crash_vst3 --release
$bundle = "$env:CARGO_TARGET_DIR\crash-vst3\Auralyn Crash Test.vst3\Contents\x86_64-win"
New-Item -ItemType Directory -Force $bundle | Out-Null
Copy-Item "$env:CARGO_TARGET_DIR\release\examples\crash_vst3.dll" "$bundle\Auralyn Crash Test.vst3" -Force
```

Auralyn の「VSTを追加」の「探すフォルダー」へ `...\src-tauri\target\crash-vst3` を足すと見つかる。`C:\Program Files` へは置かない。DLL は音声エンジンが読んでいる間は上書きできない（アプリを終了してから写す）。確認の結果は [ISSUE_462_ACCEPTANCE_2026-11-24.md](verification/ISSUE_462_ACCEPTANCE_2026-11-24.md)。

### 自発的に状態が変わるVSTの確認（#465）

開発用CLI `vst_state_drift` は、操作なしで生成信号をVSTへ渡し、`getState`の内容を比較する。
本体と同じカタログクラス選択・bus交渉・遅延接続・処理準備を使うが、音声デバイスとエディターは開かず、出力音声は破棄する。
`externalBin`には追加せず、配布物には含めない。新しいcrate依存は不要。

PowerShellの例（既存の `src-tauri/target` に出力する）：

```powershell
Set-Location D:\Programming\App\VSTHost\src-tauri
cargo run --locked --bin vst_state_drift -- --help
cargo run --locked --bin vst_state_drift -- --plugin 'C:\Program Files\Common Files\VST3\TDR Nova.vst3' --seconds 60 --interval 5 --signal noise
# 音声時間10秒分を待機なしで処理し、JSONで報告する。
cargo run --locked --bin vst_state_drift -- --plugin 'C:\Program Files\Common Files\VST3\TDR Nova.vst3' --seconds 10 --interval 2 --fast --json
$LASTEXITCODE
```

`--plugin`は必須。`.vst3`のファイルとバンドル（フォルダー）のどちらも指定でき、バンドルはスキャンと同じ規則で`Contents_64-win`の実体を読む。複数クラスのVSTは`--class <CID>`でカタログの対象クラスを選べる。
既定は60秒、5秒間隔、48000 Hz、512 frame、2 ch、`silence`。
`--seconds`、`--interval`、`--rate`、`--block`は正の整数、`--channels`は1または2を指定する。
`--signal noise`は固定種の一様乱数（約-20 dBFS RMS）、`sine`は1 kHz（-18 dBFS peak）。左右には同じ信号を渡す。

処理前に状態を連続2回取得し、その後は指定間隔を越えた最初のblock末尾と計測終了時に取得する。
最後のblockも全体を処理するため、計測時間は最大1 block未満だけ長くなる。
経過msは壁時計でなく処理frame数から計算する。最初の2行はどちらも0 ms。
JSONの`initial_size`は最初の状態のbyte数、`initial_reads_equal`は連続取得の一致を表す。
各`sample`には大きさ、直前から変わったか、異なるbyte数、最初に違う位置（0始まり）、初期状態から変わったかを記録する。
長さが違うときは末尾の追加・欠落も異なるbyteに数える。生の状態データは出力しない。

| 判定 | 観測した内容 | 今の保存の仕組みとの関係 |
| --- | --- | --- |
| `Stable` | 計測中に変化なし | 同じ内容は再書き込みしない |
| `ChangesOnRead` | 処理前の連続2回が異なる | 取得に伴う変化の候補。表示中も毎回状態が異なれば、10秒ごとの取得で毎回書き込む |
| `DriftsWithAudio` | 処理前は一致し、音声処理後に変化 | 表示中は10秒ごとに取得し、前回保存した内容と異なる場合に書き込む |

どの判定でも、エディターを閉じて操作していなければ定期取得がなく、書き込みは増えない。
閉じた直後には1回保存し、構成変更の2秒後と明示保存でも取得する。同じ内容なら書き込まない。
Auralynには「未保存の印」の表示はないため、#465の完了条件は保存頻度で確認する。
`src/hooks/__tests__/usePluginSessionPersistence.test.tsx`では、取得のたびに状態が変わるmockを使い、閉じたまま60秒は増えず、表示中35秒は3回、閉じると1回、その後60秒は増えないことを確認する。

終了コードは0が変化なし、2が変化あり、1がエラー。
状態取得や処理に失敗した場合はそこで止め、JSONの`report.error`と取得行の`error`に原因を残し、`verdict`は`null`にする。
読込・引数エラーはトップレベルの`error`となる。診断ログはstderr、JSONはstdoutへ出す。

この道具では処理と状態取得を同じスレッドで交互に行う。本体は別スレッドで並行するため、結果は本体の動作を保証しない。
判定名は観測条件の分類であり、変化の原因を断定するものではない。
実時間依存のVSTは`--fast`の有無で、乱数や非同期処理を使うVSTは再実行でも結果が異なり得る。
必要に応じて実時間でも繰り返し、信号・rate・block・クラスと結果を一緒に記録する。

## 現行の検証手順（2026-10-15 改訂）

プロセス入力の改善版での長時間運転・異常時停止は[2026-11-02の後続記録](PROCESS_LOOPBACK_FOLLOWUP_2026-11-02.md)を参照する。
停止後の学習値保持、実素材の声用途、Chrome音声子プロセス終了後の確認は[2026-11-03の修正・検証記録](PROCESS_INPUT_LEARNING_RETENTION_2026-11-03.md)を参照する。
明示runnerは`scripts/verify_process_material_nr.py`。PythonのNumPy・SoundFile、Node.js、インストール済みChrome、既存probe、未使用のCABLE Inputと別の原音用出力を必要とする。`--engine`、`--probe`、`--material`、`--raw-endpoint`、`--output-endpoint`、新規の`--output-dir`を指定する。物理マイクを開かず、通常のアプリ設定を使用しない。
許諾済み配信のNR比較は[素材評価手順](NR_MATERIAL_EVALUATION_2026-11-02.md)を使う。
`export_same_input_noise_candidates`は素材評価専用のignored試験で、`AURALYN_NR_EVALUATION_INPUT`へ絶対パスのfloat32ステレオWAV（最大10秒）、`AURALYN_NR_EVALUATION_OUTPUT`へ未作成の絶対パスを指定して明示実行する。
通常アプリの設定と学習結果を使わず、製品の既存候補生成処理を評価する。通常の自動テストで素材や音声デバイスを要求しない。

固定ゲインの提案・聞き比べは [AUTO_GAIN.md](AUTO_GAIN.md) の検証境界も参照する。

以下の過去ログ・チェック済み項目は当時の記録です。現在のHEADの動作保証として扱わず、変更に応じて再確認してください。

| 変更範囲 | 必要な確認 |
| --- | --- |
| 文書・規約 | 実装との整合、参照リンク、`git diff --check` |
| バージョン・配布スクリプト | `npm run test:release`、`npm run release:check`、番号変更のdry-run |
| React / TS / UI依存 | `npm test -- --run`、`npx tsc --noEmit`、`npx vite build`、変更画面の操作確認 |
| Rust / IPC | `cargo test --locked`、`cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`（`src-tauri`で実行）。対象テストに実機・プラグインが必要か事前確認 |
| 音声系 / native window依存 | Rust検証に加え、WASAPI / ASIO、44.1k / 48k、異なるバッファ、デバイス切替、VST追加・削除・復元、GUI開閉・DPI、連続運転で音切れ・CPU・遅延・音質を更新前後比較 |
| インストーラー / updater | 署名ビルド、旧版からの更新、設定・プリセット移行、Source ZIP・SHA-256・manifest整合、公開後の取得確認 |

`npx vite build` はフロントのみです。`npm run build` はrelease sidecarのRustビルドとNSIS画像生成も実行し、`npm run tauri build` がインストーラーまで生成します。
実行していない実機・インストール・OBS・公開確認は「未確認」と報告してください。
依存更新時は `npm audit` と必要に応じた RustSec 監査も行います。自動テスト成功だけで音声・配布の互換性を保証しません。

DSPの初回処理・resetをpanic=abortで計測する手順は[DSP_ABORT_VERIFICATION.md](DSP_ABORT_VERIFICATION.md)を参照する。
検証用featureを明示したexampleだけを実行し、音声デバイスやストリームを起動しない。

割当回数の検査とは分離した、実機ストリームなしの時間・保持メモリ比較は[DSP_RELEASE_PERFORMANCE.md](DSP_RELEASE_PERFORMANCE.md)を参照する。
性能比較のexampleでは検証用featureを有効にしない。

### OTTエディタの回帰確認

OTT 1.37 / Windows 11 x64 / 96 DPIで、InitDll未実行時に要求サイズが4×4となり、背景・ノブ画像・ロゴが欠ける症状を再現した。詳細は [OTT_EDITOR_FIX.md](OTT_EDITOR_FIX.md)。
再確認では最新ソースからビルドしたaudio_engineを使用し、ビルド中にコピーされる古い配布sidecarを実行しない。

- 音声ストリームを開始せずOTTを追加・表示し、310×440の内容全体、背景・ノブ・ロゴ・数値を確認する。
- DEPTHを操作して保存状態が変わること、状態を復元できることを確認する。
- 複数OTTの同時表示で片方の操作・削除がもう片方へ影響しないことを確認する。
- 閉じる・再表示、リサイズ、表示中削除、削除後の再ロードを繰り返す。
- TDR Novaなど別のプラグインで、描画と開閉・リサイズ・削除を再確認する。

OTTをインストールした環境では、`src-tauri`で `cargo test --locked --test ott_module_lifetime -- --ignored` を明示実行し、複数インスタンスの遅延解放とDLL共有寿命を確認する。メモリ内の無音だけを処理し、実機ストリームは開始しない。通常のテスト実行ではignoreされる。

100%以外の実DPI・異なるOTT版・長時間音声中の挙動は別途検証する。

## UI監査 F01〜F05 の回帰確認

- プラグインのメーカー・カテゴリが欠損していても、すべて／最近／お気に入りで検索できる。壊れた履歴JSONでも追加画面を開ける。
- 900×600、1024×768、1280×900で上の帯を確認し、状態の札や操作が重ならない。
- 設定のページからライセンス画面を開き、ページの手前に表示される。ボイスチェックとプロファイル管理では固定フッターが前面へ出ない。
- 接続の未保存の変更、ホットキーの下書き、音量の保護の適用前の数値があるまま別のページや小区分へ移ろうとすると確認が出る。歌向けの未適用の下書きは確認せず、タブの点で示す。捨てて移動したあと開き直しても、キャッシュした一覧からドライバとデバイスを表示する。保存済みドライバが消えた場合も選択可能な候補へ戻る。
- 音声未設定・ストリーム停止中の診断は設定への案内を表示し、マイク測定やテスト音へ進まない。取得できない経路情報と受け側の手動確認を正常判定にしない。

検索・選択復元・重なり順・診断の自動回帰テストは `npm test -- --run` に含む。実音声、OBS・Discordへの到達、異なるDPIは別途確認する。

## UI監査 F06〜F10 の回帰確認

- 既存ダイアログは名前付きのモーダルとして開き、背景へTab移動しない。Escapeで閉じ、開いた操作へフォーカスが戻る。入れ子の確認では手前だけを閉じ、処理中の中断制限を保つ。接続・音づくり・設定のページはダイアログではなく、Escapeでは閉じない。戻るのはレールのホーム。
- 入力・出力ゲイン、ラックのゲイン・有効化・ミュート・削除、システム設定に操作名と状態がある。キーボードでも削除ボタンが見える。
- 900×600で初回画面の開始・スキップ、入力／出力の戻る・次へ、確認画面の選び直し・保存を、本文スクロールと独立して操作できる。
- 複数のマイク・仮想ケーブルを先頭候補で確定しない。選択前の「次へ」は無効。VB-CABLEは受け側の対になる名前を示し、Voicemeeterのバス対応は手動確認として案内する。
- 音声停止中の主画面からレールの接続を開ける。接続のページでは、接続方式より先に入力と出力を選べる。

共通ダイアログのTab循環・復帰・入れ子・処理中、操作名と状態、複数候補の選択、開始導線はUIテストに含む。スクリーンリーダーの読み上げとOS全体のキーボード操作は別途確認する。

## UI監査 F11〜F15 の回帰確認

- エンジンの常駐・音声未設定・ストリーム停止／失敗・稼働・取得失敗を区別する。停止中は処理設定が残っていても稼働中とせず、遅延数値を表示しない。稼働時の遅延は「推定」と表示する。
- プロファイル管理の入口と画面名を揃え、保存対象を選べる。入出力プリセットにはVST・ノイズ低減・内蔵FXを含まない。ノイズ低減と内蔵FXの変更は即時反映、入出力は「保存して開始」で反映することを表示する。
- OBS／Discordガイドの最後は手順案内と音声到達未確認を区別し、接続診断へ進める。受け側の音声処理を一律に無効化せず、比較・試聴を促す。
- ライト／ダーク／ゲーミングの100%と200%を確認する。短い表示領域ではダイアログ全体をスクロールし、設定の保存やプロファイル一覧へ到達できる。背景のチュートリアルをモーダルに重ねない。
- 外部VSTの準備・構成置換・適用後の手動調整を先に説明し、内蔵処理だけで始める入口を分ける。適用失敗を成功表示にしない。

状態確認・遅い応答と停止通知の競合・停止時の遅延非表示・ガイド終了と診断入口・テンプレート適用失敗はUIテストに含む。コントラスト確認は対象の配色と背景を記録し、全要素や読み上げの適合保証とは区別する。

## 再レビュー S01〜S03 の回帰確認

- 音量チェックの開始後に稼働状態の取得が失敗しても、測定の停止要求と応答確認を行う。停止失敗の警告は、表示OFFや稼働状態の回復で消えず、稼働未確認でも停止を再試行できる。
- 開始応答待機中の稼働状態の取得失敗では、開始の後に停止を適用する。初期の稼働未確認は停止確定と区別し、自動で測定を開始しない。
- 接続診断は、選んだCABLE／CABLE-A／CABLE-Bと同じホストの対応入力だけを検査する。別ケーブル・別ホスト・重複候補・不明な仮想出力へ代替しない。Voicemeeterなどはバス対応の手動確認へ案内する。
- 診断結果と受け側チェックリストの入力名が選択出力に対応する。対象を特定できない場合は、自動確認未実施として手動確認を示す。
- 音量調整の案内・エラー・制限メッセージをライト／ダークで確認する。最小900×600を維持し、案内と操作が読めることを確認する。

停止失敗・遅い応答・ケーブル対応の回帰テストは `LoudnessCheck.test.tsx` と `TroubleshootModal.test.tsx` に含む。IPCをモックした検証と、実機の音声・通信障害・仮想ケーブル到達確認を区別する。

## UI監査 F16 の回帰確認

- 音量調整の提案が準備完了したら、目標選択や録音ではなく適用・聞き比べを案内する。目標は変更不可、適用は有効、聞き比べは試聴先と確認チェックが揃うまで無効。
- 提案があっても音量の反映が未確認なら確認中と表示し、適用できると案内しない。録音前・適用後・復元後の案内を保つ。自動適用はしない。

## UI監査の修正全体レビューで確認した5件の回帰確認

- テンプレートのVSTが全件／一部だけ読み込めない場合は失敗を返し、成功扱いで画面を閉じない。ラックは実際に読み込めた構成を表示する。
- テンプレート適用中は設定への移動・閉じる・キャンセル・戻る・VST選択・Escapeを無効にし、失敗後は修正と再試行ができる。
- 保存設定の起動時にも、停止・エラー通知より古い取得結果や起動応答で稼働表示を戻さない。古い未稼働応答から自動起動をやり直さない。
- ガイドから設定へ画面を置き換えても、閉じた後は最初の入口へフォーカスが戻る。遅延読み込みと入れ子の確認画面でも確認する。
- Windows既定の物理出力を確認できない場合は先頭候補や仮想ケーブルへ代替せず、明示選択へ案内する。再検出では既定の変更・消失を選択へ反映する。

自動回帰テストは `usePluginsTemplate.test.tsx`、`TemplateWizardModal.test.tsx`、`useAudioConfigStartup.test.tsx`、`modal.test.tsx`、`SetupWizardModal.test.tsx` に含む。読み込み失敗や起動応答の競合はIPCをモックした検証であり、実VST・実音声・OSのデバイス変更による確認とは区別する。

## 再レビュー R01〜R05 と900×600の常時表示

- テンプレート置換の削除が途中で失敗しても、削除成功したVSTは表示から消える。新しいVSTの読み込みへ進まず、残った構成から再試行できる。
- ライセンスは200%でも閉じると3種類の切替が表示範囲内にあり、横にはみ出さない。
- 短い画面のウィザードで本文・外側をスクロールしても、手順切替で両方が先頭へ戻り、フォーカスした見出しが見える。
- ライトの検索0件表示・診断の修復案内は、実CSSの色と背景を記録してコントラストを確認する。
- 接続診断もガイドと同じく、受け側の音声処理を一つずつ比較・試聴するよう案内し、一律OFFを勧めない。
- 最小900×600と初期1024×768を維持する。停止案内・空ラックを小さくし、詳細表示の未使用の音量チェックは畳む。必要な入口とミュート・ゲイン・レベル・状態を残す。
- 音量チェックは非表示でも停止応答を待ち、停止失敗の警告・再試行は隠さない。再表示だけでは測定を始めない。
- 右の列の「音声の詳細」から遅延の内訳・レート・バッファ・VST数へ到達でき、Escapeで元のボタンへ戻る。停止中の設定値を稼働中の実値として表示しない。

削除失敗・再試行、音量チェックの停止と非表示、詳細の開閉は自動テスト。画面の収まりは実アプリで100%／200%を確認し、実VST・実音声での検証と区別する。

## 用途に合わせた表示

表示と保存の契約は [USAGE_DISPLAY.md](USAGE_DISPLAY.md) を参照する。

- 初回の両方の表示選択が、適用成功・明示スキップで保存され、中断・失敗では以前の表示を変えない。
- 既存のかんたん／詳細表示を保持し、通常画面・上の帯・セットアップの変更を同期する。
- かんたん表示は音づくり・試聴とOBS設定への入口を前面に置き、音量チェックは必要時に表示し、VST一覧は展開できる。閉じても適用済みエフェクトを停止しない。
- OBSへの入口はOBS連携タブ、通常の設定入口はオーディオタブを開く。接続・設定変更は明示操作まで行わない。
- 900×600で各入口と初回選択を操作し、音声・エフェクト・保存設定を保持する。

## 未使用時の配信用部品

[BROADCAST_LIFECYCLE.md](BROADCAST_LIFECYCLE.md) に利用期間・停止・履歴の保持条件を定める。

- VST表示や利用OFF・非表示で測定を停止し、復帰時は手動開始まで再開しない。停止失敗は再試行できる。
- OBSを使う最後の画面を閉じる・別タブへ移る・非表示にすると通信と購読を終了する。接続待機中の閉じる操作も確認する。
- 切断・再接続で予定を無効化し、履歴とIDは保持する。切断前の履歴は参照用とし、同一性を確認できないソースへ復元しない。
- 未接続で履歴を表示し、明示確認後だけ履歴を削除する。OBSの設定自体は変更しない。

## 出力の音量チェック

測定方式・仮の判定値・検証範囲は [LOUDNESS_CHECK.md](LOUDNESS_CHECK.md) を参照する。
自動テストは `audio_engine/loudness.rs` と `LevelMeter/__tests__/LoudnessCheck.test.tsx`。

- 測定前は計算が停止し、無音・3秒未満・データ途絶で「ちょうどいい」を表示しない。
- 最終出力ゲイン、ミュート、選択した出力チャンネルを反映する。左右に同じ物理チャンネルを選んでも二重加算しない。
- 目標変更・境界付近・過大ピークで判定が切り替わり、通常の境界往復では表示がちらつかない。
- 3秒未満の短い過大音でも、LUFSの準備完了を待たず警告する。音が少ないことを理由に過大ピークを隠さない。
- 明示停止と入力ストリームエラー後の自動停止の両方で、停止IPCが失敗した場合は停止未確認と再試行を表示し、停止成功後だけ停止済みへ戻る。停止待機中の再起動後に古い完了・失敗で状態を戻さない。
- 音声停止・再開・デバイス変更で以前の判定が消え、新しく測定するまで成功表示を戻さない。
- 900×600で開始・停止、詳細の目標選択、ボイスチェックへの移動を操作できる。
- マイク出力だけの目安であり、ゲーム音を含む配信全体やサービス公式の基準と誤認させない。

## セットアップの接続チェック

自動回帰テストは `src/components/features/SetupWizard/__tests__/SetupWizardModal.test.tsx`。
IPC をモックしているため、実機・OBS との疎通は以下の手動確認と分ける。

- 仮想ケーブルがない状態で「OBS 向けの接続を確認する」を選ぶと、導入案内に進み、スピーカーへ自動で迂回しない。
- 入力・出力の再検出で新しいデバイスが表示され、消えた選択が残らない。複数の仮想ケーブルがある場合は、存在する選択を維持する。
- 確認画面でサウンドテストを開始し、入力・出力を選び直す。停止を待って選択へ戻り、新しい構成で再試行できる。
- OBS 停止中・認証失敗時には、再接続と手動手順が表示される。ソース・フィルター設定は変更されない。
- 配信・録画・通話を停止してから、WebSocket v5 と「Auralyn マイク」ソースを用意し、テスト音での到達確認を行う。成功・未検出・非対応・失敗を区別する。
- 確認中に保存・選び直し・閉じるを実行できない。入力エラーや音声の中断後に、以前の成功表示が残らない。
- Discord・物理出力では用途に合う手動確認が表示され、OBS の到達確認は起動しない。
- テスト後の中断で元の起動状態・デバイス・サンプルレート・バッファを復元する。起動失敗時や中断時に初回設定完了を保存しない。
- アプリの最小サイズ（900×600）でも案内と保存・選び直しボタンまでスクロールできる。
- 900×600 で閉じるボタンと最後の進捗表示が重ならず、閉じるボタンから中断確認を開ける。
- 再生リダイレクトや Stereo Mix が一覧の先頭・既定でも、マイクと分かる入力を優先する。再生系・仮想入力だけの場合は自動選択せず、入力選択へ進む。
- サウンドテストの開始・停止で接続欄の音声状態も切り替わる。OBS の接続失敗や到達未確認の案内は、音声状態とは区別して表示する。
- WASAPI 入力が見つからない場合の設定案内から、ウィザードを閉じてオーディオ設定だけを開ける。
- 保存して開始した後も、画面と保存設定のサンプルレート・バッファが起動結果の実値に一致する。48 kHz／512 以外の構成も含めて確認する。

## 更新履歴
- 2026-01-17: 既知不具合メモを整理し、検証結果ログを追記（VST3ホスト/Audio Engine改善反映）。

## 検証結果ログ（直近）
- 2026-01-17: VSTプラグインの追加/削除後もクラッシュせず、音声とレベルメーターが継続することを確認。EDITORでGUIが開くことを確認。

## OBS 設定変更の確認・復元

自動回帰テストは `src/components/features/AudioSettings/__tests__/ObsSafeSetup.test.tsx` と
`src-tauri/src/obs_setup.rs`。UI は IPC モック、Rust は設定読み書きの模擬実装で検証する。
実際の OBS・認証・切断タイミングの確認とは分ける。

- 「変更予定を確認する」で現在値・変更後の値を表示し、キャンセルで OBS の設定が変わらない。
- 表示後に OBS 側で値を変えた場合、古い予定の適用を中断する。
- 部分失敗は項目別に表示し、応答を失った変更も履歴から状態を確認・復元できる。
- 新規作成の応答、または直後の状態取得だけを失っても、作成識別情報とシーン項目から再特定して取り消せる。他のソースや作成後に設定・音量・フィルター・配置などを変更した対象は自動削除せず、復元保留として残す。
- 同じソースの復元は新しい変更から逆順で行う。別ソースの競合は過去の履歴の復元を妨げない。通信失敗で状態が不明な同じソースの項目は、引き続き復元候補として保持する。
- ソース削除・改名では対象の名前だけを無効化する。新規作成を取り消した後でも、別マイクの古いミュート履歴を復元できる。同名で再作成・改名して戻した対象は復元しない。コレクション切替は全体を無効化する。
- ソースの削除・改名、コレクション切替後は同名ソースでも自動復元しない。
- 新規ソースは既定マイクを流さず無効で作成する。CABLE Output の指定・有効化を手動で案内する。
- 作成だけを元に戻す場合、元のシーン項目とソース設定が変わっていないことを確認して、その項目だけ外す。ユーザーが変更した場合は競合とする。
- 重複マイクのミュートにも変更予定・適用・履歴・復元の手順を使う。
- 必要なリクエストに対応しない OBS では適用ボタンを出さず、手動手順を案内する。
- 切断・再接続後も履歴を参照できる。アプリ終了で消えることと、接続をまたぐ履歴は手動確認になることを案内する。
- 設定を閉じると切断し、再表示で履歴を保持していることを確認する。同一接続中だけ安全確認後の復元を許可する。OBS 側の接続状態確認中は、新しい接続操作ができない。
- OBS終了・WebSocket切断後の再表示では、期限付きの実リクエストで未接続を返し、再接続ボタンを表示する。ローカルのイベント購読成功だけでは接続中と判定しない。
- 900×600 で変更予定・履歴・操作ボタンまでスクロールでき、処理中は二重適用・切断・接続テストができない。

OBS の読み取りと書き込みは別リクエストで、他クライアントとの原子的な比較・更新ではない。
配信・録画を停止し、適用・復元中は OBS 側で同時に設定を操作しない。

## 1. 基本動作テスト

### 1-1. 初回起動とウィザード
- [x] アプリケーションが正常に起動すること。
- [ ] 初回起動時にオーディオ設定（またはウィザード）が正しく表示されること。
  - 既知課題（過去ログ）: 起動時に表示されないことがあった（要再確認）。
- [x] マイク入力とスピーカー出力を選択し、エラーなくオーディオエンジンが開始すること。

### 1-2. 設定の保存と復元
- [ ] ASIOの6/7などを選択した状態からWASAPIへ「保存して開始」および「エンジン再起動」で切り替え、保存値が0/1になり、ステレオ入力・出力が動作すること。ASIOのまま保存した場合は範囲内の選択を維持すること。
- [ ] アプリを再起動した際、前回選択したデバイス設定（Host, Input, Output）が自動的に復元されること。
  - 既知課題（過去ログ）: 復元されず初期化されることがあった（要再確認）。
- [ ] 設定変更後に再起動しても、変更が反映されていること。
  - 既知課題（過去ログ）: 変更が維持されず初期化されることがあった（要再確認）。

## 2. VSTプラグイン機能

### 2-1. プラグインスキャンと検出
- [x] システムの標準フォルダ（C:\Program Files\Common Files\VST3 等）からVST3プラグインが検出されること。
- [x] プラグイン名、ベンダー名が正しく表示されること。

### 2-2. プラグインのロードとアンロード
- [x] プラグインリストから「追加」ボタンでプラグインをロードできること。
- [x] ロードしたプラグインがラックに表示されること。
- [x] プラグインの「削除（ゴミ箱アイコン）」ボタンで、エラーなく削除できること。
- [x] 音声再生中にプラグインを追加・削除しても、アプリがクラッシュしないこと。
- [x] 音声再生中にプラグインを追加・削除しても、音声が継続すること（無音化しない）。
- [x] 音声再生中にプラグインを追加・削除しても、レベルメーターが継続更新すること。

### 2-3. プラグインチェーンの操作
- [x] 複数のプラグインをロードできること。
- [x] ドラッグ＆ドロップでプラグインの順序を入れ替えられること。
- [x] 順序入れ替えが音声処理に即座に反映されること（例: リバーブ→歪み と 歪み→リバーブ の違い）。

### 2-4. パラメータ操作（エディタ）
- [x] 「EDITOR」ボタンでプラグインのGUIが開くこと。
- [x] GUIでの操作が音に反映されること。
- [x] GUIを閉じても設定が維持されること（同一セッション内）。

## 3. オーディオ品質とパフォーマンス

### 3-1. レイテンシーとノイズ
- [ ] 現行対応のWASAPI共有モードとASIOで、それぞれレイテンシーを再確認する（旧記録のWASAPI排他モード表記は現行の対応範囲と一致しない）。
- [x] プツプツというノイズ（Dropout）が発生しないこと。

### 3-2. CPU負荷
- [ ] プラグインを複数（3-5個程度）ロードしても動作が重くならないこと。
  - 備考: プラグイン種類により負荷が大きく変動するため、CPU%の目安も併記する。

## 4. OBS連携

### 4-1. 仮想ケーブル出力
- [ ] Output Device に `CABLE Input` (VB-Audio) などを指定して音声が出力されること。
  - 既知課題（過去ログ）: VB-Audioなどが表示されないことがあった（要再確認）。

### 4-2. OBSでの受信
- [ ] 上記ガイド通りに設定し、OBSの「音声入力キャプチャ」でレベルメーターが振れること。
- [ ] マイク音声にエフェクトがかかった状態でOBSに届いていること。

## 5. エラーハンドリング

### 5-1. デバイス切断
- [ ] (可能であれば) 使用中のUSBマイク等を抜いた際に、アプリが適切にエラーを表示するか、クラッシュせずに耐えること。

## デザイン監査 D01〜D09 の回帰確認

- 詳細・シンプルの両ラック表示でミュートを解除でき、有効化・ゲインと独立して状態を保つ。表示切替とVSTブラウザの絞り込みに操作名・選択状態がある。
- ボイスチェックは実ストリームの確認中・停止・取得失敗では録音を開始しない。停止通知より古い稼働応答を採用せず、クリック直前にも再確認する。開始失敗は画面内に残し、再確認・接続設定へ進める。
- ライトのDiscordガイドの赤い説明と主操作の文字色・背景を記録し、通常文字4.5:1以上を確認する。
- 初回画面は用途選択を主操作、OBS向け設定を副操作にする。900×600で目的の4候補と必須の出力欄が見え、表示設定の保存・中断・スキップの契約を保つ。
- かんたん表示は「声を整える」から音づくりタブ、「録音して聴く」からボイスチェックを直接開く。音量チェックは初期非表示。入出力の保存操作と、ノイズ低減・内蔵ボイスチェーンの即時反映を分ける。
- 音づくりで現在の処理設定が取得できない間は調整しない。主操作・副操作を共通Buttonの色・サイズ・角丸で表し、ラックの名前・状態・操作を発光装飾より優先する。
- ライト・ダーク・ゲーミング、900×600と拡大表示で変更した画面を操作する。最小900×600・初期1024×768を維持する。

録音の状態確認・失敗・古い応答、両表示のミュート解除、絞り込み状態、設定の分離・直接導線はUIテスト。画面・配色の確認と、実音声の録音・外部アプリへの到達・読み上げの実機検証を区別する。

## OBS最終ミックスの手動確認（Issue #37・段階A）

- OBS連携ガイドの最終段で「OBSの最終ミックスを確認する」を開き、マイク・伴奏を別々のソースで取り込むか、同じソースで混合済みの音を取り込むかを選び、対象のソース名を手動入力する。別々の指定では同名を拒否し、混合済みでは1つのソースを確認する。必要な名前が未指定のまま確認を記録できない。
- 二重取り込み、ミュート・モニタリング、録音トラック・保存先・含まれる音をOBSで確認する。名前の入力は実在や種類の自動判定ではない。
- 利用者がOBSで短いテスト録画を開始・停止し、普段の声・サビ程度の声と伴奏を聴く。ガイドを操作しただけでは録画・設定変更・ファイル操作・外部送信が起きない。
- 「判断できません」は未確認として扱う。その他の回答も利用者の自己確認であり、品質合格・同期保証を表示しない。音量を変える場合は変更前の値を控え、少しずつ変更し再録画して採用または手動で戻す。Auralyn・OBS連携の設定変更は既存画面の変更予定・履歴を確認する。
- ソース名・チェック項目の変更、やり直し、ガイドの再表示で以前の確認を残さない。ソースの改名・削除、OBS再接続・シーンコレクション変更、音声経路・処理変更後は利用者が確認をやり直す。
- ボイスチェックは出力ゲイン・全体ミュート適用前の声単体録音、接続診断は音の到達、OBS最終録画は伴奏・OBS音量・フィルター・トラックを含む確認として区別する。歌唱中の自声モニター遅延と最終録画の同期も別に扱う。
- 900×600で展開した本文をスクロールし、入力・各チェック・結果・やり直し・ガイドを閉じる操作へキーボードで到達できることを確認する。
- 「OBSを整える」の新しい変更予定に、既存ソースの同期オフセットを0msへ初期化する提案が入らない。過去の履歴の適用・復元・競合検出の契約は維持する。

段階AのUI自動テストは手動手順と画面内状態を確認する。実OBSの録画・聴感・音量バランス・900×600の実画面は別途確認し、未実施なら未確認と記録する。Auralyn内部遅延をOBSの同期オフセットへそのまま転記せず、映像同期には別の基準が必要である。

## 録画に基づく同期調整（Issue #37・段階B）

- ガイドと接続設定を往復しても接続を維持し、同期調整へ戻れる。未接続なら明示操作で接続する。認証が必要なら設定画面へ進み、保存パスワードをガイドへ共有しない。閉じる・非表示では利用leaseを解放する。
- 利用者が録画で測った声／伴奏または音／映像の差と基準を入力する。声が遅い場合は独立した伴奏、声が早い場合は声、音が早い場合は音に追加遅延を提案する。混合済みの声と伴奏、映像より遅い音、方向や基準が不明な場合は自動提案を適用できない。
- 実OBSから取得した対象、現在値、追加量、結果を確認してから明示的に適用する。一般の初期設定予定と同期変更を混ぜず、範囲外の値を丸めて適用しない。再録画して採用するか、同じ条件で履歴を確認して戻す。
- OBS再接続・対象削除／改名・コレクション／フィルター変更、Auralynの音声開始／停止／設定変更で古い測定・対象・予定・採用を失効させる。適用途中の変化や書込み結果不明では成功とせず、確認待ち履歴を保持する。古い条件の復元も拒否する。
- 内部VST GUIのパラメーター変更と外部音響の変化は検知保証外であり、その場合も測定をやり直す。履歴はアプリ稼働中だけ保持する。ガイドを開くだけで録画・同期変更・音声保存をしない。

モックによる契約・条件競合・UI操作の検証と、実OBSへの書込み・再録画・聴感を分けて記録する。

## 配信経路を変えないボイスチェック（Issue #33）

- 通常送出を維持したまま録音し、独立したWASAPI試聴先を選択する。保存するのは試聴先IDだけ。保存先が消失した場合は未確認として再選択を求め、別の既定デバイスへ置き換えない。
- 画面を開く・試聴先変更・一覧更新・非表示でOBS／通話アプリへ取り込まれない確認を解除する。OBSのデスクトップ音声・モニター・ループバックが試聴音を取得する構成は別出力だけでは防げない。
- 加工前／加工後、ループ、任意の音量合わせは同じ試聴transportを更新し、A/B切替で冒頭から再開始しない。減衰のみの音量合わせと安全のための共通減衰は試聴専用で、通常ゲイン・ミュート・録音・WAV保存を変更しない。無音・計算不能では音量合わせを使えない。
- 録音条件の折畳み欄でレート・バッファ・入力チャンネル・入力ゲイン・ノイズ低減・内蔵処理・VST状態を確認する。録音後の変更、録音中の変更、VST内部パラメーター未照合、条件取得不能を区別する。録音地点は加工前が入力ゲイン・チャンネル選択後のFX前、加工後がFX後の出力ゲイン・全体ミュート前。OBS最終ミックスや遅延差を完全補正した比較とは扱わない。
- 閉じる、非表示、再録音、エンジン停止／エラーで試聴を停止・終了する。open応答前もcloseを送信し、旧session／旧操作／遅いstatusやstart応答で再生表示を復活させない。開始応答待ちでも停止でき、停止失敗は状態pollだけで消えず再試行できる。
- 音量調整の録音・聞き比べが使用中なら競合を示し、ボイスチェックから勝手に奪わない。通常出力で再生する既存APIは主UIから呼ばない。WAV書出し・解析・波形の回帰を確認する。

API／hook／画面のモック試験と、実機の同位置切替・短いフェード・loop境界・音量合わせ・デバイス切断・CPU／音切れ・OBS混入の証拠は分ける。WASAPI通常送出＋別WASAPI試聴、ASIO通常送出＋別WASAPI試聴は実際のデバイス・レート・ドライバーを記録する。900×600で本文をスクロールし、録音・試聴先・確認・A/B・再生／停止・音量合わせへキーボードで到達できることを別途確認する。

歌向け調整の初回導線では、数値欄を開かずに準備・試聴・適用へ到達できること、詳細欄がキーボードで開閉できること、数値編集と試聴の往復だけでは適用済み設定・モード登録が変わらないことを確認する。適用はページ下の固定行にあり、左に変更の有無を示す。試聴の閉じる操作と「音づくりの下書きへ戻る」の両方で歌向けの小区分の見出しへフォーカスを戻し、編集中の値を保持する。反映待ち・試聴中・競合時の適用禁止、エラー時の再取得、適用履歴、試聴先の安全確認も維持する。ブラウザのモック試験は `singing-first-use.spec.ts`、設定との往復は `AudioSettingsLifecycle.test.tsx` で確認する。実Tauriの音声停止中の画面確認は、録音・再生・実音声への反映成功の証拠としない。

保存方法の比較はモード登録・歌向け欄・プロファイル管理で同じ内容を確認でき、開閉しても保存名・保存カテゴリ・下書き・適用値・モード登録を変えないことを確認する。6つの数値説明は日本語・英語でキーボードから開き、Escapeで隣の説明ボタンへ戻り、最小画面の外へはみ出さず、数値も変更しないことを確認する。プロファイルの空カテゴリ拒否・上書き確認や、試聴・適用時の確認を説明表示のために省略しない。


## #28・#73〜#77のモニター改善

機器を開かないローカル確認は次を使う。実装範囲と実機で残る確認は[SINGING_MONITOR.md](SINGING_MONITOR.md)を参照する。

```powershell
npm test -- --run --maxWorkers=4
npx tsc --noEmit
npx vite build
# 以下はsrc-tauriで実行
cargo test --locked --lib --bins --test audio_queue_contract --test msix_coexistence
cargo check --locked --all-targets
cargo clippy --locked --all-targets
# 任意の非RT集計時間計測。実機・Engine全体の比較ではない
cargo test --locked --lib measure_fixed_period_publication_cost -- --ignored --nocapture
```

実機の連続運転には `python scripts/native_stability_probe.py <audio_engine.exe> <plan.json> <新規出力先>` を使う。
planは `durationSeconds`、`expectedPlugins`、JSON-RPCの `start`、`setup`（`command` と期待する応答 `expected` の配列）を明示する。
既定機器へ任せず機器ID・rate・routing・初期ゲイン・ミュートを固定し、停止時の通常設定を変更しない専用sidecarを使う。
各観測窓でstream epochとplugin件数を照合し、入力・要求・消費frameの停滞、zero fillやdropの増加を失敗とする。
`python -m unittest discover -s scripts -p test_native_stability_probe.py` はこの検証器の停滞・欠落検出を確認し、実機の代用にはしない。

停止中の製品HostのCPU比較には `node scripts/native-window-trial.cjs <AuralynHost.exe> <新規出力先> 60` を使う。
Windowsの一時利用領域で、通常表示→最小化→トレイを各60秒測定する。`psutil` とPlaywrightが必要である。
デバッガーは測定中に切断するが、デバッグ可能な起動とtimer/IPC観測のラップは残るため、無観測状態と同じとは扱わない。
CPUは1論理コア=100%、Hostと観測した子孫の標本平均、最大メモリは同時点の子孫合計の標本最大である。
複数回の順序を交互にし、機器・ビルド・sourceとbinaryのhash・他アプリの条件・ページエラーを残す。
Win32で強制表示する末尾の復帰は実際のトレイクリックの受入ではない。`resumed` を成功条件と誤認せず、実際の復帰経路を別途確認する。
`--ablate` は隔離した停止中Hostでtimerと背景glowだけを段階的に停止する診断用であり、処理中の音声へ使わない。

通常のcallback、配信queue満杯、mute世代、モード切替、配信workerの停止注入でRTのalloc/free 0を確認する。clock差の試験は数値列の合成であり、実clockの長時間安定や聴感の合格とは区別する。通常設定やOBS collectionを変更して試験を代用しない。

再生再開、consumerの停止、機器の再open、packetの集中、時刻の欠落と逆行、epoch変更、ppm、rate変更、RT割当の境界は [SYNC_BOUNDARY_VERIFICATION.md](SYNC_BOUNDARY_VERIFICATION.md) に整理する。


## 未解決Issueの回帰確認（#150・#152〜#156）

- VST不在の確認はファイルをロードせず、アクセス拒否を不在と扱わない。外れる名前と影響を示し、明示保存前に不在・保存原文・実ラック順序と件数・状態を再照合する。原文と復旧用プロファイルを保持し、非不在の復元失敗・競合・バックアップ/保存失敗では保護を解除しない。全件不在で空ラックを保存する場合も同じ条件とする。通常のプロファイル一覧から復旧用 `VST-recovery-…` を確認でき、元のVSTを元の場所へ戻してから復元する。実Hostでの再起動・復元は別途受入する。
- 歌・雑談登録では適用済み設定の範囲を情報ボタンで確認する。残響ONの雑談登録は明示確認後、登録用コピーだけOFFにし、現在の音を変えない。失敗・反映待ちでは次の調整への成功案内を出さない。
- 入力・出力のクリップ記録は10秒後も残り、色だけ弱める。新しい検出で警告色へ戻し、手動解除・再開始では記録を消す。音切れ表示は最後の回数増加から10秒保持し、詳細を開いて10秒以上経過してから閉じても常設入口へフォーカスが戻る。
- `e2e/browser/open-issues.spec.ts` は1200/1600/1920/2560pxのパネル隣接、960×640pxの目盛り間隔・一時非表示案内と復帰、高さ1100px以上の横メーター、低減設定とキーボードの即時開閉を確認する。既存の `home-responsive.spec.ts` と `streamer-refinement.spec.ts` も併用する。ブラウザIPCモックは実Tauri・Windows最大化・実DPI・読み上げ・実音声の受入ではない。


## VSTと歌・雑談モードの一体切替（Issue #151）

- `cargo test --locked --lib audio::mode_vst` は任意参照と内容変更、取得・復旧原本・無音ACK・各VST・内蔵完了・無音解除の段階を確認する。既存streamを使った成功、空/非空ラック、全件ロールバック、停止中の明示復旧、古い応答、遅い原本書込み・パイプ送信中の停止と緊急ミュートも確認する。実パイプ詰まりのテストは専用の非読取子プロセスを作成し、そのPIDだけを終了する。音声デバイスと通常設定は使わない。
- `cargo test --locked --lib mode_silence` はcallback末尾の無音ACK、入力停止→キュー排出→出力排出の順序、分離monitorと配信出力、古い送出block、不一致ID・世代・異常、レート変換のcarry破棄を確認する。callback処理の割当/解放が0であることを測る。耳までの無音成立時刻を測った試験ではない。
- 登録・失敗後の操作再開・手動復旧は `useLiveModes.test.tsx`、新ラックIDの同期と保存原本の保護は `usePluginsRackInvalidated.test.tsx` で確認する。`e2e/browser/live-mode-vst.spec.ts` はプロファイル関連付け、切替中の二重操作禁止、緊急ミュートへの到達、復旧の明示操作と完了後の操作再開を実ブラウザ・IPCモックで確認する。
- 完了時にはRust全体のtest/check/clippy/fmtとフロント全体・型・buildを実行する。実Tauri・複数の実VST・WASAPI/ASIO・実出力録音・OBS連動で、無音区間、旧音の混入、失敗時復旧、停止・緊急ミュートの優先、再起動の手動復旧、キーボード・読み上げを別途受入する。対象経路・VST/ドライバー/レート/bufferを記録し、未実施なら未確認とする。

## プロセス単独入力の段階0 probe

製品UIと分離した検証exampleを`process-loopback-probe` featureでビルドする。
取得・取消・対象終了・録音の保護と、原音の二重再生を防ぐ経路の合否を別々に扱う。
コマンドと実機確認の境界は[段階0の記録](PROCESS_LOOPBACK_STAGE0.md)を参照する。
単体試験は`src-tauri`で`cargo test --locked --example process_loopback_probe --features process-loopback-probe`。
実機runnerの実行は音声ストリームを開始するため、通常の自動テストへ追加しない。
既存runnerの`single_endpoint_gate`は、アプリのセッションミュート／音量ゼロを使った当初の同一再生先での試験である。別再生先への割当てや出力デバイス側のミュートは実行しない。
[見直した計画](plans/PROCESS_LOOPBACK_AND_MIXING.md)では、別再生先での原音抑止と取得の両立、使えない環境での仮想ケーブル入力を追加の検証対象にする。
原音が耳へ届かず、加工後の本人用出力は聴けること、他アプリが混入しないこと、切断時の挙動と元の設定への戻し方を記録する。未加工／加工後の比較は一つの返し経路で行う。
SGMの説明書や既存runnerの成功を新経路の実機合格へ読み替えない。追加の別再生先試験は `scripts/verify_process_loopback_route.py` で明示実行し、出力デバイス側のミュートと復元を確認する。


## プロセス単独入力の段階1

実装と確認範囲は[段階1の記録](PROCESS_LOOPBACK_STAGE1.md)を参照する。
Rustは `cargo test --locked --all-targets --features process-loopback-probe` と同条件のClippy（`-- -D warnings`）、フロントはVitest・TypeScript・Viteで確認する。
`e2e/browser/process-input.spec.ts` はIPCモックで、候補選択、保存時に機器入力と候補IDを混同しないこと、再選択、音楽鑑賞の用途を保ったままの機器入力への明示切替と狭い画面を確認する。入力の用途は使い道で決まり、接続のページでは別に選ばない（#723）。
`ProcessInputPanel.test.tsx` は一覧更新の非同期応答中に古い下書きへ戻さず、同じアプリの再生先変更では出力先だけを再選択することを確認する。
`e2e/browser/usage-switch.spec.ts` は接続のページの使い道の切り替えを、模擬IPCで確認する。ページは `?screen=` ではなく、ホームから左のレールの接続を押して開く（CIの本番ビルドでも通る）。切り替えの小窓（記録あり・実行中の再起動・失敗時に表示と音声設定が元のまま・記録なしはセットアップ・操作ロック中）、同じ見出しの連続（#712）、900×600から1280×800・日英の最初の表示に入力の選択欄が入ること、焦点の戻りを見る。撮影は `test-results/ux-eval-check/723-fix2/` に残る。アプリの音声の記録からの切り替えは、音を変えずに選択欄へ焦点が移ることを見る。アプリの音声の保存のあと表示の確定に失敗したときは、元の接続へ戻って「理由：…」が見える所に出ること、接続の適用の失敗の操作（設定に戻って再試行・ホームへ戻る）が出ないこと、接続の下書きが捨てられて保存欄が「変更はありません」で押せず選択が切り替え前と一致すること、上の帯が戻した接続の入力名を持つこと、もう一度切り替えられることを本番ビルドでも見る。理由の行は日本語が文節で折り返し、語の途中で切れないこと（`word-break: auto-phrase`）を見る。`UsageSwitchAppCommit.test.tsx` は、その失敗を切り替え全体の失敗として扱う巻き戻し（音声・親・保存値・表示・記録が切り替え前と一致すること、巻き戻し自体の失敗で戻せなかった対象を出すこと、動いていなかった音声は止めること）、接続の下書きを捨てて保存欄が変更なしになること、その後の編集・保存、変更を捨てて移動した再入場を確認する。`SetupRollbackThenConnect.test.tsx` は、初回のセットアップの失敗で未設定へ戻ったあと、接続のページから開始した要求と保存値に0の周波数・バッファが入らないことを確認する。`usageDevices.test.ts` は使い道ごとの機器と ASIO の経路の記録の読み書き（不正な形式を捨てること）と、再起動・保存・VST の復元のどこで失敗しても元の接続と保存値へ戻ることを確認する。`UsageSwitchApply.test.tsx` は、その巻き戻しで実際に呼ぶ再起動（経路と入力の用途つき）・VST の復元・元の音声が動いたままの場合・アプリの音声の記録・移行の確認の待ちを確認する（#723）。実音声の切り替えは確認していない。

`scripts/verify_process_engine_input.py` は実Engine、`scripts/verify_process_audio_engine.py` は実ケーブル入力（`--purpose voice|music`）、`scripts/verify-process-input-native.mjs` は実UI→Host→Engine→保存を確認する明示実行用の入口である。
通常の自動テストから音声を開始しない。実行時は、原音用の未使用・非既定の再生先と本人用出力を指定し、所有する小音量sourceだけを使う。
実Tauri runnerは保存先・WebView2・実行ファイルを隔離する。MCP CLIの接続先は起動したHostのPIDに対応するポートから選び、接続状態を確認してから操作する。
結果の音声データ、出力デバイス側のミュート、実際の聴感、Chrome等の個別アプリ、製品の1時間運転、ASIOマイク実機はそれぞれ別の確認として記録する。

Chrome・VLCと実VSTによる連続試験は `scripts/verify_process_app_soak.py` で明示実行する。
`--seconds 3900`で65分、ChromeのHTML音声は`--chrome-media-kind audio-element`を指定する。
出力デバイスのミュートとアプリのミュートを区別し、開始時の非ゼロ信号、一時停止・再開、VST稼働を確認する。
長時間の本人用出力はEngineの全体ミュートを使う。処理の稼働と聴感を同じ合否にしない。
監視JSONのWindowsでの読み取り競合は再試行し、表示用snapshotの競合だけで運転を止めず、`samples.jsonl`へ詳細を追記する。
自動試験で扱うミュートは所有するguardで復元し、通常のWindows既定・返し用出力の設定を保持する。
条件・警告・最終結果は[Chrome・VLCの確認記録](PROCESS_LOOPBACK_ACCEPTANCE_2026-11-02.md)、利用者の聴感確認は[試聴手順](PROCESS_LOOPBACK_AUDITION.md)に分ける。

## 原音比較の切替fade

実装と境界は[切替処理の改善](COMPARISON_SWITCH_TRANSITION.md)を参照する。
`audio_engine::comparison`のRust試験で逆極性の経路、複数rateと可変block、連打・取消、空ラック、起動時、RT無割当を確認する。
`verify_process_app_soak.py --comparison-switches`は実VST経路の音量比と64回の連打後の復帰を確認する明示試験である。
波形試験や入出力メーターを、クリックが耳で消えた証拠として扱わない。改善前の65分記録も改善版の長時間検証には使わない。

## 未保存設定の退避と手動復帰（Issue #221）

[復帰範囲の契約](UNSAVED_RUNTIME_RESTORE.md)と[先行対応の記録](UNSAVED_RUNTIME_ACCEPTANCE_2026-11-03.md)を参照する。
Rust全対象・probeとClippy、全Vitest、TypeScript、Viteに加え、`e2e/browser/temporary-runtime.spec.ts` を実行する。
退避なしの従来操作、範囲を変えた後の再確認、拒否時の保存値保持、未完了原本を成功表示しないことを確認する。

実機runnerは通常の自動テストに含めない。未使用・非既定・非ミュートのCABLE Input、Voicemeeter Input、TDR Novaとendpoint列挙用probeが必要。
`CARGO_TARGET_DIR`を専用ビルド領域に設定し、現行ソースのEngineを`cargo build --locked --bin audio_engine`で先にビルドする。
続いて `node scripts/prepare-process-input-audition.mjs <新しい専用アプリ領域>` でHost・scanner・フロントを分離ビルドし、次を明示実行する。

```powershell
node scripts/verify-unsaved-runtime-native.mjs <専用アプリ領域> <新しい証拠領域> <process_loopback_monitor_probe.exeの絶対パス>
```

runnerは物理マイクを開かず、CABLE Output→Voicemeeter Inputを全体ミュートで開始する。
TEMP/TMPを子プロセスごと隔離し、通常の一時領域・既定機器・共有MCPドライバーを変更しない。
再起動後の停止、通常設定の不変、原本の照合、Stop・ミュート・後編集での拒否、明示復帰後のVST状態を確認する。
対象外の音楽用途での停止前拒否、機器ID不一致、VST欠落時の原本保持も確認する。
空ラックと入出力の完全な0は、独立した試験用TEMPで退避・復帰し、復帰操作時の全体バイパスを保持することも確認する。
設定の反映が500 ms安定してから差分を取得し、反映待ちによる読み取り失敗だけを有限に取り直す。適用の拒否は自動再試行しない。
既存証拠は上書きせず、同じ所有アプリを再利用する場合だけ `--reuse-owned-app` を指定する。
削除待ちが出た場合は対象パスと原本を保持し、削除成功や共有PC全体の合格へ読み替えない。

## 分離出力を含む配信状態（Issue #222の先行対応）

[保存・復帰の契約と実機確認の境界](OUTPUT_CONFIGURATION_RESTORE.md)を参照する。
Rust全対象・probeとClippy、Vitest、TypeScript、Viteを確認し、`e2e/browser/output-configuration.spec.ts` で900×600の明示保存、両枝の差分、再起動案内と適用ボタンへの到達を確認する。
原本・旧schema、機器ID、出力ファイルの外部編集、現在の自分用処理、初期化済み音量の遅い再送を別の条件として検証する。

実機は前節と同じ方法で新しい専用アプリをビルドし、`scripts/verify-output-configuration-native.mjs <専用アプリ領域> <新しい証拠領域> <probeの絶対パス>` を明示実行する。
CABLE Output入力、Voicemeeter Inputへの返しとCABLE Inputへの配信用出力を開くが、全体ミュートは解除しない。
保存・差分・復帰は実UIを使い、Undo・欠落・外部編集・所有fixtureによるVST失敗・手動復旧を実Hostで確認する。
同じ所有アプリの再試験だけに `--reuse-owned-app` を使い、復旧待ちを解除しても原本ファイルは残す。
通常の自動テストには音声開始を含めず、独立した実機経路・聴感・ASIO・V-04の合格は別に記録する。

歌／雑談を含むschema 3は、同じrunnerへ`--live-modes`を付け、[モード保存・復帰の契約](LIVE_MODE_STATE_RESTORE.md)を確認する。
通常プロファイルを後編集した後の実UI保存・復帰、歌／雑談の選択と空ラックのUndo、関連VST欠落、モード定義の外部編集を扱う。
復帰中のStop・ミュートで中断と原本保持を確認し、手動復旧後に再適用する。
最後に専用Hostを終了・再起動し、明示開始後の通常モード操作で、専用保存先の関連VSTが両モードへ適用されることを確認する。
新しい証拠領域を毎回使い、過去の失敗や原本は置換しない。全体ミュートを維持し、聴感受入とは分ける。

プロセス単独入力のschema 4は、同じrunnerの`--process-input`で[保存・復帰の契約](PROCESS_STATE_RESTORE.md)を確認する。
所有するテスト再生プロセスだけを使い、未使用のCABLE Inputを原音用に一時ミュートし、必ず元へ戻す。
実UIで保存・差分・復帰し、PIDの非保存、終了したプロセスの拒否、再起動した同じアプリの明示再選択、用途の不一致を確認する。
Stop・VST読込失敗・Host再起動後の手動復旧と、声／音楽の用途を分けて扱う。通常の再生アプリや物理マイクは操作しない。

一時利用前の拡張退避は[共通契約](EXTENDED_TEMPORARY_RESTORE.md)に従う。
`verify-unsaved-runtime-native.mjs`に`--split-modes`を付け、分離出力と関連VST付きの歌モードを退避し、通常設定の保持と明示復帰を確認する。
この構成では仮想ケーブルの入出力を同時に使うため、ミュート解除のケースは実行しない。従来の単独出力のrunnerでは解除時の復帰拒否も確認する。
`verify-output-configuration-native.mjs --process-input`には、音楽用途のプロセス入力を退避して一時利用へ移り、アプリを起動し直した後に通常設定側で明示再選択して復帰するケースを含める。
runtime 1とruntime 2、原本schemaとの一致、機器IDの後編集、原本のSHA-256はRust試験でも確認する。
両runnerに`--expect-cleanup`を付けると、通常設定へ戻った後の所有する一時領域の削除も必須条件にする。
短いファイルロックは有限に再試行し、解放されなければ削除失敗を通知して残す。

ブラウザテストは開始時に出力先を消すため、`playwright.config.ts`の`outputDir`を`test-results/browser-output`へ限定する。
`test-results`直下や実Hostの試験環境を`--output`に指定しない。実Hostのログ・原本・バイナリはこの専用出力先の外に置く。


## 配信ミックスのUI（Issue #234〜#254）

[対応と確認記録](UI_MIXING_ACCEPTANCE_2026-11-03.md)を参照する。
`e2e/browser/mixing.spec.ts` はオケを開かない配信VSTの入口、自動取得、音量・ミュートの連続操作、失敗時の実値表示、キーボード並べ替え、日英と150%を確認する。
DOM試験は編集内容の保持、revisionの競合、遅い応答、入力ペア、保存範囲の要求互換、専用差分表、診断を扱う。

`npm run test:e2e:native -- --mixing-ui` は保存先を分離した実HostでTDR Novaを使い、音声を開始せず追加・並べ替え・初期化と実WebView2の150%を確認する。
ズーム権限はこの明示試験の隔離Hostだけに付ける。
実スクリーンリーダーの発話、実機音声、稼働中のホーム状態は、自動試験の成功に含めない。

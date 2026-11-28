# テスト計画書 (Verification Plan)

本アプリケーションの品質、安定性、および使いやすさを確認するための自動・手動テストの手順です。

日常の入口は`npm run verify -- --changed`、全体は`--full`、Rustの関連検証は`--static --rust`。
準備・出力・既存負債の扱いは[GARDENING](GARDENING.md)、機能からの探索は[feature-map](feature-map.md)、画面（GPUI 版）の確かめ方は [src-gpui/README.md](../src-gpui/README.md) を参照する。

類似アプリとの比較やリソース使用量を含む評価の軸は [EVALUATION_CRITERIA.md](EVALUATION_CRITERIA.md) に定める。

検証用のビルド・一時領域の作成と終了後の整理は [ビルド領域・容量管理](BUILD_GUIDE.md#ビルド領域容量管理) に従う。並行検証に必要な隔離と証跡を保ち、再生成可能な成果物を作業ごとに残し続けない。

## 自動テストの層と実行方法

- 利用者向けドキュメント（`user-docs/`）の日英・リンク・UI名の照合は、Tauri 版の Vitest と一緒に 2026-11-28 に無くなった。いまは `auralyn-ui-model` の `docs.rs` の試験が `links.json` の行き先だけを確かめる。

### Pull Requestの自動チェック

`.github/workflows/rustsec-audit.yml` は PR・main 更新・週次・手動で直下の `Cargo.lock` を最新の RustSec DB と照合する。ローカルでも依存更新時とリリース前に `cargo audit --file Cargo.lock` を実行する。導入と例外の扱いは [DEPENDENCY_MAINTENANCE.md](DEPENDENCY_MAINTENANCE.md) を参照する。これは署名、実機、Rustビルドの検証とは別であり、GitHub 上の実行結果と branch protection 設定は別途確認する。

`.github/workflows/frontend-quality.yml` はPR、main更新、手動実行で検査を回す（名前は既存の必須チェックに合わせて残している）。
`checks`（Windows）は Node.js 24・Python 3.12 で `npm run verify -- --full`（設定指紋・Ruff・Rust 例外台帳・検査器の試験・UI用語・制御文字・スクリプト試験）を実行する。
`rust`（Linux）は直下の `cargo fmt --all -- --check` と、`auralyn-core`・`auralyn-ui-model` の Clippy と試験を実行する。
最後の `frontend` は `checks` と `rust` の両方の成功を要求し、失敗・取消・skipを成功扱いにしない。
CIで失敗した検証CLIの詳細は`test-results/gardening`から7日間のartifactへ保存する。
既存証拠を含む `test-results` の初期化を避け、公開・デバイス開始・通常設定の変更は行わない。

これらのjobは `auralyn-core`・`auralyn-ui-model` 以外のRustビルド（vst-host、GPUI 版）、GPUI 版の実機、ASIO/WASAPI、聴感、長時間運転の合格を表さない。
workflowの追加とGitHub上での実行成功は別に記録する。branch protectionへの必須チェック登録はリポジトリ管理者が設定する。
Actionsは公式リポジトリのcommitへ固定し、更新時は [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[upload-artifact](https://github.com/actions/upload-artifact) の対応runner・Node要件を確認する。

`npm run lint:terms` は、`crates/auralyn-core/locales/{ja,en}.json` の日本語と英語を `config/ui-terms.json` と照合する。使わないと決めた語、かぎかっこや空白だけを挟んだ同じ語句の重なり（英語は同じ単語の連続）、用語集の使う語から離れた定義を、人の評価より前に止める。

直すときは、失敗したキーの文言を `docs/DESIGN.md` 4章の使う語へ合わせる。その語が文脈上正しいときは、`config/ui-terms.json` の `allow` に `key`、`term`、`reason` を足す。用語を足したり変えたりしたときは、4章の表と `terms` の `use` を両方更新する。`use` が4章の使う語の列に無いと検査は失敗する。

| 層 | 目的 | 実行 |
| --- | --- | --- |
| 画面の規則（Rust） | メーターの読み・判定・候補の絞り込みなど、GPUI に依存しない規則 | `cargo test -p auralyn-ui-model` |
| 中核（Rust） | 計算・変換・バリデーション・IPC引数・状態遷移 | `crates/vst-host` の `cargo test --locked --lib`、下記の統合試験 |
| 画面（GPUI） | 画面の組み立て・部品の試験 | `cargo test -p auralyn-gpui`（Windows） |
| 実機 | 実際の描画・フォーカス・狭い窓・日英・実音声 | Windows の実機。手順は [src-gpui/README.md](../src-gpui/README.md) |

### 変更中の確認と全体確認

Rustの単体処理を変更中は `cargo test --locked --lib <対象名>` を使い、IPC・プロセス寿命を変更した場合は対応する統合試験も実行する。
ビルド時間とテスト本体の時間は分けて記録する。
外部キューの契約試験やクラス名の確認は件数だけを理由に削除せず、実処理・実画面で同じ契約を検出できることを確認してから整理する。

### 実sidecarのプロセス境界と実機試験

`crates/vst-host`で `cargo test --locked --test integration_test --test repro_ott` を実行すると、
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
Set-Location D:\Programming\App\VSTHost\crates\vst-host
$env:CARGO_TARGET_DIR = 'D:\Programming\App\VSTHost\target'
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

- Host：`D:\Programming\App\VSTHost\target\debug\AuralynHost.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 21:54:12、47357440 バイト、SHA-256 `FFEDB027A2666C725376548F8D2CA14419A403FEE2AE0C07736B9C9AC8CD675E`）。`tauri dev` が作業ツリーからビルドした（2分24秒）。ソースは 8a826618 に、のちに 6d8ea1f4 でコミットした未コミットの変更（`spawn_engine_binary` への分割と `apply_creation_flags`）を足したもの。ビルド時点の差分の SHA は記録なし。実行後に Host は作り直していない。
- 子：`D:\Programming\App\VSTHost\target\debug\audio_engine.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 15:23:31、5642240 バイト、SHA-256 `D209780413B2A2024278BB479B8692C04819C988C78F901185CAE7C3C33B439D`）。この確認では作り直していない（改名して戻しただけで、内容は同じ）。ビルド時のコミットは記録なし。`audio_engine` と `bin` のソースが最後に変わったコミットは ef32e034（2026-11-20）で、それ以降は変更がないため、そのソースと同じ内容と推定する。release の子は使っていない。
- 実行したコマンド：`$env:CARGO_TARGET_DIR = <リポジトリ>\target`、`$env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'`、`npm run tauri -- dev --no-watch --config src-tauri/tauri.debug-global.conf.json`、`npx -y -p @hypothesi/tauri-mcp-cli@0.13.2 tauri-mcp driver-session start --host 127.0.0.1 --port 9223`。

- (a) 起動：主の子（PID 5140）が起動し、`IsProcessInJob` が真。`stop_audio` の後に `post_mix` の `restore_saved` で配信ミックスの子（`--post-mix-worker`）が起動し、同じく Job に入っていた。起動の失敗：主の子を `Stop-Process` し、`audio_engine.exe` を一時的に改名すると、`get_audio_devices` は「Audio Engine binary not found」で失敗した。元の名前へ戻した後の同じ操作は成功し、新しい子が起動した。この失敗は、子が見つからない経路（Job の失敗の経路ではない。Job・割り当て・再開の失敗は注入の試験で確認した）。
- (b) 通常の終了：主の子（PID 54892）が動き、`get_audio_devices`（再検出）が作る `--scan` の孫（PID 26372）が生きている状態で、`quit_app` を実行した。孫は一瞬で終わるため、監視のジョブが現れた瞬間に `NtSuspendProcess` で止めて生かした（孫は実プロセス）。監視のジョブが起動時に取った Process のハンドル（開始時刻つき）で、Host の終了コード 0、子と孫の終了を確認した。残ったプロセスはなかった。
- (c) 強制の終了：別の起動（Host 56820、主の子 47596、孫 55820＝止めた `--scan`）で、`Stop-Process -Id <Host> -Force` により Host だけを終了した（終了コード -1）。同じ方法で、子と孫がどちらも終了したことを確認した。
- 実行後、`AuralynHost`・`audio_engine` のプロセス、`.hold` に改名したファイルの残りはない。
- MSIX：行っていない。当時の `docs/MSIX_PROTOTYPE.md`（2026-11-28 に削除）の手順は、署名用の証明書の作成と、LocalMachine の信頼するストアへの登録（管理者の操作）、`Add-AppxPackage` が要る。システムの設定を変えるので実施していない。必要なのは、(1) 試験用の証明書の信頼登録（管理者）、(2) 署名済みの MSIX のインストール、(3) 同じ確認（ネストした Job の下での主・配信ミックスの起動、通常と強制の終了）。

#### 配布用ビルド（release の Host と、その横の release の子）での確認の結果（2026-11-21）

インストーラー（NSIS）では確認していない。理由：インストーラーは PC にインストールするため、利用者がふだん使っている Auralyn を上書きするおそれがある。代わりに、`npm run tauri -- build --no-bundle` で作った release の Host と、その同じフォルダーに置かれた release の子（インストール後と同じ並び）を、ビルド先から直接起動した。`--no-bundle` にした理由：`createUpdaterArtifacts` が有効で、NSIS の成果物の段階は署名の鍵を要するため。インストーラーの生成、署名、MSIX、インストール先のパス（`Program Files` 配下など）での確認は未実施。

- ビルド：`$env:CARGO_TARGET_DIR = <リポジトリ>\target` のもとで `npm run tauri -- build --no-bundle`（`beforeBuildCommand` の `npm run build` が release の `audio_engine` と `plugin_scanner` を作る）。`Built application at: ...\target\release\AuralynHost.exe`、終了コード 0。ビルド時のコミットは 2a41e452（作業ツリーの未コミットの差分は、試験・文書だけ。製品のコードは同じ）。
- Host：`D:\Programming\App\VSTHost\target\release\AuralynHost.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 22:38:58、18089984 バイト、SHA-256 `B8C7ADE3DA013F827066DD12E9D354A4AA278228035732557B296B498CC86538`）。
- 子：`D:\Programming\App\VSTHost\target\release\audio_engine.exe`（ファイルの版 1.1.0、更新時刻 2026-11-21 22:37:12、5662208 バイト、SHA-256 `4367FE1657593F0BE0B80EA5F3982F7891EC163B8F56EA762E82B1FA5A19F458`）。実行中のプロセスの `ExecutablePath` がこのファイルであることを確認した。参考：`src-tauri\bin\audio_engine-x86_64-pc-windows-msvc.exe` の SHA-256 は `D43D30471C835A4AAFAB2B3BA1FD425B782749A84ECB45F41A8CF4B7B3078F75` で、上のファイルとは一致しなかった（原因は調べていない。確認に使ったのは上の `release\audio_engine.exe`）。
- 起動と操作：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` を設定して Host を直接起動し、WebView2 の DevTools プロトコル（`Runtime.evaluate`）で `window.__TAURI_INTERNALS__.invoke` を実行した（release にはデバッグ用の bridge がないため）。
- (a) 起動：主の子が起動し Job に入っていた。`stop_audio` の後、`post_mix` の `restore_saved` で配信ミックスの子が起動し、同じく Job に入っていた。子を終了して `audio_engine.exe` を一時的に改名すると `get_audio_devices` は「Audio Engine binary not found」で失敗し、戻した後の同じ操作は成功して新しい子が起動し、Job に入っていた（子が見つからない経路。Job の失敗の経路は注入の試験で確認した）。
- (b) 通常の終了：Host 40428、主の子 46860、`--scan` の孫 53860（現れた瞬間に `NtSuspendProcess` で止めて生かした実プロセス）。`quit_app` の後、Host の終了コード 0、子と孫が終了した。ハンドルは、起動のときに取った Process（開始時刻つき）。
- (c) 強制の終了：Host 66716、主の子 43032、孫 32608（止めた `--scan`）。`stop_audio` で音声を止めてから、`Stop-Process -Id <Host> -Force` で Host だけを終了した（終了コード -1）。子と孫が終了した。
- 自動の開始：起動の直後に、保存した設定で音声が自動で始まった。(a) と (c) は確かめる前に `stop_audio` で止めた。(b) は止めずに `quit_app` した（終了とともに止まった）。聴感の確認ではない。
- 後始末：実行後に `AuralynHost`・`audio_engine` のプロセスはなく、改名したファイルは元の名前に戻した。容量は足りたので、キャッシュは消していない（空き約 16 GB）。

### 落ちる・固まるVSTでの実機の確認（#462）

試験用の VST3「Auralyn Crash Test」（`crates/vst-host/examples/crash_vst3.rs`。配布しない）は、指定した操作で `abort` する、または止まらずに回り続ける。指定は `%TEMP%\auralyn-crash-vst3.txt`（前後の空白は無視）に書く。

- 操作名：`load`・`set_state`・`get_state`・`open_editor`・`processing_setup`・`process`。`hang:<操作名>` なら落ちずに固まる。ファイルがない・一致しないときは普通に動く。
- 落とすのは、実行ファイル名が `audio_engine` で始まるプロセスの中だけ（スキャナーでは落とさない）。`process` は `setupProcessing` でファイルを読んで控えるので、音声スレッドではファイルを読まない。

```powershell
$env:CARGO_TARGET_DIR = 'D:\Programming\App\VSTHost\target'
cargo build --manifest-path crates/vst-host/Cargo.toml --locked --example crash_vst3 --release
$bundle = "$env:CARGO_TARGET_DIR\crash-vst3\Auralyn Crash Test.vst3\Contents\x86_64-win"
New-Item -ItemType Directory -Force $bundle | Out-Null
Copy-Item "$env:CARGO_TARGET_DIR\release\examples\crash_vst3.dll" "$bundle\Auralyn Crash Test.vst3" -Force
```

Auralyn の「VSTを追加」の「探すフォルダー」へ `...\target\crash-vst3` を足すと見つかる。`C:\Program Files` へは置かない。DLL は音声エンジンが読んでいる間は上書きできない（アプリを終了してから写す）。確認の結果は [ISSUE_462_ACCEPTANCE_2026-11-24.md](verification/ISSUE_462_ACCEPTANCE_2026-11-24.md)。

### 自発的に状態が変わるVSTの確認（#465）

開発用CLI `vst_state_drift` は、操作なしで生成信号をVSTへ渡し、`getState`の内容を比較する。
本体と同じカタログクラス選択・bus交渉・遅延接続・処理準備を使うが、音声デバイスとエディターは開かず、出力音声は破棄する。
`externalBin`には追加せず、配布物には含めない。新しいcrate依存は不要。

PowerShellの例（既存の `target` に出力する）：

```powershell
Set-Location D:\Programming\App\VSTHost\crates\vst-host
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
| 画面（GPUI） | `npm run verify -- --static --rust`、Windows の実機で変更画面の操作・フォーカス・狭い窓・日英 |
| Rust / IPC | `cargo test --locked`、`cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`（`crates/vst-host`で実行）。対象テストに実機・プラグインが必要か事前確認 |
| 音声系 / native window依存 | Rust検証に加え、WASAPI / ASIO、44.1k / 48k、異なるバッファ、デバイス切替、VST追加・削除・復元、GUI開閉・DPI、連続運転で音切れ・CPU・遅延・音質を更新前後比較 |
| インストーラー / updater | 署名ビルド、旧版からの更新、設定・プリセット移行、Source ZIP・SHA-256・manifest整合、公開後の取得確認 |

実行していない実機・インストール・OBS・公開確認は「未確認」と報告してください。
依存更新時は RustSec 監査も行います。自動テスト成功だけで音声・配布の互換性を保証しません。

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

OTTをインストールした環境では、`crates/vst-host`で `cargo test --locked --test ott_module_lifetime -- --ignored` を明示実行し、複数インスタンスの遅延解放とDLL共有寿命を確認する。メモリ内の無音だけを処理し、実機ストリームは開始しない。通常のテスト実行ではignoreされる。

100%以外の実DPI・異なるOTT版・長時間音声中の挙動は別途検証する。

以下の「回帰確認」の節（UI監査・再レビュー・デザイン監査・各 Issue）は、Tauri 版の画面で確かめた項目の記録。画面の部品名や `npm test` は Tauri 版のもので、GPUI 版の合格を表さない。GPUI 版では、同じ利用者の目的を GPUI の画面と実機で確かめる。

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
`crates/vst-host/src/obs_setup.rs`。UI は IPC モック、Rust は設定読み書きの模擬実装で検証する。
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
# 以下はcrates/vst-hostで実行
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
単体試験は`crates/vst-host`で`cargo test --locked --example process_loopback_probe --features process-loopback-probe`。
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

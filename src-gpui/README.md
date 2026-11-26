# Auralyn の GPUI 版

Tauri 版を置き換える GPUI Kit の画面。今は、窓の外枠（左のレール・先頭の帯の開始と停止）、右の列（本番中の操作）、ホームの音の流れの帯、接続の画面（機器・周波数・バッファを選んで開始）、音づくり（ノイズ低減と声を整える）、VST の並びがある。実エンジンにつながる。

- 決定と知見：[docs/gpui/decisions.md](../docs/gpui/decisions.md)、[docs/gpui/knowledge.md](../docs/gpui/knowledge.md)
- 試作の判定の記録：[docs/plans/gpui-prototype-checklist.md](../docs/plans/gpui-prototype-checklist.md)

## 構成

| ファイル | 役割 |
| :--- | :--- |
| `src/engine/` | `AudioHost` を専用のスレッドで動かす。命令は受付順に1本で実行し、続けて届いた音量は最後の値だけを送る。通知は `AudioHost::set_event_sink`（`auralyn_core::event::EventSink`）で受け、メーターは最新の値だけを置く。`mod.rs` が命令の受付と開始・停止、`slots.rs` が VST の並び、`sound.rs` が音づくり・ピーク保護・測定、`profile.rs` が保存した構成、`events.rs` が中核の出来事の読み取り |
| `src/view.rs` | 窓の中身。レール・帯・行き先の画面と、右の列（本番中の操作。描画は `src/view/safety.rs`）。16ms の周期を1つ共有する（GPUI に窓が隠れているかを知る手段がなく、隠れている間も止めない） |
| `src/shell.rs` | 窓の外枠。左のレール（行き先）、先頭の帯（音声の状態と開始・停止）。開始・停止の状態は `auralyn-ui-model` の `session` |
| `src/connect.rs` | 接続の画面。接続方式・マイク・出力先・周波数・バッファを選び、その機器で開始する（開始できると設定が保存される）。最初に選ぶ項目は `auralyn-ui-model` の `connect` |
| `src/settings.rs` | 設定の画面。表示言語（日本語・English）と、Windows との連携（トレイ）が使えるかと、グローバルショートカットの一覧（使えるか・使えない理由）と、版。診断（稼働統計：開いたときと「統計を更新」で読む）と、読み込みを止めた VST のリセット（確認の窓あり）。規則は `auralyn-ui-model` の `diagnostics` |
| `src/locale_file.rs` | 表示言語の保存（`gpui_locale.json`）。無ければ Tauri 版の `display-locale.json` を読むだけ |
| `src/sound.rs` | 音づくりの画面。ノイズ低減（ON/OFF・弱／強・環境に合わせる（測定値・会場）・抑制の強さ・声を守る）と「声を整える」（ON/OFF・種類・整え具合）と、大きな音を抑える（ON/OFF・天井・復帰時間。アプリの中だけで持つ）。値の読み方は `auralyn-ui-model` の `sound`、保存は `engine/sound.rs` の `gpui_sound.json` |
| `src/measure.rs` | 周囲の音の測定（3秒測る・中止・話していないと確かめて採用）。測定値・会場のときに音づくりの詳細に出す。規則は `auralyn-ui-model` の `measurement` |
| `src/setups.rs` | 保存した構成（Tauri 版と同じ `presets/`）。選んで適用・直前の状態に戻す・名前を付けて保存・削除・ファイルへ書き出す／ファイルから読み込む。VST の並び・ノイズ低減・声を整える設定だけで、接続は変えない。規則は `auralyn-ui-model` の `profile` |
| `src/live.rs` | 接続の画面の「自分用と配信用に分ける」。加工後の声を別の WASAPI 出力（OBS が取り込む）へも送る出力先・自分用と配信用の音量・自分だけ聴かないを選び、二重取り込みを確かめてから保存する（Tauri 版と同じ `live_output.json`）。画面を出している間は 1 秒ごとに状態を読む。処理を分けるかも選べる（初めて分けるときは自分用の歌・雑談の加工を Tauri 版の既定で入れ、その細かい値はまだ変えない）。エンジン側は `engine/live.rs`、規則は `auralyn-ui-model` の `live_output` |
| `src/mix.rs` | ホームの配信ミックス。別の WASAPI 入力機器（仮想ケーブルなど）の2チャンネルをオケとして声に混ぜ、配信用の出力へ送る（Tauri 版と同じ `AudioHost::mixing`・`mixing.json`）。配信用の出力で処理を分けてあり、音声が止まっていて、経路を確かめたときだけ適用できる。適用中は声・オケの音量とミュート、本人への返しを変えられる。保存に問題があれば読み直す。アプリの音・時間合わせ・ミックス後の VST はまだ無い。エンジン側は `engine/mix.rs`、規則は `auralyn-ui-model` の `mix` |
| `src/voice.rs` | ボイスチェック（音づくりの画面の下）。声を最大 10 秒録り、加工前・加工後を WAV で保存し、配信に乗らない別の出力先で聴き比べる（出力先が配信・通話に取り込まれていないと確かめるまで鳴らさない）。録音・保存・試聴は音声が流れているときだけで、画面を離れる・窓を隠すと録音を止め試聴を閉じる。試聴のセッションは `engine/voice.rs`。波形・解析・候補の比較はまだ無い。規則は `auralyn-ui-model` の `voice_check` |
| `src/vst.rs` | VST の画面。並び（ON/OFF・音量・ミュート・上へ／下へ・編集・削除）と、スキャンした候補からの追加。候補の検索と入れ替えの規則は `auralyn-ui-model` の `rack`。並びは `engine/slots.rs` が設定のフォルダの `gpui_rack.json` に保存する |
| `src/assets.rs` | アイコン。GPUI Kit の既定の組に無いものだけを `icon_assets!` で足す |
| `src/home.rs` | ホームの区画。今は音の流れの帯（加工前の包絡線と、加工後＝`processed` の塗り）。DESIGN.md 10.5 の「入力か出力が live」は、GPUI 版では「入力か加工後が live」と読む |
| `src/color.rs` | 色。`design/tokens.json` から名前で取る |
| `src/part.rs` | 画面どうしで同じ形の部品（見出しつきの区画・補足の文） |
| `src/store.rs` | 設定のファイルを、一時ファイルに書いてから置き換える |
| `src/desktop.rs` | トレイ（tray-icon）と、Tauri 版と同じ `shortcuts.json` のグローバルショートカット（global-hotkey。読むだけで、無ければ Alt+M・Alt+P。歌・雑談は GPUI 版に無いので登録しない）と、窓の × でトレイへ隠す（Win32 の ShowWindow）。Windows だけ |
| `src/i18n.rs` | 日英の文言（正本は `src-tauri/crates/auralyn-core/locales/` の JSON。キーは `keys` の定数で渡す） |
| `src/main.rs` | 引数を読み、エンジンと窓を起動する |

メーターの読み（平滑化・2秒のピーク保持と毎秒 20 dB の下降・1秒での更新停止・一言の判定・−60〜0 dBFS の目盛り）と音の流れの帯の規則（`flow`）は、GPUI に依存しない [`src-tauri/crates/auralyn-ui-model`](../src-tauri/crates/auralyn-ui-model) に置く。`useMeterLevels.ts`・`outputVerdict.ts`・`SoundFlow.tsx` の写しで、ピークの下がり方だけ変えた（[decisions.md](../docs/gpui/decisions.md)）。

## 動かし方（Windows）

```powershell
cd src-tauri
cargo build --bin audio_engine --bin plugin_scanner
cargo test -p auralyn-ui-model
cd ..\src-gpui
cargo test
cargo run
```

引数：`--lang ja|en`（指定しなければ保存した表示言語）、`--config-dir <フォルダ>`（既定は `%APPDATA%\com.kuro7983.auralynhost`）。

Tauri 版の Auralyn は閉じてから起動する。

## 確かめ方

`npm run verify -- --static --rust`（Windows）が、`src-tauri` に続けて `src-gpui` の fmt・Clippy・試験も回す。CI は Linux で `auralyn-ui-model` の Clippy・試験と `src-gpui` の書式だけを見る（`src-gpui` は Windows 専用の `vst-host` に依存するため）。実機での合否は、確かめた日・手順・結果を PR に書く。

ビルド領域は `src-tauri/target` を共有する。2つの `Cargo.lock` で版の違う依存（`vst-host` を含む）は2回ずつビルドされ、`cargo clean` はどちらで打っても両方の成果物を消す。

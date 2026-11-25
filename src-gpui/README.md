# Auralyn の GPUI 版

Tauri 版を置き換える GPUI Kit の画面。今は、窓の外枠（左のレール・先頭の帯の開始と停止）、右の列（本番中の操作）、ホームの音の流れの帯、接続の画面（機器を選んで開始）がある。実エンジンにつながる。ほかの行き先は「まだ無い」と出し、今までの版で設定するよう案内する。

- 決定と知見：[docs/gpui/decisions.md](../docs/gpui/decisions.md)、[docs/gpui/knowledge.md](../docs/gpui/knowledge.md)
- 試作の判定の記録：[docs/plans/gpui-prototype-checklist.md](../docs/plans/gpui-prototype-checklist.md)

## 構成

| ファイル | 役割 |
| :--- | :--- |
| `src/engine.rs` | `AudioHost` を専用のスレッドで動かす。命令は受付順に1本で実行し、続けて届いた音量は最後の値だけを送る。通知は `AudioHost::set_event_sink`（`auralyn_core::event::EventSink`）で受け、メーターは最新の値だけを置く |
| `src/view.rs` | 窓の中身。レール・帯・行き先の画面と、右の列（本番中の操作）。確認用の欄（IME・VSTのエディタ・言語）は設定の画面に置く。16ms の周期を1つ共有する（GPUI に窓が隠れているかを知る手段がなく、隠れている間も止めない） |
| `src/shell.rs` | 窓の外枠。左のレール（行き先）、先頭の帯（音声の状態と開始・停止）、まだ無い画面の案内。開始・停止の状態は `auralyn-ui-model` の `session` |
| `src/connect.rs` | 接続の画面。接続方式・マイク・出力先を選び、その機器で開始する（開始できると設定が保存される）。最初に選ぶ項目は `auralyn-ui-model` の `connect` |
| `src/vst.rs` | VST の画面。並び（ON/OFF・上へ／下へ・編集・削除）と、スキャンした候補からの追加。候補の検索と入れ替えの規則は `auralyn-ui-model` の `rack`。並びはまだ保存しない |
| `src/assets.rs` | アイコン。GPUI Kit の既定の組に無いものだけを `icon_assets!` で足す |
| `src/home.rs` | ホームの区画。今は音の流れの帯（加工前の包絡線と、加工後＝`processed` の塗り）。DESIGN.md 10.5 の「入力か出力が live」は、GPUI 版では「入力か加工後が live」と読む |
| `src/color.rs` | 色。`design/tokens.json` から名前で取る |
| `src/desktop.rs` | トレイ（tray-icon）と Alt+M（global-hotkey）。Windows だけ |
| `src/i18n.rs` | 日英の文言（正本は `src-tauri/crates/auralyn-core/locales/` の JSON。試作のときに写した分を、そこから読む形へ順に置き換える） |
| `src/main.rs` | 引数を読み、エンジンと窓を起動する |

メーターの読み（平滑化・2秒のピーク保持と毎秒 20 dB の下降・1秒での更新停止・一言の判定・−60〜0 dBFS の目盛り）と音の流れの帯の規則（`flow`）は、GPUI に依存しない [`src-tauri/crates/auralyn-ui-model`](../src-tauri/crates/auralyn-ui-model) に置く。`useMeterLevels.ts`・`outputVerdict.ts`・`SoundFlow.tsx` の写しで、ピークの下がり方だけ変えた（[decisions.md](../docs/gpui/decisions.md)）。

## 動かし方（Windows）

```powershell
cd src-tauri
cargo build --bin audio_engine --bin plugin_scanner
cargo test -p auralyn-ui-model
cd ..\src-gpui
cargo test
cargo run -- --plugin "<確認に使うVST>.vst3"
```

引数：`--plugin <VST3>`、`--lang en`、`--config-dir <フォルダ>`（既定は `%APPDATA%\com.kuro7983.auralynhost`）。

Tauri 版の Auralyn は閉じてから起動する。

## 確かめ方

`npm run verify -- --static --rust`（Windows）が、`src-tauri` に続けて `src-gpui` の fmt・Clippy・試験も回す。CI は Linux で `auralyn-ui-model` の Clippy・試験と `src-gpui` の書式だけを見る（`src-gpui` は Windows 専用の `vst-host` に依存するため）。実機での合否は、確かめた日・手順・結果を PR に書く。

ビルド領域は `src-tauri/target` を共有する。2つの `Cargo.lock` で版の違う依存（`vst-host` を含む）は2回ずつビルドされ、`cargo clean` はどちらで打っても両方の成果物を消す。

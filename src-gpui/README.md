# Auralyn の GPUI 版

Tauri 版を置き換える GPUI Kit の画面。今は右の列（本番中の操作）だけで、実エンジンのメーターにつながる。右の列の試作から始めた。

- 決定と知見：[docs/gpui/decisions.md](../docs/gpui/decisions.md)、[docs/gpui/knowledge.md](../docs/gpui/knowledge.md)
- 試作の判定の記録：[docs/plans/gpui-prototype-checklist.md](../docs/plans/gpui-prototype-checklist.md)

## 構成

| ファイル | 役割 |
| :--- | :--- |
| `src/engine.rs` | `AudioHost` を専用のスレッドで動かす。命令は受付順に1本で実行し、続けて届いた音量は最後の値だけを送る。通知は `AudioHost::set_event_sink`（`auralyn_core::event::EventSink`）で受け、メーターは最新の値だけを置く |
| `src/view.rs` | 右の列の画面。16ms の周期を1つ共有する（GPUI に窓が隠れているかを知る手段がなく、隠れている間も止めない） |
| `src/desktop.rs` | トレイ（tray-icon）と Alt+M（global-hotkey）。Windows だけ |
| `src/i18n.rs` | 日英の文言（`src/i18n/messages.ts` から写した分だけ） |
| `src/main.rs` | 引数を読み、エンジンと窓を起動する |

メーターの読み（平滑化・2秒のピーク保持・1秒での更新停止・一言の判定・−60〜0 dBFS の目盛り）は、GPUI に依存しない [`src-tauri/crates/auralyn-ui-model`](../src-tauri/crates/auralyn-ui-model) に置く。`useMeterLevels.ts` と `outputVerdict.ts` の写し。

## 動かし方（Windows）

```powershell
cd src-tauri
cargo build --bin audio_engine
cargo test -p auralyn-ui-model
cd ..\src-gpui
cargo test
cargo run -- --plugin "<確認に使うVST>.vst3"
```

引数：`--plugin <VST3>`、`--lang en`、`--config-dir <フォルダ>`（既定は `%APPDATA%\com.kuro7983.auralynhost`）。

Tauri 版の Auralyn は閉じてから起動する。

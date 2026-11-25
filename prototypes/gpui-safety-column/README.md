# GPUI の試作：右の列

Auralyn の右の列（本番中の操作）を GPUI Kit で作り、実エンジンのメーターにつなげた試作。main へは入れない。

- 目的と判定の表：[docs/plans/gpui-prototype-checklist.md](../../docs/plans/gpui-prototype-checklist.md)
- 方針：[docs/plans/audio-session-controller.md](../../docs/plans/audio-session-controller.md) 13.2（J-11）

## 構成

| ファイル | 役割 |
| :--- | :--- |
| `src/engine.rs` | `AudioHost` を専用のスレッドで動かす。命令は受付順に1本で実行し、続けて届いた音量は最後の値だけを送る。通知は `AudioHost::set_event_sink`（`auralyn_core::event::EventSink`）で受け、メーターは最新の値だけを置く |
| `src/meter.rs` | 平滑化・2秒のピーク保持・1秒での更新停止・一言の判定・−60〜0 dBFS の目盛り。`useMeterLevels.ts` と `outputVerdict.ts` の写し |
| `src/view.rs` | 右の列の画面。16ms の周期を1つ共有する（GPUI に窓が隠れているかを知る手段がなく、隠れている間も止めない） |
| `src/desktop.rs` | トレイ（tray-icon）と Alt+M（global-hotkey）。Windows だけ |
| `src/i18n.rs` | 日英の文言（`src/i18n/messages.ts` から写した分だけ） |

## 動かし方（Windows）

```powershell
cd src-tauri
cargo build --bin audio_engine
cd ..\prototypes\gpui-safety-column
cargo test
cargo run -- --plugin "<確認に使うVST>.vst3"
```

引数：`--plugin <VST3>`、`--lang en`、`--config-dir <フォルダ>`（既定は `%APPDATA%\com.kuro7983.auralynhost`）。

Tauri 版の Auralyn は閉じてから起動する。

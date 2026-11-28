# 機能から実装と検証を探す

画面は `src-gpui/`（GPUI Kit）。左のレールの行き先は `src-gpui/src/shell.rs` の `Page`（ホーム・音づくり・VST・接続・設定）。
画面は描くだけにし、振る舞いの規則は `crates/auralyn-ui-model/`、音声とエンジンの操作は `crates/vst-host/` に置く。エンジンの命令は `src-gpui/src/engine/` の専用のスレッドで受付順に実行する。

| 利用者の機能 | 行き先 | 画面（`src-gpui/src/`） | 規則（`crates/auralyn-ui-model/src/`） | 中核（`crates/vst-host/src/`） |
| --- | --- | --- | --- | --- |
| ホーム・開始停止・メーター・音の流れ | ホーム | `home.rs`、`view.rs`、`view/safety.rs`、`live.rs` | `meter.rs`、`flow.rs`、`session.rs` | `audio.rs`、`audio/` |
| 接続の確認（経路・送り先・履歴） | ホーム | `prep.rs`、`prep_file.rs` | `preparation.rs`、`diagnostics.rs` | `routing_diag.rs` |
| 接続・ASIO・周波数とバッファ・入力のペア | 接続 | `connect.rs`、`setup.rs`、`setups.rs`、`usage_file.rs` | `connect.rs`、`setup.rs`、`channel_signal.rs` | `audio_engine/devices.rs`、`audio_engine/channel_scan.rs` |
| 音づくり・ノイズ低減・ピーク保護・歌／雑談 | 音づくり | `sound.rs`、`limiter.rs`、`measure.rs`、`modes.rs` | `sound.rs`、`peak.rs`、`measurement.rs`、`live_modes.rs` | `audio_engine/`、`profile/` |
| VSTの追加・並び・音量・保存した構成 | VST | `vst.rs`、`vst_folders.rs`、`scan_file.rs`、`store.rs`、`recovery.rs` | `rack.rs`、`scan_folders.rs`、`profile.rs`、`recovery.rs` | `vst_host/`、`bundle/` |
| 配信ミックス・ミックス後の VST | 接続・VST | `mix.rs`、`post_mix.rs` | `mix.rs`、`post_mix.rs`、`music.rs`、`live_output.rs` | `audio_engine/mixing/` |
| ボイスチェック（録音・試聴） | 音づくり | `voice.rs` | `voice_check.rs` | `audio_engine/` |
| OBS連携・シーン | 設定 | `obs.rs`、`obs_link.rs`、`obs_changes.rs`、`obs_text.rs`、`obs_timing.rs`、`scenes.rs`、`scene_file.rs` | `obs.rs`、`obs_timing.rs`、`scene_routing.rs` | `obs.rs`、`obs_setup/`、`obs_credentials.rs` |
| 外観・言語・ショートカット・トレイ | 設定 | `settings.rs`、`theme_file.rs`、`locale_file.rs`、`desktop.rs`、`typeface.rs`、`color.rs` | `shortcuts.rs` | `desktop_integration.rs` |
| 使い方 | 設定 | `settings.rs` | `docs.rs`（`user-docs/`） | — |
| 日英の文言・色 | 全画面 | `i18n.rs`、`color.rs` | — | 文言は `crates/auralyn-core/locales/`、色は `crates/auralyn-core/tokens.json` |

規則は `cargo test -p auralyn-ui-model`、中核は `crates/vst-host` の `cargo test --locked --lib <対象名>`、まとめては `npm run verify -- --static --rust`。表は探す入口であり、そのファイルの試験の成功だけで機能全体を合格にしない。

## 実機が必要な境界

規則の試験とクラウドの型検査は、描画・フォーカス・狭い窓・日英・実音声を証明しない。画面は Windows の実機で [src-gpui/README.md](../src-gpui/README.md) の手順で確かめ、実機・聴感・ASIO/WASAPI・長時間運転は [TESTING](TESTING.md) の該当手順を使う。
音声開始・既定機器・OBSの設定変更を通常の検証CLIへ混ぜない。

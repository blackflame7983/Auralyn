# 機能から実装と検証を探す

AuralynはURLルーターではなく`src/hooks/useUIState.ts`の`AppPage`で画面を選ぶ。
開発プレビューは`npm run dev`後に`http://localhost:1420/?mock=stopped-home&screen=<名前>`で開く。`?screen=`は本番ルートではない。
利用できる状態・画面名の正本は`src/dev/previewScreen.ts`と[TESTING](TESTING.md#開発プレビューの模擬応答mock)。実行中の見た目には`mock=live-home`を使う。

| 利用者の機能 | AppPage／開発用screen | 主要コード | 検証入口 |
| --- | --- | --- | --- |
| ホーム・開始停止・緊急操作 | `home`／screenなし | `src/components/layout/AppShell.tsx`、`src/lib/startHomeAudio.ts` | `--feature home`、`home-actions.spec.ts`、`stopped-home.spec.ts` |
| 入出力メーター・波形 | `home` | `src/components/features/LevelMeter/`、`Home/SoundFlow.tsx`、`src/lib/model/meter.ts` | `--feature home`、`routing.property.test.ts` |
| 接続・ASIO・アプリの音声 | `connect`／`settings-audio` | `src/components/features/AudioSettings/`、`src/lib/audioChannelRouting.ts`、`src/api/audio.ts` | `--feature connection`、`asio-routing.spec.ts`、`process-input.spec.ts` |
| 初回セットアップ | 初回表示／通常UIから開く | `src/components/features/SetupWizard/`、`wizardModel.ts` | `--feature connection`、`setup-asio.spec.ts`、`setup-overflow.spec.ts` |
| 音づくり・保護・歌／雑談 | `sound`／`settings-sound` | `AudioSettings/`の各panel、`src/hooks/useLiveModes.ts`、`src-tauri/src/audio_engine/` | `--feature connection`、`safety-column.spec.ts`、関連Rust試験 |
| VSTの追加・順序・原音比較 | `vst`／`vst`、`plugin-browser` | `PluginRack/`、`PluginBrowser/`、`src/hooks/usePlugins.ts`、`src/lib/model/plugin.ts` | `--feature vst`、`vst-scan-folders.spec.ts`、`live-mode-vst.spec.ts` |
| 配信ミックス | `home`のパネル／`stream-mix` | `Home/StreamMixPanel.tsx`、`src/api/postMix.ts`、Rustの`audio_engine/mixing/` | `--feature home`、`mixing.spec.ts` |
| 録音・試聴・ボイスチェック | モーダル／`voice-check` | `VoiceCheck/`、`src-tauri/src/commands/voice_check.rs` | `--feature voice-check`、`voice-check-summary.spec.ts` |
| 保存・一時利用・復元 | モーダル／`presets` | `Presets/`、`Recovery/`、`src/lib/restorePluginSession.ts`、Rustの`profile/`・`bundle/` | `--feature restore`、`temporary-runtime.spec.ts`、`output-configuration.spec.ts` |
| OBS・外観・ショートカット・システム | `settings`／`settings-obs`、`settings-appearance`、`settings-shortcuts`、`settings-system` | `AudioSettings/`、`src/hooks/useUIState.ts` | `--feature connection`、settings系spec |
| 使い方・診断 | モーダル／`help`、`troubleshoot`、`obs-guide`、`discord-guide` | `Guide/`、`Troubleshoot/`、`user-docs/` | `how-to-use.spec.ts`、`npm run test:user-docs` |
| 日英・テーマ・窓幅・状態横断 | 全画面 | `src/i18n/`、`src/index.css`、レイアウト部品 | `screen-matrix.spec.ts`、`forced-colors-focus.spec.ts` |

表のfeature名は`npm run verify -- --feature <名前>`に渡す。ブラウザも確認するときは`--browser`を付ける。specの場所は`e2e/browser/`、機能フォルダーは特記しない限り`src/components/features/`である。
CLIが選択する試験の正本は`config/verification-features.json`。共有API・Context・設定の変更、複数機能に及ぶ変更は`--full`を使う。
指定specは開発中の案内であり、その成功だけで機能全体を合格にしない。

## 実機が必要な境界

ブラウザはIPCモックで、保存先・Rust・sidecarの動作を証明しない。
実保存・再起動・IPCは`npm run test:e2e:native`、実機・聴感・ASIO/WASAPI・長時間運転は[TESTING](TESTING.md)の該当手順を使う。
音声開始・既定機器・OBSの設定変更を通常の検証CLIへ混ぜない。

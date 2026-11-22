# F1b-0a-2 の前の洗い出し（今のコードの事実）

状態：調査（設計案ではない）。対象は main `189fee43`（F1b-0a-1 マージ済み）。#825 の次の段階 F1b-0a-2（C3：応答の期限で接続を切り離す、J-23：命令の種類ごとの応答の期限）を設計する前に、今のコードの事実だけを並べる。製品のコードと試験は変えていない。

前提の文書：`docs/plans/audio-session-f1b0a-design.md`（以下「設計」）、`docs/plans/audio-session-f1b0-changes.md`（C3、J-17・J-18）、`docs/plans/audio-session-controller.md` の 16.1（J-21〜J-24）。

読み方：
- 行番号は `189fee43` の時点。`ファイル:行` の省略形は `src-tauri/src/` を基準にする（例：`audio.rs:1089` は `src-tauri/src/audio.rs:1089`）。
- 「推測」と書いたものだけがコードで確かめていない記述。「未精読」は、その関数の本体を読んでいないという意味。
- 設計案は書かない。気づいたことは 6章にだけ書く。

## 1. 子の命令の全種類と、J-23 の分類の根拠

### 1.1 子の処理の流れ（応答を返すまで）

- 子の制御は1本のスレッド（winit のイベントループ）。stdin の読み取りスレッドは、行を JSON に直してイベントループへ送るだけ（`audio_engine/core.rs:601-629`、`:655-658`）。
- 命令の処理（`handle_command`、`audio_engine/core/commands.rs:5-1317`）は、同期で応答を `println!` と `flush` で書いて終わる（`audio_engine/core.rs:929-938`）。ほとんどの命令は、その処理の最後に応答を1件返す。
- 子には命令ごとの期限も、命令を途中で打ち切る仕組みもない。子が自分で出すのは、応答が長引いたことの診断の通知 `ControlStall` だけで、5秒と30秒で1回ずつ（`audio_engine/core/control_stall.rs:155-159`、イベントの送出 `:197-202`）。親はこの通知をログと `audio-control-stall` の通知にするだけで、応答の期限には使わない（`audio/reader.rs:66-86`）。
- `control_stall.rs:29-43` の `command_kinds!` は、全65命令を網羅して並べる既存の表（診断用）。命令を足すとコンパイルが通らなくなる仕組みの前例。

### 1.2 共通の前処理と後処理（命令の本体より前後に走るもの）

`handle_command` の本体（`commands.rs:252` の `match`）の前に、命令によっては次が走る。設計 6章が「共通の前処理で試聴を破棄しうる」と書いたのは、このうち P-h・P-i。

| 記号 | 内容 | 行 | 対象 | I/O・VST・ストリーム |
|---|---|---|---|---|
| P-a | ミックス後 VST の専用 Engine で許可されない命令を拒否 | `commands.rs:10-15`、`audio_engine/core/post_mix.rs:71-76` | 全命令 | なし |
| P-b | 開始の入力の検証、二入力の検証 | `commands.rs:28-35`、`audio_engine/core/input.rs:190-235`、`audio_engine/core/mixing.rs:133-` | 全命令（`Start` などだけが実質の対象） | なし |
| P-c | ノイズ低減のレートの検査 | `commands.rs:91-105` | `SetNoiseReduction`・`SetNoiseControlConfig` | 計算のみ |
| P-d | 保存セッションの復元を `RestorePlugin` に変換し、ラックの照合 | `commands.rs:107-129`、`audio_engine/core/session_rack.rs:4` | `RestoreSessionPlugin` | なし |
| P-e | ラックの世代を進める | `commands.rs:139-151` | `LoadPlugin`・`RestorePlugin`・`UnloadPlugin`・`ReorderPlugins` | なし |
| P-f | ノイズの履歴・測定の失効 | `commands.rs:172-188`、`audio_engine/core/noise_comparison.rs:59-65`、`audio_engine/core/noise_learning.rs:427-` | `Start`・`Stop`・`SetInputGain`・`SetInputChannels` | なし（読んだ範囲。`invalidate_noise_measurement` は一部だけ読んだ） |
| P-g | 準備の経路の世代を進める | `commands.rs:190-195` | `LiveOutput{Some}`・`SetGlobalMute` | なし |
| P-h | **試聴の候補の失効**：`voice_preview.invalidate_candidate()` が、動いている候補があれば `preview = None` にする（cpal のストリームを Drop） | `commands.rs:210-239`、`audio_engine/voice_check_preview.rs:776-783` | `Start`・`Stop`・`LoadPlugin`・`RestorePlugin`・`UnloadPlugin`・`ReorderPlugins`・`SetBypass`・`SetMute`・`SetGain`・`ResumePlugin`・`SetPluginState`・`SetGlobalBypass`・`SetInputGain`・`SetInputChannels`・`SetNoiseReduction`・`SetNoiseControlConfig`・`StartNoiseLearning`・`CancelNoiseLearning`・`SetBuiltInEffects`（19命令） | 条件付き（試聴が動いているときだけ）。ストリームの Drop |
| P-i | **音量調整の失効**：`invalidate_auto_gain_for_command` が、下の除外表にない命令で `invalidate_auto_gain_with_reason` を呼び、`gain_preview = None`（cpal のストリームを Drop） | `commands.rs:240`、`audio_engine/core/auto_gain_commands.rs:6-57`（除外表 `:7-46`）、`:91-109`（`:101` が `gain_preview = None`）、`audio_engine/auto_gain_preview.rs:10-15` | 除外表にない全命令（1.3 の表の「P-i」列） | 条件付き（音量調整の試聴が動いているときだけ）。ストリームの Drop |
| P-j | **後処理**：`latency_may_change` の命令の後に `sync_mixing_latency` → `latency_report` → 各 VST の `get_latency_samples` | `commands.rs:16-27`、`:1312-1316`、`audio_engine/core/mixing.rs:108-132`、`audio_engine/plugins.rs:453-471`、`vst_host/instance.rs:2396-2405` | `LoadPlugin`・`RestorePlugin`・`RestoreSessionPlugin`・`UnloadPlugin`・`ReorderPlugins`・`SetBypass`・`SetGlobalBypass`・`SetNoiseReduction`・`SetNoiseControlConfig` | 条件付き（二入力の設定 `mixing_shared` があるときだけ。`mixing.rs:109-111`）。VST の呼び出し |

P-i の除外表（呼んでも失効させない命令）：`PeakProtection{None}`・`BroadcastTruePeak{None}`・`LiveOutput{None}`・`LiveMode`（全部）・`ModeSilence`・`ModeMonitor`・`ConfigureLiveModes`・`GetDevices`・`StartIdentityCapability`・`ProcessInputCapability`・`BeginDeviceScan`・`PollDeviceScan`・`CancelDeviceScan`・`GetRuntimeStats`・`NoiseMeasurement{Snapshot}`・`GetFrameTimingTrace`・`GetPluginState`・`CaptureBundleState`・`CaptureMixingBundleState`・`ProcessingState`・`PostMixStatus`・`Mixing{Snapshot}`・`GetPluginRack`・`AutoGain`（全部）・`SetOutputGain`・`SetLoudnessMeasurement`・`SetChannelScan`・`StopVoiceCheckPlayback`・`StopVoiceCheckRecording`・`VoiceCheckPreview`（全部）・`BuiltinEffects{Snapshot}`（`auto_gain_commands.rs:7-46`）。

ストリームの Drop が待つかどうか：試聴の2つのストリームは WASAPI 固定（`audio_engine/auto_gain_preview.rs:17-19`、`audio_engine/voice_check_preview.rs:681`）。同梱の cpal 0.17.3 の WASAPI は、`Stream::drop` がスレッドへ終了を伝えて `join` する（`third_party/cpal-0.17.3/src/host/wasapi/stream.rs:178-189`）。つまり試聴のストリームの Drop は、別スレッドの終了を同期で待つ。実際にかかる時間は測っていない。ASIO のストリームの Drop は読んでいない。

### 1.3 全65命令の表

`ipc.rs:480-694` の `Command` は65バリアント（数えた結果。`control_stall.rs:29-43` の網羅の表と同じ並び）。

列の読み方：
- 「子の同期処理」：その命令の本体（`commands.rs` の行）が応答までに同期で行うこと。VST の呼び出し、ストリームの作成と破棄、共有メモリ、ファイル I/O、`sleep`、`join` があれば書く。
- 「前処理」：1.2 の記号。P-h・P-i は条件付き。
- 「6章」：設計 6章の分類。表にない命令は A（設計は A を「残り全部」として扱っているため）。
- 「当てはめ」：設計 6章の基準（命令の処理の中、共通の前処理を含めて、VST の呼び出し・音声機器のストリームの作成と破棄・共有メモリ・ファイル I/O のどれかを同期で行う）を、読んだ範囲でそのまま当てはめた結果。`B常時` は本体で必ず行う。`B条件` は前処理・後処理でだけ、しかも条件付き。
- 「印」：★ は、6章では A だが、設計が B にした `SetInputGain`・`SetGlobalMute`・`SetOutputGain` と同じ理由（P-h・P-i の条件付きの試聴の破棄）で `B条件` に当たるもの。☆ は本体が未精読。

| # | 命令 | 子の同期処理（`commands.rs` の行ほか） | 前処理 | 6章 | 当てはめ | 印 |
|---|---|---|---|---|---|---|
| 1 | `ProcessingState` | atomics の読み取りだけ（`:266-269`） | なし | A | A | |
| 2 | `CaptureMixingBundleState` | `capture_bundle_state`（`:1218-1223`）。各 VST の `get_state`（`audio_engine/core/bundle_capture.rs:120`）、前提の確認 `:85` | なし（除外表） | B | B常時（VST） | |
| 3 | `PostMixPrepare` | `prepare_post_mix`（`:270-273`、`audio_engine/core/post_mix.rs:78-91`）。`Mapping::create`＝`CreateFileMappingW`（`audio_engine/post_mix/transport.rs:213`） | P-i | B | B常時（共有メモリの作成） | |
| 4 | `PostMixClear` | 停止中なら `post_mapping = None`（`:274-281`）。最後の参照の Drop が `UnmapViewOfFile`・`CloseHandle`（`transport.rs:157-166`） | P-i | B | B常時（共有メモリの解放） | |
| 5 | `PostMixStatus` | マッピングの読み取りだけ（`:253-265`） | なし（除外表） | A | A | |
| 6 | `PostMixStart` | `start_post_mix`（`:282-285`、`core/post_mix.rs:92-215`）。`Mapping::open`×2（`:102-103`、`transport.rs:255`）、`prepare_for_audio_start`（VST、`:110-112`）、`declared_latency_samples`（VST、`:121`）、スレッド生成（`:141-210`） | P-i | B | B常時 | |
| 7 | `Mixing` | `mixing_command`（`:286-289`、`core/mixing.rs:47-107`）。メモリと atomics だけ | `Snapshot` は除外、`Configure`・`Levels` は P-i | A | A（`Snapshot`）、B条件（`Configure`・`Levels`） | ★ |
| 8 | `ModeMonitor` | `mode_monitor_command`（`:290-293`、`audio_engine/core.rs:1690-1754`）。`Restore` は `split_monitor.restore`→係数の準備（`audio_engine/split_monitor.rs:406-431`、割り当て） | なし（除外表） | A | A | |
| 9 | `ModeSilence` | `mode_silence.request`（`:294-323`、`audio_engine/mode_silence.rs:126-`）。読んだ範囲に I/O・`sleep`・`join` なし（スレッドの使用は `cfg(test)` の中だけ。`:235-`） | なし（除外表） | A | A | ☆ |
| 10 | `LiveOutput` | `config` が `None` なら読み取りだけ。`Some` ならメモリ・atomics（`sink.update`＝`audio_engine/live_output.rs:469-471`）（`:391-446`） | `None` は除外、`Some` は P-g・P-i | A | A（`None`）、B条件（`Some`） | ★ |
| 11 | `GetPluginRack` | `session_rack_snapshot`（`:1224`、`audio_engine/core/session_rack.rs:11-`）。VST インスタンスのフィールドの読み取り | なし（除外表） | A | A | |
| 12 | `RestoreSessionPlugin` | `RestorePlugin` に変換して同じ処理（`:107-129`） | P-d・P-e・P-h・P-i・P-j | B | B常時 | |
| 13 | `GetDevices` | キャッシュの複製だけ。キャッシュがなければエラー（`:540-546`、`audio_engine/devices.rs:116-122`） | なし（除外表） | A | A | 設計の注記と一致 |
| 14 | `LiveMode` | 要求の検査と `poll_live_modes`（`:477-531`）。`SingingOn`・`TalkOn` は `select_live_mode`（`audio_engine/core.rs:1770-1786`）で、モードが変わると `invalidate_auto_gain()` と `voice_preview.invalidate_candidate()` を呼ぶ（`:1776`・`:1782`） | 除外表だが、本体の中で P-h・P-i と同じ失効を呼ぶ | A | A、`SingingOn`・`TalkOn` はB条件 | ★ |
| 15 | `ConfigureLiveModes` | `live_modes.configure`（`:532-539`） | なし（除外表） | A | A（読んだ範囲） | ☆ |
| 16 | `BeginDeviceScan` | 子プロセス `--scan` を別スレッドで走らせる登録だけ。終了済みの旧 worker の `join` は `is_finished` を確かめた後だけ（`:465-468`、`audio_engine/devices.rs:124-179`、`:145-156`） | なし（除外表） | A | A | |
| 17 | `PollDeviceScan` | 終わった worker の `join`（`devices.rs:181-238`、`:190-199`）。待たない | なし（除外表） | A | A | |
| 18 | `CancelDeviceScan` | フラグを立てるだけ（`:473-476`、`devices.rs:240-252`） | なし（除外表） | A | A | |
| 19 | `StartIdentityCapability` | 定数の応答（`:324-326`） | なし（除外表） | A | A | |
| 20 | `ProcessInputCapability` | 定数の応答（`:327-329`） | なし（除外表） | A | A | |
| 21 | `AutoGain` | `auto_gain_command`（`:461-464`、`audio_engine/core/auto_gain_commands.rs:238-`）。機器の列挙 `auto_gain_preview::devices()`（`:249`）、試聴の出力ストリームの作成 `Preview::start`（`:386-392`、`auto_gain_preview.rs:166`）、`Cancel` の `gain_preview = None`（`:255`） | なし（除外表） | B | B常時（ストリームの作成・破棄、機器の列挙） | |
| 22 | `Start` | `start_audio_impl`（`:547-625`、`audio_engine/core.rs:1323-1335`、`audio_engine/core/startup.rs:361-`）。既存のストリームがあれば `fade_before_stop`（≤100 ms の `sleep`）と `clear_audio_resources`（`startup.rs:418-423`）、機器の解決（`:451`）、ストリームの作成（`audio_engine/core/native_stream.rs:111-172`）、入力の到着待ち `wait_for_input`（最大1秒、1 ms ごとの `sleep`。`audio_engine/core/lifecycle.rs:258-281`、`startup.rs:2236`）、VST の `prepare_processing`（`audio_engine/plugins.rs:272`・`:392`）、アプリ入力は開始待ち最大6秒（`audio_engine/process_capture/mod.rs:335`）、再試行は入力・出力で各1回（`lifecycle.rs:26-57`）。`initial_controls` があれば先に `stop_audio`（`audio_engine/core/bundle_capture.rs:23-30`） | P-f・P-h・P-i | B | B常時。1試行の長さの上限は、1.2 で挙げた各待ちの合算を超えて確かめていない | |
| 23 | `Stop` | `stop_audio`（`:626-629`、`core.rs:1421-1424`）。`fade_before_stop`（最大100 ms、1 ms ごとの `sleep`。`audio_engine/stop_fade.rs:12`・`:34-47`）、`clear_audio_resources`（`core.rs:1996-2109`）：ストリームの Drop、`post_worker` などの `join`（`core/post_mix.rs:21-31`、`split_monitor.rs:839-846`）、返却された VST の解放（`on_processor_retired`、`:2071-2079`） | P-f・P-h・P-i | B | B常時 | |
| 24 | `LoadPlugin` | `plugin_manager.load_plugin`（VST のロード、`:630-691`）、`latency_samples_at`（VST、`:658`）。遅延接続は応答の後（`core.rs:734-765`） | P-e・P-h・P-i・P-j | B | B常時 | |
| 25 | `RestorePlugin` | `StagedRestore::load`（VST のロードと `set_state`、`:692-715`、`audio_engine/restoration.rs:36-79`）。遅延接続が要るなら応答は次のターン（`:709-711`、`core.rs:723-732`、`finish_plugin_restore`＝`core.rs:1907-1976`）。**子の側に、`expires_at_ms` までの予算が0より大きく10秒以下の要求だけを受ける検査と、段ごとの期限の検査がある**（`restoration.rs:51-55`、`:68`・`:77`・`:93`・`:108`・`:114`）。Host は常に「今＋8秒」を渡す（`audio.rs:1776`、`audio/post_mix.rs:504`、`audio/mode_vst.rs:942`、`audio/session_rack.rs:254`） | P-e・P-h・P-i・P-j | B | B常時 | |
| 26 | `UnloadPlugin` | エディタの切断、`remove_plugin`／`begin_unload`（VST の解放、`:716-740`） | P-e・P-h・P-i・P-j | B | B常時 | |
| 27 | `ReorderPlugins` | `reorder_plugins`（メモリ、`audio_engine/plugins.rs:215-228`）、`make_reorder_message`（`core.rs:1140-1155`）（`:741-747`） | P-e・P-h・P-i・P-j（後処理は二入力のときだけ） | A | A、B条件（P-h・P-i、P-j） | ★ |
| 28 | `OpenEditor` | `editor_manager.open_editor(instance, target)`（VST のビューとウィンドウ、`:748-760`）。応答の前にイベント `EditorOpened` を出す（`:753`） | P-i | B | B常時 | |
| 29 | `SetBypass` | `latency_samples_at`（VST の `get_latency_samples`、`:771-775`、`plugins.rs:205-213`）。必ず呼ぶ | P-h・P-i・P-j | B | B常時 | |
| 30 | `SetMute` | メモリと RT の列への投入（`:778-790`） | P-h・P-i | A | A、B条件 | ★ |
| 31 | `SetGain` | 同上（`:791-799`） | P-h・P-i | A | A、B条件 | ★ |
| 32 | `ResumePlugin` | 同上（`:800-815`） | P-h・P-i | A | A、B条件 | ★ |
| 33 | `SetGlobalMute` | `set_global_mute_intent`（atomics と RT の列、`core.rs:1472-1480`）（`:816-822`） | P-g・P-i | B | B条件のみ（本体は A） | 設計が前処理を根拠に B にした |
| 34 | `SetInputGain` | メモリと RT の列（`:828-836`） | P-f・P-h・P-i | B | B条件のみ（本体は A） | 同上 |
| 35 | `SetNoiseReduction` | `apply_noise_intent`（メモリと RT の列、`core.rs:1498-1527`）（`:837-858`） | P-c・P-h・P-i・P-j | A | A、B条件 | ★ |
| 36 | `StartNoiseLearning` | `begin_noise_learning`（`:859-864`、`core/noise_learning.rs:455-`。読んだ範囲に I/O なし） | P-h・P-i | A | A、B条件 | ★ ☆ |
| 37 | `CancelNoiseLearning` | メモリと RT の列（`:873-881`） | P-h・P-i | A | A、B条件 | ★ |
| 38 | `PeakProtection` | `config` が `None` なら読み取り。`Some` ならメモリと atomics（`:330-360`） | `None` は除外、`Some` は P-i | A | A（`None`）、B条件（`Some`） | ★ |
| 39 | `BroadcastTruePeak` | 同上（`:361-390`） | `None` は除外、`Some` は P-i | A | 同上 | ★ |
| 40 | `NoiseMeasurement` | `noise_measurement_request`（`:865-872`、`core/noise_learning.rs:617-`） | `Snapshot` は除外、他は P-i | A | A（`Snapshot`）、B条件（他） | ★ ☆ |
| 41 | `SetNoiseControlConfig` | `apply_noise_intent`（`:882-907`） | P-c・P-h・P-i・P-j | A | A、B条件 | ★ |
| 42 | `SetBuiltInEffects` | `legacy_builtin`・`publish_builtin`（`:908-934`、`core.rs`） | P-h・P-i | A | A、B条件 | ★ ☆ |
| 43 | `BuiltinEffects` | `builtin_command`（`:935-938`、`core.rs:990-`） | `Snapshot` は除外、他は P-i | A | A（`Snapshot`）、B条件（他） | ★ ☆ |
| 44 | `SetLoudnessMeasurement` | RT の列への投入（`:939-952`） | なし（除外表） | A | A | |
| 45 | `SetOutputGain` | `request_output_gain`（`:953-956`、`auto_gain_commands.rs:59-77`）。本体の中で `invalidate_auto_gain_with_reason`（`:63`→`:101` の `gain_preview = None`） | 除外表だが、本体の中で P-i と同じ失効 | B | B条件のみ（本体は A） | 設計が根拠にした |
| 46 | `SetGlobalBypass` | RT の列への投入（`:823-826`） | P-h・P-i・P-j | A | A、B条件 | ★ |
| 47 | `SetInputChannels` | `requested_channels`・`validate_output_for_input`（計算のみ、`:957-981`、`audio_engine/core/bundle_capture.rs:10-22`） | P-f・P-h・P-i | A | A、B条件 | ★ |
| 48 | `SetChannelScan` | atomics（`:982-985`） | なし（除外表） | A | A | |
| 49 | `GetRuntimeStats` | `sync_mixing_latency`（`:1131`）、`latency_report`（`:1139`）＝各 VST の `get_latency_samples`。応答の組み立て（`:1130-1217`） | なし（除外表） | B | B常時（VST の getter） | |
| 50 | `GetFrameTimingTrace` | `frame_timing_trace`（`:447-452`）。未精読。Host は `ensure_engine_running` を通さず `execute_running_command_inner` を直接呼ぶ（`audio.rs:1014-1016`） | なし（除外表） | A | A | ☆ |
| 51 | `GetPluginState` | VST の `get_state`（`:1226-1232`） | なし（除外表） | B | B常時 | |
| 52 | `CaptureBundleState` | 2 と同じ（`:1218-1223`） | なし（除外表） | B | B常時 | |
| 53 | `SetPluginState` | 停止中のみ VST の `set_state`（`:1233-1246`） | P-h・P-i | B | B常時 | |
| 54 | `StartVoiceCheckRecording` | `voice_preview.interrupt(false)`（試聴のストリームの破棄、`:1000`）、最大30秒分の録音バッファの確保（`:1057-1063`、`audio_engine/voice_check.rs:15`、`audio_engine/voice_check/buffers.rs:142`） | P-i | B | B常時（ストリームの破棄） | |
| 55 | `StopVoiceCheckRecording` | RT の列への投入（`:1085-1090`） | なし（除外表） | A | A | |
| 56 | `PlayVoiceCheck` | RT の列への投入（`:1091-1109`） | P-i | A | A、B条件 | ★ |
| 57 | `StopVoiceCheckPlayback` | RT の列への投入（`:1110-1115`） | なし（除外表） | A | A | |
| 58 | `VoiceCheckPreview` | `noise_voice_preview_command`（`:453-460`、`audio_engine/core/noise_comparison.rs:199-`）。機器の列挙（`voice_check_preview.rs:1217`）、試聴の出力ストリームの作成（`:688`、`:1223-`） | なし（除外表） | B | B常時 | |
| 59 | `ExportVoiceCheck` | WAV の書き出し＝ファイル I/O（`:1116-1129`、`audio_engine/voice_check.rs:153`） | P-i | B | B常時 | |
| 60 | `PlayTestTone` | RT の列への投入（`:1247-1268`） | P-i | A | A、B条件 | ★ |
| 61 | `StopTestTone` | RT の列への投入（`:1269-1273`） | P-i | A | A、B条件 | ★ |
| 62 | `ProbeLoopback` | 停止中・ASIO は即応答（`audio_engine/core.rs:1081-1104`）。それ以外は `sleep(80 ms)`（`:1114`）、`capture_input_mono`：入力ストリームの作成（`audio_engine/loopback_probe.rs:31`）・`play`（`:54`）・`sleep(duration_ms + 100 ms)`（`:58-59`）・`drop`（`:62`）（`:1298-1309`）。**`duration_ms` に上限がない**：Host の既定は1500（`commands/audio.rs:1202`）、子は音の長さだけを5000 ms に切る（`core.rs:1106`）。録音の `sleep` は切らない | P-i | C | C（ストリームの作成・破棄、`sleep`） | |
| 63 | `MeasureRoundTrip` | `round_trip.start`（状態機械の開始、`:1274-1286`、`audio_engine/latency_measure.rs:952`） | P-i | A | A、B条件 | ★ |
| 64 | `CancelMeasurement` | `round_trip.cancel`（`:1287-1292`） | P-i | A | A、B条件 | ★ |
| 65 | `GetRoundTripMeasurement` | `round_trip.poll`（`:1293-1297`） | P-i | A | A、B条件 | ★ |

### 1.4 内訳と、設計 6章との食い違い

件数（65命令）：

| 区分 | 件数 | 命令 |
|---|---|---|
| 設計 6章の B | 23 | `SetBypass`・`GetRuntimeStats`・`StartVoiceCheckRecording`・`PostMixPrepare`・`PostMixClear`・`LoadPlugin`・`RestorePlugin`・`RestoreSessionPlugin`・`GetPluginState`・`SetPluginState`・`CaptureBundleState`・`CaptureMixingBundleState`・`OpenEditor`・`UnloadPlugin`・`PostMixStart`・`Start`・`Stop`・`SetInputGain`・`SetGlobalMute`・`SetOutputGain`・`AutoGain`・`VoiceCheckPreview`・`ExportVoiceCheck` |
| 設計 6章の C | 1 | `ProbeLoopback` |
| 設計 6章の A（表にない命令を残り全部として） | 41 | 残り |
| 当てはめ：B常時 | 20 | #2・3・4・6・12・21〜26・28・29・49・51〜54・58・59 |
| 当てはめ：B条件のみ（6章でも B） | 3 | `SetGlobalMute`・`SetInputGain`・`SetOutputGain` |
| 当てはめ：C | 1 | `ProbeLoopback` |
| 当てはめ：A | 17 | `ProcessingState`・`PostMixStatus`・`ModeMonitor`・`ModeSilence`・`GetPluginRack`・`GetDevices`・`ConfigureLiveModes`・`BeginDeviceScan`・`PollDeviceScan`・`CancelDeviceScan`・`StartIdentityCapability`・`ProcessInputCapability`・`SetLoudnessMeasurement`・`SetChannelScan`・`GetFrameTimingTrace`・`StopVoiceCheckRecording`・`StopVoiceCheckPlayback` |
| 印★：6章は A、当てはめは B条件 | 24 | `Mixing`・`LiveOutput`・`LiveMode`・`ReorderPlugins`・`SetMute`・`SetGain`・`ResumePlugin`・`SetNoiseReduction`・`StartNoiseLearning`・`CancelNoiseLearning`・`PeakProtection`・`BroadcastTruePeak`・`NoiseMeasurement`・`SetNoiseControlConfig`・`SetBuiltInEffects`・`BuiltinEffects`・`SetGlobalBypass`・`SetInputChannels`・`PlayVoiceCheck`・`PlayTestTone`・`StopTestTone`・`MeasureRoundTrip`・`CancelMeasurement`・`GetRoundTripMeasurement` |

20＋3＋1＋17＋24＝65。

6章の表と食い違うもの：

1. **前処理の範囲（24命令）**。6章は「共通の前処理で試聴を破棄しうる」命令として `SetInputGain`・`SetGlobalMute`・`SetOutputGain` の3つだけを B にした。しかし P-h と P-i（1.2）は、この3つ以外の24命令（上の★）にも同じ条件で走る。したがって、6章の基準を前処理まで含めて当てはめると、★の24命令は `SetInputGain` と同じ種類（B条件）になる。B条件の命令を A にした根拠も B にした根拠も、6章には書かれていない。`SetGlobalMute`・`SetInputGain` の P-h・P-i（`SetGlobalMute` は P-i と P-g）と `SetOutputGain` の本体（`auto_gain_commands.rs:63`）は、今回の読みと一致する。
2. **後処理の VST の呼び出し（P-j）**。`ReorderPlugins`・`SetGlobalBypass`・`SetNoiseReduction`・`SetNoiseControlConfig` は、二入力の設定があるとき、応答の前に各 VST の `get_latency_samples` を呼ぶ。6章は A。`SetBypass` を B にした根拠はこの種類の呼び出しだが、`SetBypass` は本体が必ず呼ぶ点で違う。
3. **`RestorePlugin`・`RestoreSessionPlugin` の B（30秒）**。子の側に「予算が10秒以下の要求だけを受ける」検査（`restoration.rs:51-55`）と段ごとの期限の検査（`:68`・`:77`・`:93`・`:108`・`:114`）があり、Host の呼び出しはすべて「今＋8秒」を渡す（1.3 の #25）。30秒の期限を置いても、段の間で期限を検査する範囲では8秒を超えると子が `VST復元要求の期限が切れました` のエラーを返す。ただし各段の中（VST のロード・`set_state`・`prepare_processing`）は途中で打ち切れないので、その1段の長さまでは超えうる（推測）。
4. **`ProbeLoopback` の「録音の時間を最大10秒に制限する」**。制限はまだどこにもない（1.3 の #62）。
5. **`Start` の30秒の根拠**。Start が1回の命令で使いうる時間（試行3回、各回の機器の解決・ストリームの作成・入力の到着待ち・VST の準備、アプリ入力の6秒）の上限は、コードからは1つの値にならない。J-8 の実測は、この調査では行っていない。
6. 設計の注記と一致するもの：`GetDevices` が A（キャッシュ。`devices.rs:116-122`）、`PollDeviceScan`・`BeginDeviceScan`・`CancelDeviceScan` が A、`PostMixStatus` が A。

### 1.5 応答を返さない命令・複数の応答・遅れる応答

- **応答を返さない場合**：どの命令にも「応答しない」という分岐はない（`handle_command` の全アームを読んだ。早期の `return` はすべて `send_error` か `send_response` の後。`commands.rs:10-15`・`:28-35` ほか）。例外は **JSON の解析に失敗した行**で、子は `log::error!` だけを書いて応答を返さない（`audio_engine/core.rs:621`）。親は応答を待って期限まで待つ。同じバイナリなので通常は起きない（推測）。
- **応答が遅れる命令**：`RestorePlugin`・`RestoreSessionPlugin` は、`needs_deferred_connection` なら応答を保留して `pending_restore` に置き（`commands.rs:709-711`）、イベントループの次の `AboutToWait`（最大約8 ms 後、`core.rs:650-652`）で `finish_plugin_restore` が応答する（`core.rs:723-732`、`:1907-1976`）。その間に音声の停止や開始が起きて `clear_audio_resources` が走ると、`pending_restore` を捨てて、`send_error("音声条件が変わったためVST復元を中断しました")` を**その時点の応答として**送る（`core.rs:2006-2008`）。`LoadPlugin` は応答を先に返し、遅延接続の失敗は応答ではなくイベント `Error` と音声の停止で伝える（`core.rs:734-765`）。
- **1つの命令に応答が2件になりうる場合**：上の `pending_restore` が残っている間に別の命令（`Stop` や `Start`）が `clear_audio_resources` を走らせると、中断のエラー応答（復元の分）と、その命令自身の応答の2件になる（`core.rs:2006-2008` と `commands.rs:626-629`）。今の親は直列で、応答待ちの間は次の命令を送らない（`replies.rs:37-40`）ので、この組み合わせは起きない。内部で `stop_audio_immediately` が走る経路（`core.rs:691`・`:695`・`:761`）は、復元の応答を解放する側に回るだけ（推測：復元の応答待ちがあるときのみ）。
- **イベントと応答の併発**：`Start`・`Stop`・`OpenEditor`・`UnloadPlugin` は、応答とは別にイベント（`Stopped`・`EditorOpened`・`EditorClosed` など）も送る（`core.rs:1354-1360`、`commands.rs:722`・`:753`）。応答は1件。
- **応答の対応付け**：応答に要求 ID も種類もない。親は届いた順に待ち手へ渡し、種類は照合しない（`audio/replies.rs:1`・`:50`、`audio/reader.rs:44-47`）。

## 2. 親が応答を待つ全箇所

`ReplySlot::begin` を呼ぶのは2か所だけ：`audio.rs:1069`（同期）と `audio/mode_vst.rs:688`（モード VST。テスト以外）。応答の待ちの実装は、`await_reply`（`audio.rs:1089-1131`）と、モード VST の `poll_mode_vst`（`audio/mode_vst.rs:517-682`）の2本。

共通の事実：同期の呼び出しは、`Mutex<AudioHost>` を持ったまま待つ（`audio/control.rs:174`・`:221-252`）。待っている間、停止・トレイ・ショートカット・状態の読み取りは、ロックの取得で待つ（モード VST の10 ms ごとの更新も、同じロックを取る。`control.rs:231-240`）。

### 2.1 一覧

| # | 待ちの箇所 | 入口 | 実装 | 待つ命令 |
|---|---|---|---|---|
| W1 | 通常の同期 | `execute_running_command_inner`（`audio.rs:1060-1073`）。`execute_command`（`:999-1039`）・`execute_command_if_running`（`audio/engine_exit.rs:214-236`）・`post_mix_stopped`（`audio/post_mix.rs:961-975`）ほか、`execute_command(`・`execute_running_command(` などの呼び出しと定義は `audio.rs` にあわせて78か所（テスト以外のパターン合計） | `await_reply`（`audio.rs:1089-1131`） | 全命令（`GetFrameTimingTrace` は `execute_command` が `ensure_engine_running` を通さずに直接呼ぶ。`:1014-1016`） |
| W2 | モード VST | `poll_mode_vst`（10 ms ごと。`control.rs:231-240`） | `mode_vst.rs:535-602` と `send_mode_command`（`:687-711`） | `ConfigureLiveModes`・`LiveMode`・`GetPluginRack`・`GetPluginState`・`BuiltinEffects`・`ModeSilence`・`UnloadPlugin`・`RestorePlugin`・`ModeMonitor`・`LiveOutput`（`mode_vst.rs:902-1007`） |
| W3 | 起動の確認（J-24） | `ensure_engine_running`（`audio.rs:945-971`） | W1 と同じ `await_reply`。`confirming_start` を立てる（`:951-953`） | `StartIdentityCapability`（A） |
| W4 | 配信ミックスの子 | `post_mix::State::exec_child`（`audio/post_mix.rs:429-456`） | 子の `AudioHost` の `execute_running_command`＝W1 | `GetPluginRack`・`LoadPlugin`・`UnloadPlugin`・`ReorderPlugins`・`SetBypass`・`SetMute`・`SetGain`・`OpenEditor`・`RestorePlugin`・`PostMixStart`・`Stop`・`ProcessingState`・`GetPluginState`（保存のためのラックの前後の確認を含む。`post_mix.rs:494`・`:552`・`:584`・`:637`・`:647`・`:666`・`:821`・`:861`・`:891`・`:1052-1090` ほか） |
| W5 | 書き込みの完了 | `await_reply` の前半（`audio.rs:1095`）、モード VST の `WriteDone`（`mode_vst.rs:537-567`） | W1・W2 の一部 | 全命令 |

「応答を待つ別の機構」はない。2本の実装に、起動の確認と配信ミックスが乗る形。

### 2.2 W1：通常の同期

- **起点**：`execute_running_command_inner`（`audio.rs:1060-1073`）。順に、接続が開いているか（`:1062`）→ JSON 化（`:1063`）→ `ReplySlot::begin`（`:1069`）→ `vst_operations.begin`（`:1070`）→ writer へ `submit`（`:1071`）→ `await_reply`（`:1072`）。`begin` が失敗すると、書き込みへ進まない（命令は子に送られない）。
- **期限の値**：書き込みの完了を最大5秒（`writer.rs:13`、`audio.rs:1095`）。応答は10秒（`writer.rs:15`、`audio.rs:1111`）。どちらも全命令で同じ値で、`reply_limit()`・`write_limit()` は引数を取らない（`writer.rs:23-37`）。試験の継ぎ目は、スレッドごとに1組の値を差し替えるだけ（`writer.rs:17-46`）。
- **期限の起点**：書き込みの5秒は、`submit` の直後から数える（キューに入ってからの待ちを含む。キューの容量は1、`writer.rs:147`）。応答の10秒は、書き込み・`flush` が戻った時刻 `flushed_at` から数える（`audio.rs:1111`）。
- **`flushed_at` の使い方**：`WriteResult::Ok` のときだけ使い、`(flushed_at + 10秒) - 今` を `recv_timeout` に渡す（`audio.rs:1109-1112`）。すでに過ぎていれば0（`saturating_duration_since`）。`Aborted`（接続が閉じていたので書かなかった）のときは `flushed_at` を使わず、今から10秒（`:1113`）。`Err` のときは応答を待たず切り離す（`:1114-1116`）。`flushed_at` を使う箇所はここだけ（`writer.rs:62-66`・`:207-210`、`audio.rs:1111`）。
- **書き込みの期限切れ・失敗**：`cut_off`（`audio.rs:1134-1155`）へ進む（4章）。`Timeout`・`Disconnected` は書き込みの期限切れと失敗（`:1097-1107`）。
- **応答の期限切れ（受け側が `Timeout`）**：`vst_operations.timeout()`（`audio.rs:1125`）を呼び、`Err(anyhow!("Timeout or disconnect waiting for engine response: {error}"))` を返す（`:1124-1128`）。`{error}` は `RecvTimeoutError::Timeout` の表示（`timed out waiting on channel operation`。`docs/plans/audio-session-compat-contract.md:55`）。`IpcResponse::Error` ではなく `Err`。接続・`ReplySlot`・子には触れない（3章）。
- **文言**：`await_reply` の `Err` は、入口によって `localize_audio_error`（`audio.rs:3025-`）で包まれる。`start_audio` は `オーディオエラーが発生しました。\n\n詳細: Timeout or disconnect waiting for engine response…`（`commands/audio/compat_tests.rs:650`）。
- **EOF・切断で解放されたとき**：`ReplyOutcome::Eof` または `Disconnected` は `IpcResponse::Error("Engine Crashed/Exited")`（`audio.rs:1121-1123`、`audio.rs:37`）。
- **呼び出しの外側**：`execute_running_command` は `Conditions::dispatch` の中で `execute_running_command_inner` を呼ぶ。`Err` のとき `lifecycle(false)` と `audio-conditions-changed` の通知を出す（`audio.rs:1042-1050`、`audio/conditions.rs:103-122`）。
- **遅れて届いた応答**：期限切れの後も、`ReplySlot` は `Waiting` のまま残る（`replies.rs:19`、`audio.rs:1124-1129` は `cancel` を呼ばない）。reader が応答を読むと `operations.response` を呼び、`deliver` が `Waiting` を `Idle` に戻して、すでに捨てられた受け側へ送る（失敗は無視。`reader.rs:44-47`、`replies.rs:51-64`）。応答の中身は捨てる。ただし `operations.response` は、遅れた `PluginLoaded`・`PluginRestored` の ID を登録し（`engine_exit.rs:132-167`）、遅れた `Started` は「機器を開いた直後」の記録を作る（`:138-147`）。

### 2.3 W2：モード VST の tick

- **起点**：`send_mode_command`（`mode_vst.rs:687-711`）が `begin` → `submit`（`Payload::Command`、JSON 化は writer のスレッド）し、`Pending { receiver, writer, sent: Instant::now() }`（`:706-710`）。`sent` は `submit` の後。`vst_operations.begin` は呼ばない（`audio.rs:1070` との違い）。
- **期限の値と起点**：1つの10秒（`:556`・`:593`）を、書き込みの結果と応答の両方に使う。起点は `sent`。`flushed_at` は使わない（`WriteDone` を `..` で受ける。`:539-551`）。書き込みの5秒は使わない。遷移全体は、`tx.started` から120秒（`:531`。ロールバックの開始で振り直す。`:830`）。命令ごとの期限はない。
- **判定の順**：世代違い（`:523`）→ 120秒（`:531`）→ 書き込みの結果（`Ok`・`Aborted` は続行、`Err` は失敗、書き込み待ちで10秒超は `VST切替の送信結果が不明です`。`:537-567`）→ 応答の受け側（`Response` は接続の喪失を先に確かめてから `mode_step_response`、`Eof`・`Disconnected` は `Engine Crashed/Exited`、10秒超は `VST切替の応答が不明です`。`:569-601`）→ 次の段の前にも接続の喪失（`:604-624`）。
- **`flushed_at` の使い方**：なし。
- **期限切れの後**：`fail_mode_transaction(tx, 文言, ambiguous = true)`（`:564`・`:599`、`:816-848`）。ロールバックはしない。`hold_notices(cancel_mode_vst; kill_engine)`（`:838-841`）で、接続を捨てて子を回収する。`ReplySlot` は `close_connection` で `Closed`（`audio.rs:706-712`）。`LinkState` は `Intentional` で閉じる（`audio.rs:2772`）。モード VST の記録（journal）と手動復旧の状態は残る（`mode_vst.rs:487-513`）。この経路は今すでに、期限切れで子を殺す。
- **文言**：`VST切替の応答が不明です`（`:599`）、`VST切替の送信結果が不明です`（`:564`）、`切替が時間内に完了しませんでした`（`:532`）。接続を失ったときは `Engine Crashed/Exited`（`:573`・`:580`・`:590`・`:606`・`:622`・`:675`）。
- **遅れて届いた応答**：期限切れで接続を捨てているので、reader は `link.is_open()` の確認で止まる（`reader.rs:33`）。

### 2.4 W3：起動の確認（J-24）

- **対象**：`ResumeThread` の戻り値が2以上（外の停止が重なった）の子だけ（`engine_life.rs:318-327`、`audio.rs:948`）。通常の起動には、この確認を足さない。
- **命令**：`StartIdentityCapability`（A）を `execute_running_command` で送る（`audio.rs:952`）。
- **期限の値と起点**：W1 と同じ（書き込み5秒、応答10秒を `flushed_at` から）。コメントは「期限（10秒）」（`:945-947`）。期限だけを変える継ぎ目は `set_limits_for_test`（`engine_life_tests.rs:172`）。
- **`flushed_at`**：W1 と同じ。
- **期限切れの後**：`await_reply` が `Err`（W1 のとおり）を返し、`outcome` が `StartIdentityCapability` でないので、`kill_primary_engine()`（`audio.rs:954-962`）。起動を試みた主の子だけを回収し、配信ミックスの子とオケの入力の選択は残す（`:961`、`post_mix_life_tests.rs:998-1036`）。`ReplySlot` は `Closed`、`LinkState` は `Intentional`（`audio.rs:2772`）。`audio-error` の通知は出ない。`cut_off`（書き込みの失敗・期限切れ）の中では、`confirming_start` が真なので `kill_engine` ではなく `kill_primary_engine`（`:1139-1142`）。
- **文言**：`engine_life::LAUNCH_FAILED`（`音声エンジンの起動を完了できませんでした。音声を開始していません`、`engine_life.rs:45-46`）。終了を確かめられなければ `engine_unconfirmed`（`audio.rs:956-968`）。
- **遅れて届いた応答**：接続を捨てているので届かない。
- **今すでに応答の期限切れで接続を切り離している唯一の場所**。ただし `LinkState` の理由は `Intentional`。

### 2.5 W4：配信ミックスの子（`exec_child`）

- **入口**：`post_mix::State::exec_child`（`post_mix.rs:429-456`）。子の `AudioHost` の `execute_running_command` を呼ぶ（`:443`）。期限・`flushed_at`・遅れた応答は W1 と同じ（子の `AudioHost` ごとに `ReplySlot`・`LinkState`・writer を持つ）。
- **前後の確認**：送る前に `connection_lost()` なら `detach_closed_child` して `CLOSED`（`:436-442`）。送った後は `settle_with(unconfirmed)`（`:445-450`）で、接続が閉じていれば子を外し、`restored = false`・`running = false`・`disconnected = Some(…)`・`detached += 1`（`:461-481`）。`enabled` は触らない。
- **応答の期限切れの後**：`await_reply` の `Err` のまま `exec.result` に入り、`lost` は偽（接続はまだ開いている）。公開の操作の失敗の処理（`post_mix.rs:1151-1162`）が `state.settle()` を呼んでも接続は開いたままなので `detached == detached_before` となり、**`discard_child()` が走る**（`:1156-1161`、`:797-804`）：子を `kill_engine`、`restored = false`・`enabled = false`・`running = false`、`error = "配信VSTの操作を完了できませんでした。保存状態を読み直してください"`。`Stop` は `post_mix::State::stop`（`:813-838`）が `exec_child(Stop)` の失敗で `child.kill_engine()` と `配信VSTを停止できませんでした`。`PostMixStart` は `start`（`:839-887`）が `kill_engine` と `配信VSTを開始できません`（応答の `Error` はその文言）。
- **配信ミックスの子の `AudioHost`** は `post_role = true`（`control.rs:256-259`）。EOF のとき、`ensure_engine_running` は作り直さない（`audio.rs:890`、`link_tests.rs:461`）。
- **今の `enabled` の扱い（応答の期限切れ）**：落ちる（上のとおり）。書き込みの期限切れ・EOF・書き込みの失敗では、切断の後処理を通って `enabled` は残る（`post_mix.rs:1151-1155`、`post_mix_life_tests.rs:659`・`:1156`）。

### 2.6 ほかの待ち（応答の待ちではないが、同じロックの中で待つもの）

- 子の回収：`retire_child` は `kill` の後、終了を最大2秒確かめる（`engine_life.rs:30`・`:243-261`）。確かめられなければ記録（`retired`）へ移す。
- 作り直し：`ensure_engine_running` は、同じ役割の記録があれば、最初の `kill` から10秒まで、2秒ごとに `kill` をやり直して待つ（`engine_life.rs:32-34`・`:128-145`・`:172-189`、`audio.rs:909`）。
- アプリの終了：`Drop` は全部の子に共通の2秒（`engine_life.rs:38`・`:264-278`、`audio.rs:2905-2927`）。
- デバイスの再検出：Host は35秒を過ぎた検出の ticket を取り消す（`audio.rs:1197-1203`）。これは応答の期限ではなく、子の `BeginDeviceScan` の worker（30秒、`devices.rs:126-131`）の見張り。

## 3. 期限切れの後の今の挙動（F1b-0a-1 の後）

応答が書き込みの完了の後、期限（10秒、`flushed_at` から）までに来なかったとき（`audio.rs:1118-1129`）：

| 対象 | 状態 | 根拠 |
|---|---|---|
| `ReplySlot` | `Waiting` のまま。`cancel`・`close` を呼ばない。次の `begin` は「前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。」で失敗する | `audio.rs:1124-1129`、`replies.rs:37-40` |
| `LinkState` | `Open` のまま（触らない） | `audio.rs:1124-1129` |
| 子 | 生きている。`child`・writer・reader もそのまま。`kill` も `retire_child` も呼ばない | 同上 |
| `vst_operations` | `timeout()`：`in_flight = None`。ただし進行中が `device_open`（`Start`）なら残す。`awaiting` は残す（遅い応答の ID を回収するため） | `engine_exit.rs:329-342`、`:561`・`:679` の試験 |
| 条件の記録 | `Conditions::dispatch` が `Err` で `lifecycle(false)` と `audio-conditions-changed` | `audio/conditions.rs:113-120` |
| 呼び出し側の結果 | `Err("Timeout or disconnect waiting for engine response: timed out waiting on channel operation")`（入口により `localize_audio_error` が包む） | `audio.rs:1124-1128`、`compat_tests.rs:650` |

次の命令（`Stop` を含む）：
- 通常の命令は `execute_command`（`audio.rs:999-1039`）。`ensure_engine_running` は、子が生きていて、`LinkState` の理由が EOF でなければ何もせず戻る（`:890-892`）。`sync_live_modes`・`guard_live_command` を通った後、`execute_running_command_inner` で `LinkState` は開いている（`:1062`）ので `ReplySlot::begin` へ進み、`Waiting` なので失敗する（`:1069`）。**命令は子へ送られない**（`begin` は `submit` の前。`:1069-1071`）。
- `Stop` は `stop`→`stop_primary`（`audio.rs:1702-1727`）。モード VST が止めていなければ `reap_confirmed_stopped_connection`（`:1688-1700`）が `connection_lost()` の偽で `false` を返し、`execute_running_command(IpcCommand::Stop)` が同じ `begin` で失敗する。`Stop` を送らないまま、`stop` は `Err` を返す。
- 戻る経路：(a) 遅い応答が届き、`deliver` が `Waiting` を `Idle` にする（`replies.rs:51-64`）、(b) 子の EOF（reader が `LinkState` を閉じる競りに勝てば `ReplySlot::close` と `Eof`。`reader.rs:279-305`）、(c) 明示の再起動などで `kill_engine`（`audio.rs:2743-2776`）、(d) アプリの終了（`Drop`）。`reap_confirmed_stopped_connection` は、接続が閉じていて子が終わっているときだけ働く（`:1688-1700`）。
- モード VST の期限切れは、2.3 のとおり別の挙動（接続を捨てる）。起動の確認の期限切れも、2.4 のとおり接続を捨てる。

### この挙動を固定している試験

| 試験 | 行 | 固定していること |
|---|---|---|
| `commands/audio/compat_tests.rs` `timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request` | `:642-661` | 子が12秒眠る `Start` に対し、10秒以上で `Timeout or disconnect…`（包みつき）、`Stop` を送らない、次の要求（`get_engine_runtime_stats`）が `前の音声操作の応答待ちです…` で失敗する。**実時間で10秒かかる**。次の要求は `Stop` ではない |
| `audio/replies.rs` `timed_out_response_cannot_complete_a_later_request` | `:110-123` | 受け側を捨てた後も `begin` は失敗し、遅い応答の `deliver` が待ちを `Idle` にして、次の `begin` が通る |
| `audio/replies.rs` `exit_and_send_failure_release_the_waiter`・`a_closed_slot_refuses_begin_and_releases_the_waiter_exactly_once`・`dropping_the_extracted_sender_disconnects_the_waiter`・`closing_an_idle_slot_still_closes_it` | `:126-169` | `cancel`・`close` の挙動（閉じた状態の `begin` の拒否、送り側の取り出し、捨てた送り側は `Disconnected`） |
| `audio/tests/link_tests.rs` `t3_the_reply_deadline_counts_from_flushed_at_not_from_when_the_done_is_received` | `:219-250` | 期限は `flushed_at` から数える（9.8秒前の `flushed_at` で残り約0.2秒）。**期限切れの後も `begin` が失敗する（`:236`）**。受け取りが早ければ期限内の応答は採る |
| `audio/engine_exit.rs` `failed_start_does_not_settle_and_timed_out_start_remains_opening_until_response`・`success_error_and_timeout_clear_the_in_flight_record`・`late_load_response_updates_identity_without_reactivating_the_record` | `:499`・`:561`・`:679` | `Operations::timeout` の記録の扱い |

## 4. C3 で接続を切り離すときに関わるもの（役者 × 状態 × 順序の材料）

### 4.1 状態と、それを守るロック

| 状態 | 持ち主・場所 | 守り | 行 |
|---|---|---|---|
| `LinkState` | 接続ごとに `Arc<LinkState>`（`AtomicU8`）。`Open`→`Closed(Intentional・Eof・WriteFailed・WriteTimeout)` を一度だけ（CAS）。`ReplyTimeout` はまだない | atomic | `audio/link.rs:6-66`、`audio.rs:289` |
| `ReplySlot` | 接続ごとに `Arc<ReplySlot>`。`Idle`・`Waiting(Sender)`・`Closed` | 葉の `Mutex`（I/O・`emit` をしない） | `replies.rs:17-95`、`audio.rs:295` |
| `vst_operations` | 接続ごとに `Arc<Operations>`。進行中の操作と、終了の原因の記録 | 葉の `Mutex` | `engine_exit.rs:41-50`、`audio.rs:290` |
| `retired` | 主と配信ミックスで共有する `Arc<Store>`。終了を確かめられない子の記録（役割ごと） | `Mutex` | `engine_life.rs:149-239`、`audio.rs:327` |
| 通知の保持 | `held_notices`（回収の間だけ保持）、`emit_order`（列の直列化）、`emitter`（`AudioEmitter` の複製を取る間だけ） | それぞれ `Mutex` | `audio.rs:271-274`・`:298`、`audio/emit.rs:64-71` |
| 配信ミックスの `detached`・`enabled` | `post_mix::State`。`detached` は切断を処理した回数、`enabled` は有効の意図 | Host の `Mutex` の内側 | `post_mix.rs:301-308` |

ロックの関係：Host の `Mutex<AudioHost>` を持つ役者（同期の呼び出し側・Host の回収・モード VST の tick・配信ミックス）は、葉のロック（`ReplySlot`・`Operations`・`held_notices`・`emit_order`→`emitter`）を取る。reader は Host のロックを持たず・取らない（`reader.rs:3`）。

### 4.2 役者ごとの、触る状態と順序

**reader**（接続ごとに1本、Host のロックなし。`audio/reader.rs`）

1. 行ごと：`LinkState` が `Open` か（`:33`）。閉じていれば行の処理をやめ、4へ。
2. `Response` の行：`vst_operations.response`（`:45`）→ `ReplySlot::deliver`（`:46`）。
3. `Event` の行：`Conditions` の更新（`engine_event`・`engine_changed`。`:88`・`:103`・`:135`・`:172`）→ `notifier.chain_if(LinkState が Open)`（`emit_order` を取ってから `LinkState` を確かめ、開いていれば列の全体を出す。`:27-29`、`emit.rs:110-123`）。
4. EOF（`finish`、`:279-305`）：(a) `LinkState::close(Eof)`。**負けたら** `ReplySlot::close()` の送り側を捨てるだけで戻る（通知なし、`:281-285`）。(b) 勝ったら `ReplySlot::close()` で送り側を取り出す（`:292`）→ `vst_operations.take_exit()`（`:293`）→ `Conditions::engine_event`（`:295`）→ `notifier.chain`（`emit_order`。`audio-conditions-changed`・`audio-engine-exited`・`audio-error`。`:296-300`）→ 取り出した送り側へ `Eof`（`:302-304`）。
- 触らない：`retired`、子のハンドル、配信ミックスの `detached`・`enabled`、writer。

**writer**（接続ごとに1本。`audio/writer.rs`）

1. `jobs.recv`（`:153`）→ `run`：`LinkState` が `Open` か（`:192`）。閉じていれば `Aborted`（書かない）。
2. 開いていれば、JSON 化（`Payload::Command` のとき）・書き込み・`flush`（`:193-231`）。ここで止まりうる（子が stdin を読まないとき）。
3. `WriteDone { result, flushed_at: Instant::now() }` を送る（`:207-210`、`:155`）。
- 触らない：`ReplySlot`、`vst_operations`、通知。止まっているときに起こす手段は、子が終わって pipe が壊れることだけ。`self.writer = None`（送り側を捨てる）では、`write` に入っているスレッドは起きない（キューの受け側の `recv` が `Err` になるのは、次の `recv` のとき）。

**応答を待つ呼び出し側（同期・起動の確認・配信ミックス：`await_reply`）**（Host のロックを持つ）

1. `LinkState` が `Open` か（`audio.rs:1062`）。
2. `ReplySlot::begin`（`:1069`）。
3. `vst_operations.begin`（`:1070`）。
4. writer へ `submit`（`try_send`、`:1071`）。
5. `WriteDone` を最大5秒（`:1095`）：
   - 書き込みの期限切れ・失敗・`Disconnected`：`cut_off`（`:1097-1107`、`:1114-1116`）
   - `Ok`：6へ。`Aborted`：6へ（今から10秒）。
6. 応答を `flushed_at` から10秒（`:1109-1118`）：
   - `Response`：返す。`Eof`・`Disconnected`：`Engine Crashed/Exited`（`:1119-1123`）。
   - `Timeout`：`vst_operations.timeout()`→ `Err`（`:1124-1128`）。接続は切らない。
- `cut_off`（`:1134-1155`）の順：`vst_operations.response(Error)`（`:1135`）→ `LinkState::close(cause)`（勝ち負けを記録。`:1137`）→ `retired.pending` を控える（`:1138`）→ `kill_engine`（起動の確認の間は `kill_primary_engine`。`:1139-1144`）→ `retired.pending` を比べる（`:1145`）→ 勝ったなら `notice("audio-error", …)`（`:1147-1149`。回収の保持は終わっている）→ 書き込みの期限切れで終了を確かめられなければ `engine_unconfirmed`、他は元のエラー（`:1151-1154`）。

**モード VST の tick**（Host のロックを10 ms ごとに取る）

1. 世代の照合（`mode_vst.rs:523`）→ 120秒（`:531`）。
2. 保留中の `WriteDone` を `try_recv`（`:537-567`）→ 応答を `try_recv`（`:569-601`）。応答を採る前に `connection_lost()`（`LinkState` が閉じているか。`:572`・`:684-686`）。
3. 次の段へ進む前に `connection_lost()`（`:605`・`:621`）→ `send_mode_command`（`ReplySlot::begin`→`writer.submit`。`:687-711`）。
4. 失敗（接続の喪失・期限切れ）は `fail_mode_transaction(ambiguous)`→ `hold_notices(cancel_mode_vst; kill_engine)`（`:816-848`）。
- `LinkState` を直接閉じない。`vst_operations` は呼ばない。`cut_off` を通らない。

**配信ミックス（`exec_child`・`settle`）**（Host のロックの内側）

1. 子の `LinkState` を確かめる（`post_mix.rs:436`）。閉じていれば `detach_closed_child`（`:468-481`：子を外して `release_engine`→`drop_connection`→`retire_child`、`restored = false`・`running = false`・`disconnected`・`detached += 1`。`enabled` は触らない）。
2. 子の `execute_running_command`（`:443`）：W1 と同じ。子の `AudioHost` 自身の `cut_off`・`kill_engine` は、子の `retired`（主と共有）・子の `link`・`ReplySlot` を触る。
3. `settle_with(unconfirmed)`（`:450`）：閉じていれば 1 の後始末。
4. 公開の操作の失敗（`:1151-1162`）：`settle()`。切断として数えられなければ（`detached` が変わらない）`discard_child()`（`enabled = false`、子を `kill_engine`）。
- 主の `kill_engine`（`audio.rs:2743-2748`）は、先に `post_mix.kill()`（＝`discard_child`、`enabled = false`）と `mixing.selected = None` を行ってから `kill_primary_engine` へ進む。起動の確認の中の `cut_off` は `kill_primary_engine` だけ（配信ミックスを残す）。

**Host の回収**（`kill_engine`・`kill_primary_engine`・`drop_connection`・`retire_child`・`cut_off`）

`kill_primary_engine`（`audio.rs:2751-2776`）の順：`hold_notices` を開始（通知を保持）→ `post_attached = false`・`output_gain_initialized = false` → `cancel_mode_vst`（モード VST が動いていれば）→ `frontend_bootstrap` の取消 → `invalidate_live_protection` → `live_modes.needs_sync = true` → `conditions.retire_engine()` → `notify_conditions_changed`（保持）→ `engine_generation += 1` → `device_scan = None` → `drop_connection(Intentional)`：`LinkState::close(Intentional)` → `ReplySlot::close()`（送り側を捨てる）→ `writer = None` → `child.take()`→`retire_child`（`kill`＋最大2秒確認、確かめられなければ `retired` へ。`engine_life.rs:243-261`）（`audio.rs:706-722`）→ `voice_activity = false`・`engine_job = None` → `hold_notices` を閉じて、保持した通知を `emit_order` の列で出す（`audio.rs:673-699`）。

- `vst_operations` は触らない（次の `reset_engine_reader` で作り直す。`audio.rs:1052-1058`）。
- `kill_engine` はこの前に、`bundle_prepared_voice = false`・`post_mix.kill()`・`mixing.selected = None`（`:2743-2748`）。
- `Drop`（`audio.rs:2905-2927`）：`close_connection(Intentional)`、`conditions.retire_engine()`、主・配信ミックス・`retired` の子をまとめて `terminate_all`（共通の2秒）。writer は `join` しない。
- `ensure_engine_running`（`audio.rs:872-907`）：`try_wait` で終了なら `close_connection(Intentional)`＋`child = None`。生きていて `LinkState` が `Closed(Eof)` なら（主のとき）`drop_connection`（C5）。`retired.ensure_clear`（`:909`）の後、作り直し：`reset_engine_reader` が `LinkState`・`ReplySlot`・`vst_operations` を新しくする（`:1052-1058`）。

**通知（`emit_order`）**（`audio/emit.rs`）

- 取る側：reader の `chain_if`・EOF の `chain`、Host の `notice`（`emitter.emit`→`chain`。`audio.rs:656-670`、`emit.rs:132-136`）、`hold_notices` の最後（`audio.rs:691-697`）、`Conditions::dispatch` の通知（`audio.rs:1048`）。
- `emit_order` を持つ間に取ってよいのは `emitter` だけ（`emit.rs:61-63`）。`AudioEmitter::emit`（tauri の `emit`）は、`emit_order` を持ったまま呼ぶ。
- 回収の経路（`kill_primary_engine` 本体）は `emit_order` を取らない。通知は保持して、回収の後に出す（`audio.rs:672-699`）。ただし `cut_off` の `notice("audio-error")` は回収の後で、保持の外。

### 4.3 役者 × 状態の対応

R＝読む、W＝書く（状態を進める）、CAS＝勝ち負けのある閉じ、★＝待つ（ブロックしうる）。

| 役者＼状態 | `LinkState` | `ReplySlot` | `vst_operations` | `retired` | 通知の保持（`emit_order`・`held_notices`） | 配信ミックス `detached`・`enabled` |
|---|---|---|---|---|---|---|
| reader | R（行ごと・列の直前）、CAS（EOF） | W（`deliver`、EOF で `close`） | W（`response`、`take_exit`） | なし | ★`emit_order`（`chain`・`chain_if`）、`emit` | なし |
| writer | R（書く前） | なし | なし | なし | なし | なし |
| 同期の呼び出し側（`await_reply`・`cut_off`） | R（入口）、CAS（`cut_off`） | W（`begin`。期限切れの後も残す） | W（`begin`・`timeout`・`response`） | `cut_off` の前後で `pending` を読む（回収の中で W） | ★`emit_order`（`notice("audio-error")`） | 子の `AudioHost` の側の話（下の行） |
| モード VST の tick | R（`connection_lost`） | W（`begin`・`cancel`。回収で `close`） | なし | 回収の中で W | 回収の中で保持（`hold_notices`）、最後に ★`emit_order` | なし |
| 起動の確認 | R・CAS（`cut_off`、`kill_primary_engine` の `Intentional`） | W | W | W（回収の中） | 同上 | 残す（`kill_primary_engine`） |
| 配信ミックスの呼び出し側（`exec_child`・`settle`） | R（子の `LinkState`） | なし（子の `AudioHost` の側） | なし | W（`release_engine`→`retire_child`） | なし | W（`detached`、`restored`、`running`、`discard_child` で `enabled`） |
| Host の回収（`kill_engine`・`kill_primary_engine`・`cut_off`・`retire_child`・`Drop`） | CAS（`Intentional` など） | W（`close`） | 触らない（次の接続で作り直す） | W（`retire_child`） | W（保持）→ ★`emit_order`（保持の放出） | `kill_engine` が `enabled = false`。`kill_primary_engine` は残す |
| 通知（`emit_order`） | 読まれる（`chain_if` の確認） | なし | なし | なし | 本体 | なし |

### 4.4 設計 11章の既知の狭い競合3つの位置

| 指摘 | 競っている役者 | 状態 | 順序の窓 | 今の表のどこ |
|---|---|---|---|---|
| 1：未送信の VST の操作が終了の原因に載る | reader（EOF）× 同期の呼び出し側 × writer | `LinkState`・`ReplySlot`・`vst_operations` | reader が `LinkState::close(Eof)` に勝った後、`take_exit()`（`reader.rs:293`）の前に、呼び出し側が `begin`（`audio.rs:1069`）→ `vst_operations.begin`（`:1070`）を通る。writer は閉じた接続で `Aborted`（`writer.rs:192-199`）。`take_exit` が、子に届いていない操作を原因として取る | 4.2 の reader の4(b)と、同期の呼び出し側の2〜4。`vst_operations` の列 |
| 2：`settle()` の直後の EOF で `enabled` が落ちる | 配信ミックスの呼び出し側 × reader（EOF） | `LinkState`・`detached`・`enabled` | 公開の操作の失敗の処理が `settle()`（`post_mix.rs:1155`）で開いた接続を読んだ直後に、reader が CAS に勝つ。`detached` は変わらず、`discard_child()`（`:1156-1161`）が `enabled = false` にする | 4.2 の配信ミックスの4。`detached`・`enabled` の列 |
| 3：K13 で、通知の前に `Disconnected` になる | reader（EOF）× Host の回収 | `LinkState`・`ReplySlot`・通知 | reader が CAS に勝った後、`ReplySlot::close()`（`reader.rs:292`）の前に、Host の回収が `close_connection`（`audio.rs:709`）で送り側を取り出して捨てる。待ち手は通知3件より前に `Disconnected` で解放される | 4.2 の reader の4(b)と、Host の回収の `drop_connection`。`ReplySlot` と通知の列 |

3つとも、閉じる役者の1つが reader の EOF。C3 で足される閉じる役者（応答の期限切れ）は、同期の呼び出し側が `cut_off` と同じ順で閉じる役者になる（`LinkState`・`ReplySlot`・回収は、Host のロックの中で順に行う。`audio.rs:1134-1155`）。reader は Host のロックを持たないので、期限切れの瞬間に reader が `deliver` や EOF を行う窓は、書き込みの期限切れと同じ形で残る（推測：新しい窓の形は、C2 の書き込みの期限切れと同じ。ただし C3 では、応答が期限のすぐ後に届く窓が加わる。`Timeout` を受け取った後に `deliver` が `Waiting` を `Idle` にしうる。`replies.rs:51-64`）。

## 5. 既存の試験

### 5.1 2〜4 の性質を固定している試験

| 性質 | 試験 | 行 |
|---|---|---|
| 応答の期限10秒・期限の後の待ちの残り方・次の要求の拒否 | `compat_tests.rs` `timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request` | `commands/audio/compat_tests.rs:642-661` |
| 期限の起点＝`flushed_at`。期限切れの後も `begin` が失敗 | `link_tests.rs` T3 | `audio/tests/link_tests.rs:219-250` |
| `ReplySlot` の状態遷移（期限切れ・遅い応答・`close`・`cancel`） | `replies.rs` の5つ | `audio/replies.rs:110-169` |
| C2：書き込みの5秒で切り離し、`audio-error`、次の操作で作り直し | `link_tests.rs` T1 | `:88-148` |
| 書き込みの失敗 ＞ EOF、`Aborted` は EOF の結果を待つ | `link_tests.rs` T2×4 | `:152-215` |
| EOF と `begin` の窓 | T4 | `:255-291` |
| EOF の通知が待ち手の解放より先、競りに負けた EOF は通知なし | T5×2 | `:295-352` |
| reader が `emit` で止まっても回収する | T6 | `:356-` |
| 正常な応答の後も同じ接続で通る | T7 | `:407` |
| C5 | T8×2 | `:424`・`:461` |
| 閉じた接続は通知の列を出さない、K13 | T9×3 | `:474`・`:499`・`:527` |
| `Drop` の2秒 | T13 | `:559` |
| C2 の文言（終了を確かめられたか） | `p2_c2_message_depends_on_whether_the_exit_was_confirmed` | `:627-664` |
| 配信ミックスの待ちの前後の状態 | `post_mix_life_tests.rs` W2 系、T10 系、P1・P2・P3 系 | `audio/tests/post_mix_life_tests.rs:66-121`・`:415-531`・`:605-1179` |
| 起動の確認の期限切れ（応答の期限を500 msに短縮）→ 回収・`LAUNCH_FAILED`・作り直せる | `engine_life_tests.rs` `w1c_a_child_whose_external_suspend_is_never_released_is_retired_and_the_start_fails` | `audio/tests/engine_life_tests.rs:169-196` |
| 起動の確認の EOF・拒否、確認が要る条件、通常の起動に確認がない | `engine_life_tests.rs` | `:656`・`:671`・`:691` |
| 起動の確認の書き込みの失敗・期限切れで配信ミックスとオケを残す | `post_mix_life_tests.rs` P2 | `:998-1036` |
| モード VST：判定の順、`Aborted` は同じ10秒の中で EOF を待つ（11秒前の `sent` は `VST切替の応答が不明です`）、EOF で復旧の経路 | `mode_vst.rs` T11 系 | `audio/mode_vst.rs:2290`・`:2311`・`:2326-2350`・`:2354`・`:2368`・`:2381` |
| モード VST：書き込みの詰まりの間も停止が即時、取り消した遷移を再開しない | `mode_vst.rs` | `:2125`・`:2168`・`:2099` |
| モード VST：応答が曖昧なとき、ロールバックせず・ミュートを解除しない（`fail_mode_transaction` の直接の呼び出し） | `ambiguous_response_never_rolls_back_or_unmutes` | `:1635-1647` |
| モード VST：回収の間 reader が `emit` で止まっていても回収 | T6 | `:2490` |
| `Operations::timeout` などの記録 | `engine_exit.rs` | `:499`・`:561`・`:679` |
| 子の診断（5秒・30秒の通知の閾値） | `control_stall.rs` | `audio_engine/core/control_stall.rs:355-428`（未精読の試験もある） |
| writer の単体 | `writer.rs` | `audio/writer.rs:312-402` |

### 5.2 固定されていない性質

- **`Stop` が期限切れの後で失敗する**こと。固定している試験の「次の要求」は `get_engine_runtime_stats`（`compat_tests.rs:656`）で、`Stop` ではない。`stop_primary` の経路（`audio.rs:1708-1727`）で `begin` が拒否することは、試験で固定されていない。
- 期限切れの後に **`LinkState` が `Open` のまま・子が生きている**こと。`compat_tests.rs` は結果の文言と次の拒否しか見ない。T3（`link_tests.rs:236`）は `begin` の失敗だけを見る。
- **命令の種類ごとの期限**。応答の期限を差し替える継ぎ目は、スレッドごとに全命令共通の1つ（`writer.rs:17-46`）。
- **期限の後に届いた応答の `received_at` による扱い**（設計 2.1 の案。`ReplyOutcome` にまだ `received_at` がない。`replies.rs:11-15`）。
- **`ProbeLoopback` の録音の時間の上限**。
- **配信ミックスの子の応答の期限切れ**（`Timeout`）が、`discard_child` で `enabled = false` になること。`post_mix_life_tests.rs` の `p2_a_non_disconnect_failure_still_discards_the_child_and_disables`（`:716-724`）は、子の `Error` 応答（`rack refused`）で `enabled = false` を確かめていて、応答の期限切れは使っていない。
- **モード VST の `切替が時間内に完了しませんでした`（120秒）**と、**書き込み待ちが10秒を超える `VST切替の送信結果が不明です`**。試験で文言が使われていない（`mode_vst.rs:532`・`:564` 以外に出現しない）。
- **モード VST の応答の期限切れ（10秒、`pending.receiver` が空）の実際の判定**。`:2344-2349` は書き込みが `Aborted` のとき。受け側が空のまま10秒超を `poll_mode_vst` が判定する直接の試験は見当たらない（`:599` の文言は `:2349` だけ）。
- 期限切れで、**ロックを持った時間の上限**（書き込み5秒＋応答10秒＋終了の確認2秒）。T1 は書き込みの期限を試験で短くした実測だけ（`link_tests.rs:88-148`）。
- 子の側：**どの命令が実際に何秒かかるか**（実測はない）。`RestorePlugin` の予算の検査の試験は `audio_engine/restoration.rs` 内にあるはず（未精読）。

## 6. 気づいたこと（事実として不安な点。設計案ではない）

1. **B の基準が前処理まで含めると広い**（1.4 の1）。前処理で試聴のストリームを破棄しうる命令は、設計が名指しした3つだけでなく24命令ある。「条件付きの B」を何として扱うかは、コードからは決まらない。条件は「試聴が動いているとき」で、その時間は測っていない。
2. **`RestorePlugin` の8〜10秒が、30秒の期限より内側にある**（1.4 の3）。J-23 で30秒にしても、子が先に期限切れのエラーを返す（または段の間で検査が効かない VST の長い1段が、そのまま30秒を使う）。
3. **応答の期限がグローバルな1値で、命令を引数に取らない**（`writer.rs:23-37`）。試験の継ぎ目もスレッドごとの1組（`:17-46`）。モード VST は別の10秒（`mode_vst.rs:556`・`:593`）。`ProbeLoopback` の「録音の時間＋10秒」は、命令の引数（`duration_ms`）から決まる。
4. **設計 2.1 の `ReplyOutcome::Response { resp, received_at }` は、コードではまだ `Response(Box<Response>)`**（`replies.rs:11-15`）。reader が時刻を打つ処理もない（`reader.rs:44-47`）。
5. **応答に ID がなく、親は応答の種類も照合しない**（`replies.rs:1`・`:50`）。期限切れの後に同じ接続へ次の命令を送ると、遅い応答を次の命令の応答と取り違えうる。今は、期限切れの後に `Waiting` を残すことで、次の命令を拒んでこれを防いでいる（`audio.rs:1062-1069`、`replies.rs:37-40`）。C3 が「停止を応答の待ちに関係なく受け付ける」（`changes.md` の C3）なら、子の側にも、復元が保留中のとき、別の命令の処理でも復元の応答がその命令の応答より先に1件出る事情がある（1.5 の `core.rs:2006-2008`）。
6. **主の応答の期限切れで切り離すと、`kill_engine` が配信ミックスの子と `mixing.selected` まで捨てる**（`audio.rs:2743-2748`、`post_mix.rs:797-804`）。今の C2（書き込みの期限切れ）と同じ。C3 の対象の命令は書き込みより長くかかる（B の VST 操作など）ので、この副作用が起きる場面が増える（推測：発生頻度は測っていない）。起動の確認の中だけは `kill_primary_engine` で配信ミックスを残す（`audio.rs:1139-1142`）。
7. **配信ミックスの応答の期限切れは、今は `enabled = false` になる**（2.5。`discard_child`）。C3 が子の `AudioHost` で接続を閉じてから戻ると、`settle()` が切断として数えて `enabled` を残す側に変わる（`post_mix.rs:1151-1161` の `detached` の判定）。結果が変わる経路。
8. **モード VST の期限切れは、今すでに接続を捨てる**（`fail_mode_transaction(ambiguous)`→`kill_engine`。`mode_vst.rs:564`・`:599`・`:838-841`）。ただし `LinkState` の理由は `Intentional`、`audio-error` の通知なし。同期の `cut_off` は、勝てば `audio-error` を出す（`audio.rs:1147-1149`）。2本の期限切れの後始末の通知が揃っていない。
9. **モード VST は `vst_operations.begin` を呼ばない**（`mode_vst.rs:687-711`、`audio.rs:1070`）。モード VST の途中で子が落ちると、EOF の原因は `unknown` になる（推測：`take_exit` は `in_flight` がなければ `unknown`。`engine_exit.rs:169-181`）。
10. **起動の確認の期限切れは、今すでに応答の期限切れで接続を捨てる**（`audio.rs:954-962`）。理由は `Intentional`。後始末は `cut_off` と別に `kill_primary_engine` を呼ぶので、`cut_off`（書き込みの失敗）→ `kill_primary_engine` → 呼び出し側の `kill_primary_engine` の順で、同じ接続に対して2回呼ばれうる（`audio.rs:1141`・`:962`。`engine_generation` を2回進める。`:2766`）。
11. **応答の期限切れで `Conditions::dispatch` が `lifecycle(false)` を呼ぶ**（`conditions.rs:114-116`）。子が生きていて接続も開いたままなのに、条件の記録は「停止」になる。
12. **ロックを持つ時間**：書き込み5秒＋応答10秒＋終了の確認2秒（`audio.rs:1095`・`:1111`、`engine_life.rs:30`）。B の30秒にすると、応答の待ちだけで30秒になる（5＋30＋2）。その間、`Stop`・トレイ・ショートカット・状態の読み取りは、ロックの取得で待つ（`control.rs:221-252`）。J-18 の「停止が最大で期限まで遅れる」は、このロックの待ちとして現れる。
13. **子の `ControlStall` の2回目（30秒）と B の30秒が同じ値**（`control_stall.rs:155-159`）。親の期限の起点は `flushed_at`（書き込みの完了）、子の起点は命令の処理の開始（`control_stall.rs:96-107`）。起点が違うので、通知と期限切れの順は入れ替わりうる（推測）。
14. **`ProbeLoopback` は録音の `sleep` が `duration_ms` に比例し、上限がない**（1.3 の #62）。Host の既定は1500 ms（`commands/audio.rs:1202`）で通常は短いが、画面からの指定は検証していない（`src/api/audio.ts:326-331` は引数を渡すだけ）。
15. **`Start` の最悪の長さ**は、試行（最大3回）・入力の到着待ち（1秒）・アプリ入力の開始待ち（6秒）・VST の準備・既存のストリームの停止の合計で、コードからは1つの値にならない（1.4 の5）。30秒の根拠は実測（J-8）に頼る。
16. **子の JSON の解析の失敗は、応答もイベントも出さない**（`core.rs:621`）。親は期限まで待つ。
17. **reader は、`LinkState` が閉じた後の次の行で止まる**（`reader.rs:33`）。応答の期限切れでの切り離しの後、子が殺されるまでは、子の出力の行が1行読まれてから `finish` へ進む。`finish` は競りに負けるので通知は出ない（`:281-285`）。

## 7. 調べきれなかったこと

- 各命令が実際に何秒かかるか（実測なし）。J-8 の実測は、この調査の範囲外。
- ASIO のストリームの Drop が待つか。WASAPI は `join` する（1.2）。試聴のストリームは WASAPI 固定。
- 未精読の本体（印 ☆）：`ModeSilence`・`ConfigureLiveModes`・`StartNoiseLearning`・`NoiseMeasurement`・`SetBuiltInEffects`・`BuiltinEffects`・`GetFrameTimingTrace`。読んだ範囲に VST・ストリーム・共有メモリ・ファイル I/O・`sleep`・`join` はない。
- `Start` の合計の長さの上限（1.4 の5、気づき15）。
- `RestorePlugin` の予算の検査（`restoration.rs`）の単体の試験の有無と、遅延接続（`needs_deferred_connection`）の実際の長さ。
- 子の `ControlStall` の実際の通知と親の期限切れの順（気づき13）。
- 配信ミックスで応答の期限切れを使う既存の試験があるか（5.2）。
- `post_role` の専用 Engine（`PostMixStart` を受ける側）の命令の許可の表（`audio_engine/core/post_mix.rs` の `post_role_command_allowed`）の中身。
- 画面（`src/`）が `ProbeLoopback` などにどんな引数を渡しうるか（1500 ms の固定の呼び出し以外）。
- 実機・長時間・音声の確認は、この調査では行っていない（読むだけ）。

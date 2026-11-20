# 旧 API の互換の契約（`9567061a` の実際の振る舞い）

状態：F0 の成果物。コードを読んで確かめた事実を表にした。実機・実際の WebView では確かめていない。
設計は [audio-session-controller.md](audio-session-controller.md)。試験の行は [audio-session-acceptance.md](audio-session-acceptance.md)。

読み方：

- 「事実」の列は、`9567061a` のコードで確かめたこと。根拠を `ファイル:行` で示す（行は `9567061a` の値）。
- 「F1a」の列：**変えない**（互換の試験で固定する）。
- 「F1b」の列：安全のために変える候補。個別の承認が要る差分（9章）。
- 「通知の順序」は、Rust がイベントを `emit` する順序と、`emit` を呼ぶスレッドの順序を述べる。WebView に届く順序は、コードだけでは確かめられていない（9章の「未確認」）。

## 1. `get_audio_state`

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 引数・応答の型 | 引数なし。`AudioStateInfo { is_running: bool, config: Option<ActiveAudioConfig>, condition_witness?: {revision: string, epoch: string} }` | `audio.rs:153-165`、`commands/audio.rs:285-295` | 変えない | 項目の追加のみ可（任意の項目） |
| `is_running` の意味 | **子プロセスのハンドルがあること**（`child.is_some()`）。ストリームが動いている意味ではない | `audio.rs:2918` | 変えない | 変えない。ストリームの状態は別項目（新しい契約）で足す |
| 子が EOF で死んだ後の `is_running` | `true` のまま。reader は `child` を片付けない。次に `ensure_engine_running`／`kill_engine`／`reap_confirmed_stopped_connection` が走るまで残る | `audio.rs:1042-1056`、`:607-635`、`:2786-2816` | 変えない | 終了の確定で `false` にする案（承認が要る） |
| ストリームの実際の有無 | フロントは `auto_gain` の `status`（子への IPC）で取る。`running`・`streamFailed` | `api/audio.ts:144`、`audio.rs:2128-2160` | 変えない | スナップショットの項目に足す（任意の項目） |
| `config` | `active_config`（メモリ）。起動前は `null`。`Start` の成功で更新される。停止しても消えない | `audio.rs:1691`、`:2919` | 変えない | 変えない |
| `config` の形 | `ActiveAudioConfig`：`input_source?`、`host`、`input`、`output`、`input_id?`、`output_id?`、`buffer_size`、`sample_rate`、`routing?`。`input_source`・`input_id`・`output_id`・`routing` は `None` のとき出力しない。`input`・`output`・`buffer_size`・`sample_rate` は `null` として出力 | `audio.rs:136-151` | 変えない | 変えない |
| `condition_witness` の形 | `{revision: string, epoch: string}`。10進数の文字列。`Conditions::snapshot()` が成功したときだけ付く（走行中で、保留中の変更がないとき）。失敗なら項目ごと省く | `audio.rs:2920-2927`、`audio/conditions.rs:150-166` | 変えない | 変えない |
| 子を起動するか | **起動しない**。読み取りだけ。ロックは取る（先行する操作の完了を待つ） | `commands/audio.rs:290-293` | 変えない（F1a でも読み取りは待たない形にしてよいが、値は同じ） | — |
| ロック待ち | `Mutex` を待つ。10秒の IPC 待ちの間は、応答が遅れる | `audio.rs:3041` | 待たない形にしても、値の意味は同じ（`SnapshotCell` 化）。変更は試験で固定する | — |

## 2. `expectedState`（`start_audio` の任意の引数）の完全一致

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 適用先 | `start_audio` だけ。`restart_audio_engine` は `expected_state` を受け取らない（フロントは付けるが、Tauri が無視する） | `commands/audio.rs:383-388`、`:624-628`、`api/audio.ts:206-219` | 変えない | 変えない |
| 照合の規則 | 次のいずれかなら失敗：`current.is_running == false`、`current.condition_witness == None`、`expected` に `condition_witness` キーがない、`serde_json::to_value(current) != expected`（**JSON の完全一致**） | `commands/audio.rs:433-447` | 変えない | 変えない |
| 完全一致の意味 | `config` を含む全体を比べる。項目の欠落・余分な項目は不一致。`revision`・`epoch` の文字列の差も不一致 | 同上 | 変えない | 変えない |
| 同じ設定でも拒む場合 | 停止・再開（`lifecycle`）で `revision` と `epoch` が進むので、旧の witness は拒まれる | `commands/audio.rs:455-481`（試験）、`audio/conditions.rs:138-146` | 変えない | 変えない |
| 照合の時点 | ロックを取った後、`resolve_input_source` と開始の前 | `commands/audio.rs:409-416` | 変えない（actor の上でも、同じ順序で照合） | 変えない |
| エラーの文字列 | `音声の条件が変わりました。現在の設定を確認してから再試行してください。`（`localize_audio_error` を通さない） | `commands/audio.rs:442-444`、`:409-412` | 変えない | 変えない |

## 3. 開始・停止・再起動の応答

### 3.1 `start_audio`

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 引数 | 平坦な引数 `inputSource?`・`input`・`output`・`host`・`bufferSize`・`sampleRate`・`inputId`・`outputId`・`channelRouting?`、および `expectedState?`。引数の検証は Tauri が行う | `commands/audio.rs:335-381`、`:383-388` | 変えない | 任意の項目を足してよい（`clientRequestId`、`origin`） |
| 成功の応答 | `AudioConfig { sample_rate, buffer_size, channels: 2（固定）, routing: ChannelRouting または null, stream_generation?: "e:c" }`。`stream_generation` は `None` のとき出力しない。`routing` は `None` のとき `null` | `audio.rs:89-98`、`:1698-1707` | 変えない | 任意の項目を足してよい（`sessionRevision` など） |
| エラーの文字列 | `localize_audio_error(e.to_string())`。「sample clock or rate cannot be determined」「device not found」「access is denied」「0x80070005」「アクセスが拒否」「stream configuration is not supported」を含めば、決まった日本語。それ以外は `オーディオエラーが発生しました。\n\n詳細: {元の文字列}`。**日本語の元のエラーも、この形で包まれる** | `audio.rs:3044-3078`、`commands/audio.rs:428` | 変えない | 変えない |
| ロックの取得失敗 | `Failed to lock audio state` | `commands/audio.rs:409` | 変えない | — |
| 開始時の副作用 | `start_with_input_source` が `require_explicit_start()` を呼び、frontend の自動の開始の取り消し（`session_claimed`）を行う | `audio/process_inputs.rs:127` | 変えない | 変えない |
| 保存の副作用 | 成功のたびに `last_audio_config.json` を書く。失敗はログだけで、結果は成功 | `audio.rs:1686-1689` | 変えない | `persist` の失敗の注記を足す（任意の項目） |
| 保存する応答の内容 | 保存する `ActiveAudioConfig` は、`Response::Started` の機器 ID・経路・レート | `audio.rs:1674-1684` | 変えない | 変えない |
| 子を起動するか | **起動する**（`ensure_engine_running`）。`expected_generation` つきの warmup の開始は、既存の接続を要求する | `audio.rs:1567-1581` | 変えない | 変えない |
| 通知の前後 | `EngineEvent::Started` は子が `Response::Started` より先に出す。reader は `Started` を読んだ時点で `audio-conditions-changed` と `audio-started` を `emit` し、次の行の `Response` を待ち手へ渡す。つまり **`emit` の呼び出しは、コマンドの応答の前** | `audio_engine/core/startup.rs:2259-2265`、`core/commands.rs:603-621`、`audio.rs:914-936`、`:803-808` | 変えない（順序を試験で固定） | 新しい通知は、確定の後に出してよい。旧の通知を新しい確定に結び付けて遅らせる変更は、承認が要る |
| 失敗したときの通知 | 子の `start_audio_impl` が失敗すると、`Stopped` イベントの後に `Response::Error`。したがって失敗の開始でも、`audio-stopped` が、エラーの応答の前に出る | `audio_engine/core.rs:1328-1334`、`core/commands.rs:618-622` | 変えない | 変えない |
| タイムアウト | 1コマンドごとに10秒。文字列は `Timeout or disconnect waiting for engine response: timed out waiting on channel operation`（`localize` で包まれる）。**タイムアウト後も `Stop` を送らない**。応答が来るまで、次の要求は `前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。` で拒まれる | `audio.rs:1184-1188`、`audio/replies.rs:13-21` | 変えない | 隔離と清掃の `Stop`（承認が要る差分。設計 5.3） |
| 開始の内部の手順 | `SetGlobalMute` → `Start` の2コマンド。そのほか前提として、機能確認・二系統出力・モニターの復帰（それぞれ別の IPC）。1つでも失敗すれば、その時点で失敗 | `audio.rs:1586-1626`、`:3028-3038` | 変えない | 変えない |
| 確認に失敗した成功 | 機器 ID の不一致、経路の確認不能、アプリ入力の確認不能では、`Stop` を送り、`開始した機器のIDを確認できません。機器を選び直してください`、`音声エンジンが接続設定の確認に対応していません`、`アプリ入力で開始したことを確認できません。音声エンジンを更新してください` で失敗 | `audio.rs:1647-1672` | 変えない | 変えない |

### 3.2 `stop_audio`

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 応答 | `()`（JSON の `null`）。エラーは `e.to_string()` で、**`localize` を通さない** | `commands/audio.rs:484-496` | 変えない | 変えない |
| 停止の意図の登録 | ロックを待つ前に `interrupt_restore()`（`interrupt` カウンタと `revision` を進め、`pending` を保持）。ハンドラの終了で `Pending` が落ちて `revision` がもう1つ進む | `commands/audio.rs:489`、`audio/conditions.rs:55-58`、`:46-52` | 変えない（受付順の `Admission` に統合しても、witness の無効化の結果は同じ） | 変えない |
| 子を起動するか | **起動しない**。`reader_active` が偽で、子がない（または終了済み）なら、`kill_engine()` だけ行って成功を返す。この場合も `engine_epoch` と `engine_generation` が進み、`audio-conditions-changed` が出る | `audio.rs:1723-1735`、`:2779-2816`、`:1743-1759` | 変えない | 変えない |
| 接続が生きているとき | `Stop` を送る。応答 `Success` で成功。`Error` で失敗。それ以外は `Unexpected response type` | `audio.rs:1755-1759` | 変えない | 変えない |
| 通信が終了した接続への `Stop` | `execute_running_command_inner` が `音声エンジンとの通信が終了しました` で失敗 | `audio.rs:1153-1156` | 変えない | 変えない |
| 配信ミックスの停止 | `result.and(post)`。主が成功し配信ミックスが失敗すると、配信ミックスのエラーを返す。両方失敗なら主のエラー | `audio.rs:1737-1741` | 変えない | 変えない |
| 手動復旧中 | `mode_vst.blocked()` なら、`cancel_mode_vst` と `kill_engine` をして成功 | `audio.rs:1744-1748` | 変えない | 変えない |
| 通知 | 子が `Stopped`（`stream_generation`、`ended_stream_generation`）を `Response::Success` の前に出す。動いていなくても出る。reader が `audio-conditions-changed` と `audio-stopped` を `emit`（`emit` はコマンドの応答の前） | `audio_engine/core.rs:1421-1429`、`audio.rs:878-901` | 変えない | 変えない |
| frontend の自動開始の取り消し | `frontend_bootstrap.cancel()` と `session_claimed = true` | `audio.rs:1749-1750` | 変えない | 変えない |

### 3.3 `restart_audio_engine`

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 引数 | `start_audio` と同じ `AudioStartOptions`。`expectedState` は受け取らない | `commands/audio.rs:624-628` | 変えない | 変えない |
| 成功の応答・エラー | `start_audio` と同じ形・同じ `localize` | `commands/audio.rs:668-680` | 変えない | 変えない |
| 事前確認 | マイク許可の確認（プロセス入力でないとき）→ ロック → `preflight_live_changes` → 入力元の解決 → `preserve_live_changes_for_restart` → **`kill_engine`** → 開始 | `commands/audio.rs:650-679` | 変えない | 変えない |
| 子を起動するか | 起動する（既存の子を殺して、新しい子を起動する） | 同上 | 変えない | 変えない |
| 意図した終了の通知 | `kill_engine` は `reader_active` を先に偽にするので、`audio-engine-exited`・`audio-error`（クラッシュ）は出ない。`audio-stopped` も出ない。出るのは `audio-conditions-changed`（`retire_engine` の後）だけ。続けて新しい接続の通知 | `audio.rs:2779-2816`、`:1042-1056` | 変えない | 終了の確定の履歴（`reason = restart`）を足す。旧の通知は増やさない |

### 3.4 補助のコマンド

| コマンド | 応答 | 子を起動するか | 備考 | 根拠 | F1a | F1b |
|---|---|---|---|---|---|---|
| `get_saved_audio_config` | `Option<ActiveAudioConfig>`。ファイルがなければ `null`、`host` が空ならエラー `保存済み接続方式が空です` | 起動しない | `last_audio_config.json` を直接読む | `commands/audio.rs:270-283`、`audio.rs:2932-2942` | 変えない | 変えない |
| `audio_frontend_bootstrap` | `{outcome: "started"\|"attached"\|"inactive", initialPage, error}` | 既存の接続の確認のみ。warmup が済んでいれば起動しない。`frontend_seen`・取り消し後は、状態を触らない | 一度だけ有効。reload 後は `attached` または `inactive` | `commands/audio.rs:256-268`、`audio/frontend_bootstrap.rs:90-210` | 変えない | 変えない |
| `get_output_gain_observation` | `{generation: string, state: auto_gain.Snapshot}`。`generation` は `engine_generation` の10進数 | 起動しない（`Status` は `existing_only`） | 子への IPC を1回 | `commands/audio.rs:243-254`、`audio/frontend_bootstrap.rs:112-120` | 変えない | 変えない |
| `auto_gain`（`status`） | `Snapshot`。`running`・`stream_failed` を含む | 起動しない | フロントの `getAudioStreamState` がこれを使う | `audio.rs:2128-2190`、`api/audio.ts:144` | 変えない | 変えない |
| `get_engine_runtime_stats`、`set_*`（ゲイン・NR・ミュートなど） | それぞれの型 | `execute_command` 経由は**起動する**。`existing_only` と `*_routed(require_running=true)` は起動しない | 個別の差は多い。F1a は全入口で「起動する／しない」を保存する | `audio.rs:1086-1126`、`audio/engine_exit.rs:222-300` | 変えない | 変えない |
| `restart` の前の `preflight_live_changes`、`begin_live_changes`、`end_live_changes` | それぞれの型 | 起動しない（既存の接続の確認） | 本番保護の変更の範囲 | `commands/audio.rs:1154-1198` | 変えない | 変えない |

## 4. 子を起動する／しない（まとめ）

| 操作 | 起動するか | 根拠 |
|---|---|---|
| `get_audio_state`、`get_saved_audio_config`、`get_output_gain_observation` | しない | 上 |
| `stop_audio` | しない | `audio.rs:1723-1759` |
| `auto_gain` の `status`／`cancel`／`initialize` | しない（`existing_only`） | `audio.rs:2171-2190` |
| `start_audio`、`restart_audio_engine`、warmup | する | `audio.rs:601`、`:1576`、`:2830` |
| `execute_command` を通る命令（`load_plugin`、`set_input_gain` など） | する。ただし `GetFrameTimingTrace` は除く | `audio.rs:1086-1126` |
| 更新のための停止（`prepare_update`） | しない。`child.is_some()` のときだけ `stop()` → `kill_engine` | `audio.rs:2765-2773` |

## 5. 通知（6つ）と `audio-conditions-changed` の順序

通知はすべて、reader（stdout を読むスレッド）か `AudioHost` のメソッドが、`emitter` の Mutex を持って `emit` する。`emit` はアプリ全体へ配る。

| 通知 | 出る条件 | ペイロード | 同時に出るもの（`emit` の順序） | 根拠 |
|---|---|---|---|---|
| `audio-started` | 子の `Started` イベントを読み、`conditions.engine_event(epoch, true)` が真（接続が現在のもの） | `{sample_rate, buffer_size, stream_generation?}` | `audio-conditions-changed` → `audio-started` | `audio.rs:914-936` |
| `audio-stopped` | 子の `Stopped` を読み、`engine_event(epoch, false)` が真 | `{stream_generation?, ended_stream_generation?}` | `audio-conditions-changed` → `audio-stopped` | `audio.rs:878-901` |
| `audio-stream-error` | 子の `Error`（文字列）を読み、`engine_event(epoch, false)` が真 | 文字列。**番号なし** | `audio-conditions-changed` → `audio-stream-error` | `audio.rs:849-858` |
| `audio-error` | (a) 子の stdout が閉じ、`unexpected_exit` が真（`reader_active` を `swap(false)` で下げられた）(b) stdin の書き込みの失敗 | (a) `"Audio Engine Process Exited (Crash?)"` (b) `"音声エンジンとの通信が切れました"` | (a) `audio-conditions-changed` → `audio-engine-exited` → `audio-error`。その後、待っている呼び出しに `Error("Engine Crashed/Exited")` を渡す | `audio.rs:1042-1056`、`:1170-1182` |
| `audio-engine-exited` | 上の (a) | `ExitPayload`（camelCase：`cause`、`op?`、`pluginId?`、`path?`、`classId?`、`name?`、`elapsedMs?`、`host?`、`input?`、`output?`、`phase?`） | 上の (a) | `audio/engine_exit.rs:10-33` |
| `audio-conditions-changed` | (1) 子の起動（`new_engine` の後）(2) `command_changes` が真の命令の前後・失敗時 (3) `Mixing*Failed`／`Error`／`Stopped`／`Started` の `engine_event` が真 (4) 子の終了（EOF、`kill_primary_engine`） | `()` | 常に、対応する他の通知より**先** | `audio.rs:638-639`、`:2798-2799`、`audio/conditions.rs:70-93` |

その他の通知（互換の対象。F1a は変えない）：`audio-level`、`audio-loudness`、`audio-channel-scan`、`audio-control-stall`、`audio-processing-health`、`voice-check-state`、`voice-check-envelope`、`plugin-editor-opened`、`plugin-editor-closed`、`mixing-source-failed`、`mixing-output-failed`（`audio.rs:810-1030`）。

順序の事実。

- **`audio-conditions-changed` は、同じ事象の他の通知より前に `emit` される。** フロントはこの順序を前提にしている（`NoiseMeasurementPanel.tsx:67`、`useVoiceCheck.ts:498`、`usePreparation.ts:187`）。
- 開始の成功：`audio-conditions-changed`、`audio-started`、（応答）。開始の失敗：`audio-conditions-changed`、`audio-stopped`、（エラーの応答）。停止：`audio-conditions-changed`、`audio-stopped`、（応答）。
- **旧の通知は、コマンドの応答より前に `emit` される**（reader が `Response` を待ち手へ渡す前に、同じスレッドが先に `Event` の行を読んで `emit` する。子が `Event` を `Response` より前に出すため）。WebView が両者をどの順に受け取るかは確かめていない。
- 古い接続の通知：`engine_event(epoch, …)` は、`epoch` が現在と違えば偽を返し、`continue` する。したがって古い `Started`・`Stopped`・`Error` は `emit` されない。ただし、`LevelMeter`・`Loudness`・`ChannelLevels`・`VoiceCheck*`・`EditorOpened/Closed`・`ProcessingHealth`・`ControlStall` は、**`reader_active` が真のあいだは epoch を見ずに `emit` される**（旧 reader が終われば止まる）。
- `audio-stream-error` の文字列は、自動の再開が `Stream Error` を含むかで判定している（`hooks/useAudioRecovery.ts:29`）。文字列は契約。

### 意図した終了の通知

| 経路 | 通知 |
|---|---|
| `stop_audio`（接続あり） | `audio-conditions-changed`、`audio-stopped`（子から） |
| `stop_audio`（接続なし） | `audio-conditions-changed` のみ（`kill_engine` の `retire_engine`）。`audio-stopped` は出ない |
| `restart_audio_engine`／`prepare_update`／`kill_engine` | `audio-conditions-changed` のみ。`audio-engine-exited`・`audio-error` は出ない（`reader_active` を先に偽にするため） |
| アプリの終了（`Drop`） | 何も出さない |
| 異常終了（EOF） | 上の `audio-error` の (a) |

## 6. メーター

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| イベント名 | `audio-level` | `audio.rs:863-876` | 変えない | 変えない |
| 形 | `{ input: [f32, f32], output: [f32, f32], stream_generation?: "e:c" }`。`input`・`output` はペイロードの最上位（`flatten`）。`stream_generation` は `None` のとき出力しない | `audio.rs:111-117`、`ipc.rs:880-910` | 変えない | 任意の項目 `seq` を足してよい |
| 子から親の形 | `{"type":"LevelMeter","payload":{"input":[..],"output":[..],"stream_generation":N}}`（#827 で、仕様書の記述が食い違っている） | `ipc.rs:905-910`、`:951-975` | 変えない | 仕様書は別の課題（J-6） |
| 頻度・間引き | 子が約16ms ごとに、ピークの最大値にまとめて送る。無音（すべてゼロ）が続くときは、最初の1回だけ送る。データが75ms 来ないときのゼロは1回だけ | `core.rs:790-810`、`core/meter.rs:35-58` | 変えない | 変えない |
| 値の範囲 | `0.0..=10.0` に clamp | `core/meter.rs:36-37` | 変えない | 変えない |
| 番号 | 最後に始めた試行の番号（失敗した試行のこともある）。ラベルの接続の部分は reader が起動時に持った `engine_generation` | `core.rs:806-809`、`audio.rs:868-871` | 変えない | 変えない |
| 古い接続のメーター | `reader_active` が真のあいだは、epoch を見ずに `emit`（旧 reader は `reader_active` が偽になると止まる） | `audio.rs:789-792` | 変えない | 世代で捨てる（新しい契約） |
| 失敗 | `emit` のエラーはログのみ | `audio.rs:873-875` | 変えない | 変えない |

## 7. 子（sidecar）の IPC の契約（互換に関わるもの）

| 項目 | 事実 | 根拠 |
|---|---|---|
| 形式 | 1行1メッセージ。`IPC:` で始まる行を JSON として解釈する。`OutputMessage::{Response, Event}`（`kind`/`data` のタグ） | `audio.rs:800-803`、`ipc.rs:1077-1082` |
| 順序 | 子が出す順に、親の reader が読む。1接続で1本 | `audio.rs:789-1040` |
| 直列 | 要求 ID なし。応答は要求の順。親は同時に1要求しか送らない | `audio/replies.rs`、F-2 |
| `Start` の成功 | `Event::Started` → `Response::Started`（`routing`、`input_id`、`output_id`、`stream_generation` つき） | `core/startup.rs:2259`、`core/commands.rs:603-621` |
| `Start` の失敗 | `Event::Stopped` → `Response::Error` | `core.rs:1328-1334`、`core/commands.rs:623` |
| `Stop` | `Event::Stopped` → `Response::Success`。動いていなくても同じ | `core.rs:1421-1429` |
| 番号 | 子が試行ごとに振る。`Started`・`LevelMeter`・`Stopped`・`Response::Started` に付く。`Error` には付かない | `core/stream_generation.rs`、`ipc.rs:887-930` |
| stdin の EOF | 子は `Shutdown` として終了する | `core.rs:602-630` |

## 8. F1a で変えないものと、F1b で変える候補

### 8.1 F1a で変えないもの（互換の試験で固定する）

1. 1〜7章の「F1a：変えない」のすべて。
2. 旧の通知の名前・ペイロード・`emit` の順序（特に `audio-conditions-changed` が先）。
3. 通知がコマンドの応答の前に `emit` される順序（コード上の順序）。
4. 意図した終了で `audio-engine-exited`・`audio-error` を出さないこと。
5. `localize_audio_error` の包み方（start／restart だけ）。`stop_audio` を包まないこと。
6. `expectedState` の完全一致の規則と、エラーの文字列。
7. 子を起動する／しない（4章）。
8. 保存の副作用（成功のたびに `last_audio_config.json` を書く。失敗はログだけ）。
9. 10秒の期限と、タイムアウト後の「応答待ち」の拒否の文言。

### 8.2 F1b で安全のために変える候補（個別に承認する差分）

| # | 変更 | 影響する利用者の挙動 | 承認の観点 |
|---|---|---|---|
| D-1 | 開始のタイムアウトの後に、清掃の `Stop` を送り、応答がなければ接続を隔離する | タイムアウト後に、音声が止まる（今は遅れて動き出す）。隔離すると VST が失われる | 音が出続ける窓と VST の保持のどちらを優先するか（J-4） |
| D-2 | `is_running` を、終了の確定後に `false` にする | EOF で死んだ後の表示が、すぐ正しくなる | 旧フロントが `is_running` に頼る箇所（`usePlugins.ts:370`、`:440` など）の確認 |
| D-3 | `Start` の期限を延ばす（任意） | 遅い機器での失敗が減る。失敗の表示が遅れる | 利用者の体験 |
| D-4 | 保存の失敗の注記を、開始の応答の任意の項目に足す | 今はログだけ。追加の項目は旧フロントが無視する | 旧フロントの型（追加の項目が許されるか） |
| D-5 | 子のエラーのコールバックを、atomic の印だけにし、番号つきの通知は制御ループから出す | 旧の `audio-stream-error` の出るタイミングが、わずかに遅れる可能性 | RT の試験。文字列（`Stream Error`）は保つ |
| D-6 | 古い接続の `LevelMeter`・`Loudness` などを、世代で捨てる | 旧 reader の遅れた値が出なくなる | 影響は小さい |
| D-7 | `Stop` の応答待ちで子が応答しないときの隔離 | 今は10秒で失敗するだけ | D-1 と同じ観点 |

## 9. 確かめていないこと

- 旧の通知とコマンドの応答が、WebView に届く順序（`emit` の呼び出しの順序だけを確かめた）。互換の試験で実測する。
- `get_audio_state` を、ロックを待たない形にしたときの、フロントの2秒ごとの照合への影響。
- 子の `Stop` が、ストリームを実際に止める時間（フェードの待ち）。
- `stop_audio` の `Pending` が落ちるタイミングで進む `revision` が、witness の照合に与える影響の細部。

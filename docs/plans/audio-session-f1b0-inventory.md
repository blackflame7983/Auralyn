# F1b-0 設計の前に確かめた、今のコードの事実（洗い出し）

- 対象：`292dfdb2`（main。F1a-0・F1a-1 はマージ済み）。ブランチ `codex/audio-session-f1b0-design`。
- この文書は事実だけを書く。設計案・改善案は書かない（気づいたことは 8 章に、事実として不安な点だけを分けて書く）。
- 行は `292dfdb2` の時点。パスは `src-tauri/src/` からの相対（例：`audio.rs:1189` は `src-tauri/src/audio.rs` の1189行）。`tests/` は `src-tauri/tests/`。
- 「推測」と書いたものは、コードを読んだだけでは確かめきれていない。実行して確かめたものはない（この文書の作成では製品のコード・試験を動かしていない）。
- 背景の文書（`docs/plans/audio-session-controller.md` の 3・4・13・18.2 の PRE-F1b-12、`audio-session-compat-contract.md`、`audio-session-acceptance.md`）は「計画」であり、今のコードの証拠として扱っていない。計画の言葉（K 群の行 ID など）は、試験の対応を示すために引用するだけ。

用語：

| 語 | 意味 |
|---|---|
| IPC 1回 | 子（`audio_engine` サイドカー）への命令1件。書き込み→応答待ち（上限10秒、`audio.rs:1189`）。 |
| ホストのロック | `AudioControl` が持つ `Arc<Mutex<AudioHost>>`（`audio/control.rs:173-176`）。 |
| 主 / 配信ミックスの子 | 主の `AudioHost`（アプリに1つ）/ その `post_mix` が持つ第2の `AudioHost`（`audio/post_mix.rs:276`、`audio/control.rs:256-260`）。 |
| 「E」 | `AudioHost::execute_command`（`audio.rs:1091-1131`）を通る命令。 |
| 「R」 | `AudioHost::execute_running_command`（`audio.rs:1134-1146`）だけを通る命令（子を起動しない・`sync_live_modes` を呼ばない）。 |

---

## 1. 入口の一覧

### 1.1 入口の共通の事実

1. すべての入口は `AudioControl::lock(Entry)` か `admit(Entry).lock()` を通る（`audio/control.rs:212-223`）。`AudioControl` の `host` フィールドは非公開（`audio/control.rs:173-176`）。ロックを取らない入口は `note(Entry)` だけ（`audio/control.rs:226-228`）。試験 `audio/tests/control_tests.rs:189`（`the_post_mix_child_host_is_built_only_through_the_control_module`）が、配信ミックスの子の作成が `control.rs` だけを通ることを固定している。
2. `Entry` は `EntryKind`（12種：`Command`・`Bundle`・`Startup`・`Warmup`・`Scheduler`・`Tray`・`Shortcut`・`Update`・`Migration`・`TemporarySession`・`Obs`・`Quit`、`audio/control.rs:14-27`）と名前を持つ（`audio/control.rs:32-35`）。
3. 受付の記録 `Admission` は、採番とログ追記を同じ葉のロックの中で行う（`audio/control.rs:97-116`）。ログは最大256件（`audio/control.rs:62`）。`Scheduler` は件数だけ増やし、ログにも `LockGranted` にも残さない（`audio/control.rs:102-104`、`138-141`）。記録は並べ替えにも勝敗にも使われない（`audio/control.rs:1-4`）。
4. ロックの待ち順は `Mutex` が決める。`Ticket::lock` は `self.control.host.lock()` を呼んで、取れた後に `LockGranted` を記録する（`audio/control.rs:248-252`）。ロックの種類・保持の長さ・実行スレッドは F1a で変えていない（`audio/control.rs:1-4`）。
5. 入口の数（`Entry::command`／`Entry::bundle`／`Entry::new` の呼び出し箇所を grep した集計）：ロックを取る箇所 95、`note` 1（`quit_app`、`lib.rs:76`）。
   - コマンド（`Entry::command`）：呼び出し箇所 70、名前は 67 種（`commands/audio.rs` 59 箇所・56 種、`commands/profiles.rs` 3、`commands/voice_check.rs` 8）。
   - 配信セット（`Entry::bundle`）：13 箇所、名前は 5 種（`broadcast_bundle`×8・`apply_owned`×2・`capture_async`・`undo_owned`・`validate_checked`、`commands/bundles.rs:581,1988,2090,2111,2363,2386,2475,2493,2557,2565,2723,2796,2876`）。
   - コマンド以外：ロックを取る 12 箇所（トレイ 1、起動 1、warmup 1、スケジューラ 1、OBS 2、ショートカット 1、更新 2、移行 1、一時利用 2）＋ `note` 1。
   - 合計：70＋13＋12＝ 95（`note` を除く）。`Entry` の名前は 85 種（コマンド 67・配信セット 5・コマンド以外 12・`quit_app`）。
6. エラーの文言のうち、ロックの失敗（`PoisonError`）の写し方は入口ごとに違う（1.7 の表）。試験 `commands/audio/compat_tests.rs:446`（`lock_failure_texts_are_fixed`）は、`start_audio`・`get_audio_state`・`get_saved_audio_config` の3つだけを固定している。

### 1.2 ロックを取る呼び出し元のスレッド

| 呼び出し元 | スレッド | 根拠 |
|---|---|---|
| Tauri の `async fn` コマンド（`run_blocking` を使う） | tokio のブロッキングスレッド（`tauri::async_runtime::spawn_blocking`）。`async` の部分は tokio のワーカー | `commands/mod.rs:7-13` |
| `set_loudness_measurement`・`set_output_gain`・`auto_gain`・`probe_loopback` | 同じブロッキングプール（`tauri::async_runtime::spawn_blocking` を直接呼ぶ）。エラーの写し方だけ違う（`.map_err(\|e\| e.to_string())?`） | `commands/audio.rs:1019,1035,1051,1196` |
| `enumerate_devices_async`（`get_audio_devices`・`apply_profile`・`restore_backup_profile`・`broadcast_bundle` から） | 手順ごとに別の `run_blocking`（Begin・Poll×N・Cancel）。Poll の間は tokio の `sleep(100ms)` | `commands/audio.rs:187-245` |
| 起動の設定の `set_event_emitter` | Tauri の `setup` クロージャ（アプリの主スレッド。Tauri の仕様から。推測） | `lib.rs:389-394` |
| warmup | `std::thread::spawn` した専用スレッド（1本、1回） | `lib.rs:397-407` |
| モード VST のスケジューラ | `thread::spawn` した専用スレッド（1本、`loop`） | `audio/control.rs:231-240` |
| トレイの「ミュート切替」 | メニューのイベントのコールバック。スレッドはコードから読み取れない（Tauri のイベントループのスレッド。推測） | `lib.rs:353-362` |
| `quit_app`（`note` のみ） | 同期コマンド（Tauri は主スレッドで実行。推測） | `lib.rs:72-79` |
| グローバルショートカット | `dispatch`（OS 通知のコールバック）が `spawn_blocking` に渡し、そこで `lock` | `shortcuts.rs:384-419`、`421-427` |
| 更新（`install_update`） | `spawn_blocking`。`prepare_update` のロックと `finish_update_attempt` のロックは別（`install` はロックの外） | `updates.rs:162-186` |
| 設定の移行（`apply_settings`） | `spawn_blocking` | `migration.rs:473-503` |
| 一時利用（`acknowledge_session_review`・`restart_temporary_session`） | `run_blocking` | `temporary_session.rs:209-222`、`284-347` |
| OBS の到達確認（`play`・`stop`） | `tokio::task::spawn_blocking` | `obs.rs:49-62`、`68-81` |

`Quit`・`Startup`・`Tray`・`Warmup`・`Scheduler`・`Shortcut`・`Update`・`Migration`・`TemporarySession`・`Obs` の各 `EntryKind` は上の表の呼び出し元が使う（`lib.rs:76,357,389,400`、`audio/control.rs:236`、`shortcuts.rs:423`、`updates.rs:166,177`、`migration.rs:476`、`temporary_session.rs:211,286`、`obs.rs:51,70`）。

### 1.3 ロックを持つ間に行うことの共通部品

下の表の「手順」は、各入口の欄で参照する。

| 手順 | 内容 | 待ちの上限・I/O | 根拠 |
|---|---|---|---|
| E（`execute_command`） | `guard_mode_vst`（VST 切替の最中・復旧待ちなら拒否）→ `frontend_bootstrap.cancel`（状態を変える命令のとき）→ `ensure_engine_running`（子が居なければ起動）→ `sync_live_modes`（`needs_sync` なら `ConfigureLiveModes`、`target` があれば `LiveMode`）→ `guard_live_command` → R | IPC 最大 1＋同期 最大2。子が居ないとき、起動の待ち（下）と引き継ぎ IPC 最大2を足す | `audio.rs:1091-1131`、`audio/live_modes.rs:84-124` |
| R（`execute_running_command`） | `Conditions::dispatch`で包んだ `execute_running_command_inner`：`reader_active` を確認 → `ReplySlot::begin` → `vst_operations.begin` → JSON を書いて `flush` → `recv_timeout(10秒)` | IPC 1（最大10秒＋書き込みの待ち（上限なし）） | `audio.rs:1134-1194` |
| 起動（`ensure_engine_running`） | `guard_mode_vst`・`maintenance` の確認 → 既存の子の `try_wait` → `retired.ensure_clear`（記録の子の終了を、最初の `kill` から10秒の期限まで確かめる）→ `conditions.new_engine` と通知 → 子の生成・Job への割り当て・再開 → reader の起動 → 引き継ぎ IPC（ピーク保護・true-peak。保存の意図があるときだけ最大2回） | `ensure_clear` は最大10秒／記録（`audio/engine_life.rs:34,128-144,172-189`）。割り当ての失敗時 `retire_child` 最大2秒（`engine_life.rs:30,238-256`）。IPC 最大2 | `audio.rs:730-1089` |
| `kill_engine` | 配信ミックスの子を `kill_engine`（最大2秒）→ 主の `kill_primary_engine`（`retire_child` 最大2秒）。`audio-conditions-changed`・（保護が有効なら）`live-modes-invalidated`を出す | 最大 約4秒（確認できない子は記録へ移る） | `audio.rs:2789-2823`、`audio/post_mix.rs:637-653` |

### 1.4 入口の一覧：コマンド以外（ロックを取る 12 箇所＋ `note` 1）

「手順」の欄の E・R・起動・`kill_engine` は 1.3 のとおり。「中断の確認」は、`bundle_interrupt`（`interrupt_restore` の数との照合、`validate_bundle_connection`、`audio.rs:2318-2331`）などの確認があるか。

| Entry（`kind`・名前） | 呼び出し箇所 | 保持の間に行うこと | emit | 複数手順 | 中断の確認 | エラーの文言 |
|---|---|---|---|---|---|---|
| `Startup` `set_event_emitter` | `lib.rs:389-394` | `*self.emitter.lock().unwrap() = Some(..)` だけ（`audio.rs:568-570`）。I/O・IPC なし | なし | いいえ | なし | ロックの失敗は無視（`if let Ok`） |
| `Warmup` `warmup` | `lib.rs:398-407`（専用スレッド） | `warmup()`（`audio.rs:2825-2916`）。`frontend_seen` なら即戻る。そうでなければ `prepare_warmup`（`frontend_bootstrap.rs:133-168`：既存の子があれば `auto_gain(Status)` 1回、`ensure_engine_running`）→ `last_audio_config.json` を読む（`audio.rs:2851-2852`）→ `start_internal_guarded_with_ids`（`audio.rs:2881-2892`、Start の全手順は 1.5 の `start_audio`） | 起動・Start の中で（4 章） | はい（起動→設定読み→Start） | `frontend_bootstrap.canceled` を先頭で確認（`frontend_bootstrap.rs:137`）。実行中の取り消しはなし | `log::warn` だけ（結果は `frontend_bootstrap.warmup_error` に日本語の固定文。`audio.rs:2903`） |
| `Scheduler` `poll_mode_vst` | `audio/control.rs:236-238`（10ms 周期） | `poll_mode_vst`（`audio/mode_vst.rs:526-643`）。トランザクションがなければ `poll_orphan_mode_disk`（`try_recv`）だけで戻る。ある間は1 tick に1段（応答の `try_recv`、次の命令の組み立て、`send_mode_command`）。完了で `remove_file`（`mode_vst.rs:805`）、失敗で `kill_engine`（`mode_vst.rs:797,808`）。`MonitorConfigure` は `live_output.json` を読む（`mode_vst.rs:937-941`） | `live-modes-invalidated`・`session-rack-*`・`audio-conditions-changed`（4 章） | はい（段の列を tick ごとに進める） | 取り消しは `cancel_mode_vst`（停止・緊急ミュートが行う）。世代の変化・120秒・10秒は tick で確認（`mode_vst.rs:531,539,553,573`） | トランザクションの `status.error` に日本語の固定文 |
| `Tray` `mute_toggle` | `lib.rs:353-361` | `toggle_global_mute`（`audio.rs:1916-1919`）→ `set_global_mute`（`audio.rs:1889-1914`）：E の `SetGlobalMute` 1回。VST 切替中（`blocked`）は `cancel_mode_vst`＋`kill_engine`（IPC なし） | `global-mute-changed`（`audio.rs:1897,1907`） | いいえ | `interrupt_restore` を**取らない**（`lib.rs:355-360`） | 結果は捨てる（`let _ =`） |
| `Quit` `quit_app`（`note`） | `lib.rs:72-79` | ロックを取らない。記録だけ | なし | — | — | — |
| `Shortcut` `global_shortcut` | `shortcuts.rs:418-536` | ロックを取った後、**`gate` の Mutex を保持したまま**（`shortcuts.rs:430-436`）動作を行う。動作ごとに：歌・雑談 `live_modes` 2回（Snapshot→On。`shortcuts.rs:443,454`）／ミュート ＝ E 1／比較（バイパス）`auto_gain(Status)` 1（`get_state` で動いているときだけ）＋ `get_engine_runtime_stats` 1（トグルのとき）＋ `set_global_bypass` 1／ノイズ `get_engine_runtime_stats` 1＋ `set_noise_control_config` 1／音量 `auto_gain(Status)` 1＋ `set_output_gain`（1.5 の `set_output_gain` の行：1＋最大100回の `Status`）＋ `shortcut_gain_intent`（`Status` 1） | `shortcut-noise-toggled`・`shortcut-stopped-gain`・`shortcut-output-gain`を**ロックの中で** `app.emit`（`shortcuts.rs:502,518,521`）。`shortcut-error`はロックの外（`shortcuts.rs:534`） | 音量・ノイズははい | `gate.permits` と歌・雑談の `intent_sequence` を取得後に確認（`shortcuts.rs:434-441`）。それ以降の確認はなし | `ShortcutError`（型付き）か `ActionFailed{detail: error.to_string()}`（`shortcuts.rs:527-534`）。`localize_audio_error` は通らない |
| `Update` `prepare_update` | `updates.rs:165-172` | `prepare_update`（`audio.rs:2770-2783`）：`check_can_interrupt`（`auto_gain(Status)` 1、`audio.rs:2748-2768`）→ 子があれば `stop()`（主 Stop 1＋配信ミックス Stop 1）→ `kill_engine`（最大4秒）→ `retired.recheck`（待たない）。`install` はロックの外 | `audio-conditions-changed`・`audio-stopped`など | はい | なし（`check_can_interrupt` は録音・試聴の確認で、停止要求の確認ではない） | `e.to_string()`（日本語の固定文または子のエラー）。`update.install` の失敗は日本語に包む（`updates.rs:174-176`） |
| `Update` `finish_update_attempt` | `updates.rs:177-182` | `maintenance = false` だけ | なし | いいえ | なし | ロックの失敗は無視 |
| `Migration` `apply_migration` | `migration.rs:475-499` | `check_can_interrupt`（IPC 1）→ `snapshot`（設定ファイル群の読み取り）→ `write_json`（`sync_all` つき、`migration.rs:305-327`）→ `prepare_update`（IPC 約3＋ `kill_engine`）→ `apply_files`（複数ファイルの置き換え。失敗なら逆向きの `apply_files`）。**ファイル I/O の全体をロックの中で行う** | なし（`prepare_update` の中の分） | はい | なし | `e.to_string()`／日本語の固定文 |
| `TemporarySession` `acknowledge_session_review` | `temporary_session.rs:210-221` | `auto_gain(Status)` 1。その後 `acknowledge`（マーカーの削除）はロックの外 | なし | いいえ | なし | 日本語の固定文 |
| `TemporarySession` `switch_session` | `temporary_session.rs:285-345` | `preflight_live_changes` →（`preserve_runtime` のとき）`preserve_temporary_runtime`（`commands/bundles.rs:1301-1390`：`preflight_runtime_checkpoint`（IPC 約3）、`capture`×2（それぞれ IPC 約5、ミックスありなら＋最大34）、原本の保存ファイル I/O）→ `prepare_update` → マーカーの書き込み・`Command::spawn`（新しい Auralyn）→ `drop(audio)` → `app.exit(0)` | なし | はい | `witness.validate`（`conditions` の版の照合。`interrupt_restore` の数ではない） | `e.to_string()`／日本語の固定文 |
| `Obs` `play` | `obs.rs:49-61` | `begin_obs_reach_tone`（`audio.rs:2532-2545`）：`conditions.snapshot` 確認 → `guard_live_command` → R の `PlayTestTone` 1 → `snapshot`。`get_state` | なし | いいえ | `Witness` の照合（`audio.rs:2533`） | `e.to_string()`／日本語の固定文。ロックの失敗は `音声状態を取得できません` |
| `Obs` `stop` | `obs.rs:68-80` | `finish_obs_reach_tone`（`audio.rs:2547-2557`）：`witness.validate` → R の `StopTestTone` 1 → `snapshot` | なし | いいえ | `Witness` の照合 | 同上 |

### 1.5 入口の一覧：コマンド 67 種

以降、IPC の数は「正常系で最大の数」（「条件つき」は括弧）。上限は IPC 1回＝10秒の積み上げ（実測ではない）。E に付く「同期（0〜2）」「起動（0〜）」は 1.3 の手順の追加分。ロックの失敗の文言は 1.7 を参照。

**A. IPC なし（ロックを待って読み取る）**

| 名前 | 行 | 保持の間に行うこと | 中断の確認 |
|---|---|---|---|
| `get_audio_state` | `commands/audio.rs:294-305` | `get_state`（`child.is_some`・`active_config`・`conditions.snapshot`、`audio.rs:2923-2936`）。IPC・I/O なし | なし |
| `get_saved_audio_config` | `commands/audio.rs:279-291` | `last_audio_config.json` を直接読む（`audio.rs:2939-2949`）。ファイルの読み取り1回 | なし |
| `get_engine_tuning_config` | `commands/audio.rs:308-319` | 構造体のコピー（`audio.rs:2631-2633`） | なし |
| `set_engine_tuning_config` | `commands/audio.rs:322-335` | 構造体を書き換える（`audio.rs:2622-2629`）。次の子の起動の環境変数だけに効く（`audio.rs:582-622`） | なし |
| `get_routing_diagnostics` | `commands/audio.rs:1212-1224` | `get_state` ＋ `routing_diag::collect_routing_diagnostics`（OS の音声機器の列挙。内容と所要時間は未確認）をロックの中で実行 | なし |
| `get_process_input_sources` | `commands/audio.rs:1392-1400` | `process_input_sources`（`process_capture::candidates()`：OS のプロセス列挙。最大256件、`audio/process_inputs.rs:22-58`） | なし |
| `preflight_live_changes` | `commands/audio.rs:1242-1254` | 子が居ないとき `invalidate_live_protection`（`live-modes-invalidated`を出しうる）→ `armed` を確認（`audio/live_modes.rs:163-170`） | なし |
| `begin_live_changes` | `commands/audio.rs:1257-1269` | `frontend_bootstrap.cancel`・`preflight`・予約の登録（`audio/live_modes.rs:244-266`） | なし |
| `end_live_changes` | `commands/audio.rs:1271-1284` | 予約の解除（`audio/live_modes.rs:267-283`） | なし |

**B. R の IPC 1回（子を起動しない・同期しない）**

| 名前 | 行 | 保持の間に行うこと | emit |
|---|---|---|---|
| `peak_protection` | `commands/audio.rs:115-128` | R 1（`audio.rs:395-409`）。設定ありなら `peak_intent` を更新 | なし |
| `broadcast_true_peak` | `commands/audio.rs:131-144` | R 1（`audio.rs:410-424`） | なし |
| `get_plugin_state` | `commands/audio.rs:818-830` | R 1（`audio.rs:2365-2372`）。VST の状態の取得 | なし |
| `noise_measurement` | `commands/audio.rs:1287-1300` | R 1（`audio.rs:1937-1946`） | なし |
| `get_engine_runtime_stats` | `commands/audio.rs:338-349` | `try_wait` → R 1（`audio.rs:2635-2746`）。終了済みなら `kill_engine` | 終了済みなら `audio-conditions-changed` |
| `get_output_gain_observation` | `commands/audio.rs:248-260` | `auto_gain(Status)`＝ R 1（`audio/frontend_bootstrap.rs:112-120`、`audio.rs:2180-2195`） | なし |

**C. E の IPC 1回（子が居なければ起動する・同期する）**

`load_plugin`（`commands/audio.rs:557-571`、`audio.rs:1767-1793`）、`reorder_plugins`（`589-601`、`1832-1838`）、`set_bypass`（`604-617`、`1840-1849`）、`set_mute`（`620-633`、`1851-1860`）、`set_gain`（`651-664`、`1862-1871`）、`resume_plugin`（`636-648`、`1873-1879`）、`open_editor`（`803-815`、`1881-1887`）、`set_plugin_state`（`833-847`、`2374-2383`）、`set_input_gain`（`883-895`、`1921-1927`）、`set_noise_reduction`（`898-912`、`1929-1935`）、`start_noise_learning`（`915-928`、`1948-1954`）、`cancel_noise_learning`（`931-942`、`1956-1962`）、`set_noise_control_config`（`945-968`、`1964-1984`。`require_running` のときは起動せず `execute_command_if_running`、`audio/engine_exit.rs:215-262`）、`set_built_in_effects`（`971-994`、`2030-2053`。`require_running` は同上、`engine_exit.rs:264-288`）、`set_input_channels`（`1077-1091`、`2229-2235`）、`set_channel_scan`（`1094-1106`、`2392-2398`）、`play_test_tone`（`1109-1128`、`2518-2528`）、`stop_test_tone`（`1131-1140`、`2559-2565`）、`measure_round_trip`・`cancel_round_trip_measurement`・`get_round_trip_measurement`（`1143-1184`、`2567-2595`）、`probe_loopback`（`1187-1209`、`2597-2620`。子が `duration_ms`（既定1500ms）だけ処理して応答する。待ちは10秒まで）、`start_voice_check`（`voice_check.rs:62-75`、`audio.rs:2400-2409`）、`stop_voice_check`（`78-87`、`2480-2486`）、`play_voice_check`（`90-104`、`2488-2500`）、`stop_voice_check_playback`（`107-118`、`2502-2508`）、`export_voice_check`（`147-161`、`2510-2516`）、`export_voice_check_wav`（`121-144`：`rfd` のファイル選択を**ロックの外**で行い、選択後にロックして IPC 1）。

- 各コマンドの「保持の間に行うこと」：E（1.3）1回。応答の `Error` は `anyhow!` に包む。
- 追加の emit：`set_global_bypass` は成功後に `global-bypass-changed`（`audio.rs:2217-2220`）。
- 子が居ないときは起動の待ち（1.3）と引き継ぎ IPC が先に走る。

**D. 複数の手順を続けるコマンド**

| 名前 | 行 | 保持の間に行うこと（上限） | emit | 中断の確認 |
|---|---|---|---|---|
| `start_audio` | `commands/audio.rs:400-451`、`audio.rs:1496-1725` | `expectedState` の照合 → `resolve_input_source` → `start_with_input_source`（`require_explicit_start`）→ `start_internal_with_source`：入力元の確認、（非既定入力）`live_output.json` の読み取り、（非既定入力で動作中）`auto_gain(Status)` 1、起動（1.3）または既存の世代の検証、`sync_live_modes`（IPC 0〜2）、入力元の機能確認 1（条件つき）、機器 ID の機能確認 1（条件つき）、`LiveOutput` 1（保存構成があるとき）、`ModeMonitor` 復帰 1（上書きがあるとき）、`prepare_mixing_start`（IPC 0〜3）、`prepare_post_mix_start`（`PostMixPrepare` 1・配信ミックスの子の `Stop` 1＋`PostMixStart` 1・`PostMixStatus` 最大2秒の待ちループ＋ `sleep(10ms)`、`audio/post_mix_start.rs:19-70`）、`SetGlobalMute` 1（`initial_controls` なしのとき）、`Start` 1、不一致時の `Stop` 1＋取り消しの `Stop`・`Stop`・`PostMixClear` 各1、`last_audio_config.json` の保存（`sync_all` つき、`audio.rs:1692`、`migration.rs:305-327`）。正常系の最大：IPC 約19＋起動10秒＋ 2秒＋ 4秒（再起動のとき） | 4 章（開始の通知の列は `compat_tests.rs:58-75`） | `validate_start_generation`（世代）を各段で確認（`audio.rs:1573,1626,1642`）。`interrupt_restore` の数は `bundle_change_generation` があるときだけ（`audio.rs:1578`） |
| `restart_audio_engine` | `commands/audio.rs:667-729` | ロックの**前**にマイク許可の確認（`commands/audio.rs:692-698`）。ロック後 `preflight_live_changes` → `resolve_input_source` → `preserve_live_changes_for_restart` → `kill_engine`（最大4秒）→ `start_with_input_source`（上の `start_audio` と同じ） | 同上＋ `kill_engine` の通知 | 同上 |
| `stop_audio` | `commands/audio.rs:505-520` | **ロックを待つ前に** `interrupt_restore`（`Pending`）を取り、コマンドの終わりまで持つ（`commands/audio.rs:509`）。ロック後 `stop()`：主（`reap_confirmed_stopped_connection`、または R の `Stop` 1）→ 配信ミックスの子の `Stop` 1（`audio.rs:1742-1765`、`audio/post_mix.rs:658-677`） | `audio-stopped`（子から）・`audio-conditions-changed` | 取る側。この確認は他の操作が見る（K12） |
| `toggle_global_mute`・`set_global_mute` | `commands/audio.rs:850-880` | `interrupt_restore` を先に取る。E の `SetGlobalMute` 1（`audio.rs:1889-1919`） | `global-mute-changed` | 取る側 |
| `restore_plugin` | `commands/audio.rs:539-552`、`audio.rs:1795-1817` | `ensure_engine_running`（起動の待ち）→ R の `RestorePlugin` 1（`expires_at_ms` ＝現在＋8000ms を子へ渡す、`audio.rs:1811-1815`） | なし | `bundle_change_generation` があれば `validate_bundle_connection`（`audio.rs:1800`） |
| `remove_plugin` | `commands/audio.rs:574-586`、`audio.rs:1819-1830` | `sync_live_modes`（0〜2）＋ `guard_live_command` ＋ R の `UnloadPlugin` 1。起動しない | なし | なし |
| `session_rack` | `commands/audio.rs:523-536`、`audio/session_rack.rs:64-290` | 要求ごと：`Snapshot` ＝ R 1（`GetPluginRack`）、`Retain` ＝ R 1＋ `SetInputGain` 1、`Begin` ＝ R 1＋（子が居なければ起動）＋ `sync_live_modes`（0〜2）＋ `SetInputGain`・`SetOutputGain` 各1（予約の期限30秒、`session_rack.rs:223`）、`Add` ＝ `sync`（0〜2）＋ `RestoreSessionPlugin` 1、`Finish` | なし | `session_lease_current`（世代・期限・`reader_active`）を各段で確認 |
| `audio_frontend_bootstrap` | `commands/audio.rs:263-276`、`audio/frontend_bootstrap.rs:169-415` | `frontend_seen`／`canceled` なら即戻る。それ以外：`warmup_once`（Warmup と同じ）→ `auto_gain(Status)` 1 → 動作中で warmup が成功していれば `SetInputGain`・`SetOutputGain`・`SetInputChannels` 最大3 → 動作していなければ `start_internal_guarded_with_ids`（`initial_controls` つき。`SetGlobalMute` を送らない） | Start の分 | `frontend_bootstrap.canceled` を2回確認（`frontend_bootstrap.rs:182,246`）。`validate_start_generation`（`frontend_bootstrap.rs:318`） |
| `live_output` | `commands/audio.rs:147-160`、`audio.rs:425-503` | 設定なし：子が居なければ `live_output.json` を読むだけ、居れば R 1。設定あり：`preflight_proposal_apply` → `LiveOutput`（読み）E 1 →（経路が変わるとき）`preflight_live_changes` → `LiveOutput`（書き）E 1 → `live_output.pending.json` の書き込み・`rename`（`fsync` なし。`audio.rs:473-480`）。保存に失敗したら R の `LiveOutput` 1（巻き戻し） | なし（`command_changes` が真のとき `audio-conditions-changed` が前後に出る） | なし |
| `mixing` | `commands/audio.rs:163-176`、`audio/mixing.rs:146-391` | 要求ごと。`Reset`：`preflight`・（動作中なら）エンジンの `Snapshot` 1・（未接続なら `kill_engine`）・原本のバックアップのファイル I/O（`sync_all`×2、`mixing.rs:196-218`）・`apply_engine_mixing`（R 2）・`persist`（`sync_all`）。`Configure`：`preflight`・起動（1.3）・`apply_engine_mixing`（R 2）・`persist`。`Levels`：R 2＋ `persist`（失敗で `stop` と `kill_engine`）。`Reload`：R 3 まで。最後に `Snapshot` R 1 | `audio-conditions-changed`（`Configure` など） | `guard_mode_vst` のみ |
| `post_mix` | `commands/audio.rs:6-18`、`audio/post_mix.rs:781-989` | 配信ミックスの子 `AudioHost` へ。変更系は先に `preflight_live_changes` と `post_mix_stopped`（R 1）。`RestoreSaved`：`discard_child`（`kill_engine` 最大2秒）→ 子の起動（`ensure_engine_running`）→ `RestorePlugin`×最大32（1件ずつ R 1。`post_mix.rs:831-861`）→ 最後に `snapshot`（`ProcessingState` 1・`GetPluginRack` 1）＋ `PostMixStatus` 1。`Save`：`capture_bundle`（`GetPluginRack` 2＋ `GetPluginState`×最大32、`post_mix.rs:449-542`）＋ `persist`（ファイル I/O、`sync_all`、`post_mix.rs:351-382`） | なし（子 `AudioHost` の `emitter` は `None`、3.1） | `guard_mode_vst` のみ |
| `live_modes` | `commands/audio.rs:1227-1240`、`audio/live_modes.rs:290-435` | 要求ごと。`SingingOn`/`TalkOn`：`ensure_engine_running`・`sync_live_modes`（0〜2）・`live_modes(Snapshot)` 再帰 R 1・E の `LiveMode` 1。VST 紐づけがあるとき `begin_mode_vst`（`audio/mode_vst.rs:336-401`：プロファイルのファイル読み取り＋トランザクションの登録だけ。以降はスケジューラが進める）。`Save`：`write_json`（`sync_all`）＋ `sync_live_modes` ＋ Snapshot | `live-modes-invalidated`・`session-rack-change-started`など | `guard_live_reservation`（復元の予約中は拒否、`live_modes.rs:200-211`） |
| `builtin_effects` | `commands/audio.rs:997-1011`、`audio.rs:2055-2088` | `Snapshot`＝ R 1／`ApplyProposal`・`Undo`・`Redo`＝ `preflight_proposal_apply`・`reap_confirmed_stopped_connection`・`sync_live_modes`・R 1／その他＝ E 1。`require_running` のときは `builtin_effects_routed`（`engine_exit.rs:290-315`） | なし | なし |
| `set_loudness_measurement` | `commands/audio.rs:1014-1027`、`audio.rs:2090-2104` | `id` なし：`reap_confirmed_stopped_connection`＋ R 1。あり：E 1 | なし | なし |
| `set_output_gain` | `commands/audio.rs:1030-1043`、`audio.rs:2106-2131` | E の `SetOutputGain` 1 → **最大100回**（`for _ in 0..100`）：R の `auto_gain(Status)` 1（`audio.rs:2112`）＋ `thread::sleep(10ms)`（`audio.rs:2122`）。`settled || !running` で抜ける。上限：IPC 101回＋ 1秒の `sleep` | なし | なし |
| `auto_gain` | `commands/audio.rs:1046-1059`、`audio.rs:2133-2212` | `Status`・`UndoHistory`・`RedoHistory`・`Initialize`・`Cancel` ＝ R 1（起動しない）。それ以外（`Apply`・`Restore`・測定の開始など）＝ E 1。`Cancel` で接続が終了済みなら IPC なしで固定の値を返す（`audio.rs:2155-2179`） | なし | なし |
| `voice_check_preview` | `commands/voice_check.rs:10-23`、`audio.rs:2411-2449` | `Open` 以外で `reader_active` がなければ拒否。`HistoryStatus`＝ R 1。`PrepareProposal` など＝ `require_proposal_connection`（`try_wait`）→ R 1 → もう一度確認（`audio.rs:2438-2440,2468-2478`）。それ以外＝ E 1 | `ApplyNoise`など `command_changes` が真のとき `audio-conditions-changed` | 世代と `try_wait`（前後） |
| `analyze_voice_check` | `commands/voice_check.rs:164-214` | ロックの中で `get_state` ＋ `export_voice_check`×2（E 2。子が WAV を書く）。WAV の読み込み・解析はロックの**外** | なし | なし |
| `enumerate_devices_async`（`get_audio_devices` ほか） | `commands/audio.rs:179-245` | **手順ごとに別のロック**：`begin_device_scan`（キャッシュがあれば IPC なし、なければ E の `BeginDeviceScan` 1）→ 100ms ごとに `poll_device_scan`（E の `PollDeviceScan` 1）→ 35秒で `cancel_device_scan`（E 1）。ロックはポーリングの間は手放す | `audio-conditions-changed`（子の起動時） | チケットの世代・トークンの照合（`audio.rs:1260-1265,1272-1293`） |
| `save_profile` | `commands/profiles.rs:51-115` | `capture_current_profile`（`get_engine_runtime_stats` 1 ほか）＋（ノイズ・内蔵 FX のとき）`get_engine_runtime_stats` 1 → `save_preset`（ファイル書き込み。ロックの中） | なし | なし |
| `apply_profile`・`restore_backup_profile` | `commands/profiles.rs:122-205` | ロックの外で `load_preset`（ファイル）と `enumerate_devices_async`。ロック後 `profile::apply_profile`（`profile.rs:225-499`）：`preflight` → バックアップ（`capture_profile_parts`：`get_engine_runtime_stats` 1 ほか＋ `save_preset`）→ `pre_stats`（R 1）→ `enumerate_devices(false)`（キャッシュのみ）→ 入出力が違えば `start_bundle`（再起動。IPC 約19＋ `kill_engine`）→ ノイズ（E 1）・内蔵 FX（E 1）の復元 → `set_input_gain`（E 1）・`set_output_gain`（E 1＋最大100回）→ ノイズ・FX（各 E 1）→ VST：再起動していなければ `unload_all_plugins`（最大32回 R 1）→ `load_plugin_chain`（最大32回 `restore_plugin`、`profile/plugin_chain.rs:34-62`）。上限：IPC 約160回（約1,600秒） | なし（内部の分） | `interrupt_restore` を**取らず**、途中の確認もしない（`bundle_change_generation` が無いため） |
| `broadcast_bundle` | `commands/bundles.rs:2008-2597` | 1.6 | 1.6 | 1.6 |

### 1.6 配信セット `broadcast_bundle`（`Entry::bundle`、13 箇所）と、続けて行う手順

- コマンドの入口：`commands/bundles.rs:2008-2014`。`state.0.lock().await`（`BundleState`、**tokio の `Mutex`**）を**コマンドの最後まで**持つ（`bundles.rs:2017`）。音声のロックはこの内側で、手順ごとに別の `run_blocking` で取り・手放す。
- 要求の種類と、音声のロックを取る回数（正常系）：

| 要求 | 音声のロックを取る手順（それぞれ別の `run_blocking`。`bundles.rs` の行） | 保持の間の IPC・I/O |
|---|---|---|
| `List`・`CheckedList`・`Sources`・`Filters`・`History`・`RecoveryStatus`・`RecoveryResolve` | 取らない（ファイル・OBS のみ。`bundles.rs:2019-2039`） | — |
| `Save` | `validate_checked`（`bundles.rs:571-606`，`Entry::bundle("validate_checked")`）0〜2回 → `capture_async`（`1985-1993`）→（process）`broadcast_bundle` 1 → （output）`broadcast_bundle` 1 → OBS の捕捉（ロックなし）→ `capture_async`（再取得）→ `validate_checked` | `capture`（`bundles.rs:1226-1298`）：`capture_bundle_state` 1、`capture_bundle_mixing`（ミックスありなら `GetPluginRack`×2＋`GetPluginState`×最大32、`audio/mixing_bundle.rs:156-191`、`audio/post_mix.rs:449-542`）、`capture_bundle_process`、`capture_bundle_output`（`LiveOutput` 1、`audio/output_bundle.rs:47-77`）、`capture_bundle_live`（`LiveMode` 1＋`ModeMonitor` 1＋ファイル読み取り、`audio/live_bundle.rs:41-103`）。上限：IPC 約5（ミックスありなら＋最大34）。`validate_checked`：`get_engine_runtime_stats` 1＋スナップショットの確認 |
| `Preview`・`RecoveryPreview` | `capture_async`、`enumerate_devices_async`（Begin・Poll×N。process・output・mixing のとき `force_refresh = true`） | `Save` と同じ |
| `Apply`・`RecoveryApply` | （runtime）`broadcast_bundle` 1（`bundles.rs:2361-2374`）→（確認つき・output・process）`broadcast_bundle` 1（`2384-2399`）→ `enumerate_devices_async` → `begin_live_changes`（`2473-2480`）→ `apply_owned`（下）→ `end_live_changes`（`2492-2498`） | 各ロックは `*_snapshot_supported`（`preflight_live_changes`＋`LiveOutput`/`ModeMonitor` などの R 数回） |
| `Undo` | `begin_live_changes`（`2555-2562`）→ `undo_owned`（下）→ `end_live_changes`（`2564-2570`） | 同上 |

- `apply_owned`（`bundles.rs:2600-2827`）：`capture_async`（ロック 1）→ OBS の捕捉（ロックなし）→ 原本のファイル保存（`bundle::save`、ロックなし）→ **`apply_host.lock(apply_owned)` の中で `witness.validate` → `bundle_change_scope` → `apply_selected`**（`bundles.rs:2721-2731`）→ `settle_capture`（最大40回 `capture_async`＋ tokio の `sleep(50ms)`、`bundles.rs:1994-2005`）→（OBS あれば）`conditions.snapshot`（ロック 1、`2794-2800`）→ OBS の適用（ロックなし）。
- `undo_owned`（`bundles.rs:2829-2929`）：`capture_async` → OBS の復元 → **`lock(undo_owned)` の中で `witness.validate` → `capture`（再取得）→ `bundle_change_scope` → `apply_selected` →（停止していたなら）`stop`**（`bundles.rs:2874-2891`）→ `settle_capture`。
- `bundle_change_scope`（`audio.rs:2333-2352`）：`bundle_change_generation`・`bundle_interrupt`（その時点の `interrupt_restore` の数）を登録し、`operation` の前後で `validate_bundle_connection`（`audio.rs:2318-2331`）を行う。
- `apply_selected`（`bundles.rs:1673-1834`）が続ける手順（ロックを持ったまま）：
  1. ミックスあり：`with_bundle_mixing`（`audio/mixing_bundle.rs:192-267`）：`capture_bundle_mixing` → `stop` → `apply_engine_mixing`（R 2）→ `post_mix.restore_bundle`（`audio/post_mix.rs:544-633`：バックアップの書き込み（`sync_all`×2）・配信ミックスの `stop`・`discard_child`・子の起動・`RestorePlugin`×最大32・`capture_bundle`）→ `stage_bundle_voice`（`audio/mixing_bundle.rs:92-155`：R 2・`unload_all_plugins`×最大32・`restore_plugin`×最大32・`capture_bundle_state`）。失敗時：`stop`／`kill_engine`・`post_mix.kill`・**`post_mix` と `mixing` の `State` を作り直す**（`mixing_bundle.rs:256-260`）。
  2. process：`process_bundle_scope`（`audio/process_bundle.rs:95-125`）→ `start_bundle_process`。
  3. 本番モードあり：`with_bundle_live`（`audio/live_bundle.rs:105-225`）：本番設定の書き込み → 操作 → `LiveMode` 1 → **最大100回**の確認ループ（各回 R 1〜2＋ `sleep(10ms)`、`live_bundle.rs:154-182`）→ `write_json`＋読み戻し（`live_bundle.rs:191-197`）。失敗時 `stop`／`kill_engine` と本番設定の再読み込み。
  4. 出力あり：`with_bundle_output`（`audio/output_bundle.rs:79-139`）→ `start_bundle_with_device_ids`（`audio.rs:2270-2316`：`preflight`・`ProcessingState` 1（準備済みのとき）または `kill_engine`・`start_internal_guarded_with_ids`）→ 準備済みなら `get_engine_runtime_stats`。
  5. `apply_selected_core`（`bundles.rs:1905-1961`）：`unload_all_plugins`（空の明示）→ `profile::apply_profile_with_start_intent_and_ids`（`profile.rs:225-499`、1.5 の `apply_profile` と同じ手順）→ `set_input_gain`・`set_output_gain`（最大 1＋ 1＋100）。
- 中断の確認：`validate_bundle_connection` が呼ばれる場所は、`execute_command`（`audio.rs:1109-1110`）・`start_internal_with_source`（`audio.rs:1578-1579`）・`restore_plugin`（`audio.rs:1800-1801`）・`start_bundle_with_device_ids`（`audio.rs:2286`）・`get_engine_runtime_stats`（`audio.rs:2636-2637,2651`）・`execute_command_if_running`（`audio/engine_exit.rs:220-221`）・`with_bundle_live`（`audio/live_bundle.rs:131,155`）・`process_bundle_scope`（`audio/process_bundle.rs:77,107`）・`bundle_change_scope` の前後（`audio.rs:2343,2346`）。**`execute_running_command` の中（`audio.rs:1134-1194`）・`remove_plugin`（`audio.rs:1819-1830`）・`set_output_gain` の確認ループ（`audio.rs:2111-2123`）・`post_mix` の子の命令（子 `AudioHost` には `bundle_change_generation` がない）には確認がない。**
- `interrupt_restore`（停止・ミュートの意図の登録）を**取る**のは、`stop_audio`・`toggle_global_mute`・`set_global_mute` の3コマンドだけ（`commands/audio.rs:509,854,871`）。トレイ・ショートカットのミュートは取らない（`lib.rs:355-360`、`shortcuts.rs:456-458`）。

### 1.7 エラーの文言（入口ごと）

| 入口 | 子・親のエラーの返し方 | ロックの失敗（`PoisonError`） |
|---|---|---|
| `start_audio` | 入力元の解決の失敗は `e.to_string()` をそのまま（`commands/audio.rs:431-433`）。`start_with_input_source` の失敗は `localize_audio_error`（`commands/audio.rs:446`）。`expectedState` の不一致は日本語の固定文・非 `localize`（`commands/audio.rs:453-467`） | `Failed to lock audio state`（`commands/audio.rs:427`） |
| `restart_audio_engine` | マイク許可の失敗は `localize`（`commands/audio.rs:696-697`）。`preflight_live_changes`・入力元の解決は生（`commands/audio.rs:703-707`）。開始は `localize`（`commands/audio.rs:724`） | `Failed to lock audio state` |
| `stop_audio` | 生（`commands/audio.rs:515`）。試験 `commands/audio/compat_tests.rs:432-442` | 同上 |
| `apply_profile`・`restore_backup_profile` | `profile::apply_profile` の `Result<_, String>`（内部で `e.to_string()`、`profile.rs:225-499`） | `Failed to lock audio state`（`commands/profiles.rs:65,149,192`） |
| 他の `commands/audio.rs`・`voice_check.rs` のコマンド | `e.to_string()`（生） | `Failed to lock audio state` |
| `peak_protection`・`broadcast_true_peak`・`live_output`・`mixing`・`live_modes`・`preflight_live_changes`・`begin_live_changes`・`end_live_changes`・`set_loudness_measurement`・`set_output_gain`・`auto_gain` | 生 | `音声状態を取得できません`（`commands/audio.rs:123,139,155,171,1021,1037,1053,1235,1249,1264,1279`） |
| `noise_measurement` | 生 | `音声の状態を取得できません`（`commands/audio.rs:1295`） |
| `get_saved_audio_config`・`get_process_input_sources` | 生 | `音声設定を取得できません`（`commands/audio.rs:286,1399`） |
| `post_mix` | 生 | `配信VSTの設定を取得できません`（`commands/audio.rs:13`） |
| `probe_loopback` | 生 | `Failed to lock audio state`（`commands/audio.rs:1199`） |
| `broadcast_bundle` | `String` の日本語の固定文・`e.to_string()`。結果は `ResultView` の文言（`set_auralyn`）にも入る | `音声状態を取得できません`（`commands/bundles.rs:582`ほか） |
| ショートカット | `ShortcutError`（型）または `ActionFailed{detail}`（`shortcuts.rs:527-534`） | `ShortcutError::AudioStateUnavailable`（`shortcuts.rs:427`） |
| 更新・移行・一時利用・OBS | `e.to_string()`／日本語の固定文 | `音声状態を取得できません`（`updates.rs:170`、`migration.rs:480`、`temporary_session.rs:215,290`、`obs.rs:52,71`） |
| トレイ・warmup | 捨てる／ログ（`lib.rs:359,404`） | 無視（`if let Ok`） |

- `localize_audio_error`（`audio.rs:3077-3119`）の写し方：`engine_unconfirmed` の2文（`engine_life.rs:40-43`）は日本語の最終の文言を返す。`sample clock or rate cannot be determined`・`device not found`・`access is denied`／`0x80070005`／`アクセスが拒否`・`stream configuration is not supported` は日本語の案内。それ以外は `オーディオエラーが発生しました。\n\n詳細: {e}` に包む（日本語の元の文も包む。試験 `commands/audio/compat_tests.rs:404-428`）。
- 子の応答がタイムアウトのとき：`Timeout or disconnect waiting for engine response: {e}`（`audio.rs:1193`）。タイムアウト後の次の要求：`前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。`（`audio/replies.rs:16-18`）。`reader` が終了済み：`音声エンジンとの通信が終了しました`（`audio.rs:1160`）。EOF で待ち手が解放されるとき：`Engine Crashed/Exited`（`audio.rs:1061`）。書き込みの失敗：`Stdin not available`（`audio.rs:1172`）または OS のエラー。
- `engine_unconfirmed`（`audio.rs:763` の `ensure_clear` から）は `anyhow` 経由でそのまま文を返す。`localize` を通る入口（`start_audio`・`restart_audio_engine`）と通らない入口（更新の `prepare_update` ほか）がある（`audio/tests/engine_life_tests.rs:249-272`）。

### 1.8 配信ミックスの第2の `AudioHost` を通る入口

- 子 `AudioHost` は `post_mix::State.child: Option<Box<AudioHost>>`（`audio/post_mix.rs:276`）。独自の `Mutex` は持たず、主のロックの内側でだけ動く（`audio/control.rs:255`）。作成は `post_mix::State::child()`（`post_mix.rs:386-401`）：`post_mix_child_host(root, retired)`（`audio/control.rs:256-260`、`post_role = true`）→ `ensure_engine_running`（子の起動：`--post-mix-worker`、`audio.rs:718-720`）。
- 子に触れる入口（すべて主のロックを持ったまま、同じスレッドで、同じ `execute_running_command` で子へ書く）：

| 入口 | 子へ行うこと | 根拠 |
|---|---|---|
| `post_mix` コマンド | `Enable`・`RestoreSaved`・`Add`・`Remove`・`Reorder`・`Bypass`・`Mute`・`Gain`・`Editor`・`Save`・`Reload`・`Reset`・`Snapshot`（1.5 D） | `audio/post_mix.rs:781-989` |
| `stop()`（`stop_audio`・`prepare_update` ほか） | 子へ `Stop` 1（失敗なら `kill_engine`） | `audio.rs:1742-1746`、`audio/post_mix.rs:658-677` |
| `kill_engine`（再起動・更新・EOF 後など） | `discard_child`（`child.kill_engine`） | `audio.rs:2789-2794`、`audio/post_mix.rs:637-653` |
| `start_internal_with_source` の `prepare_post_mix_start` | 主へ `PostMixPrepare` → 子へ `Stop`（動作中なら）＋ `PostMixStart` → 主へ `PostMixStatus`（最大2秒の待ち）。失敗時 `cancel_prepared_post_start`（主 `Stop`・子 `stop`・主 `PostMixClear`） | `audio/post_mix_start.rs:3-70`、`audio/post_mix.rs:678-717` |
| `capture_bundle_mixing`／`with_bundle_mixing` | `capture_bundle`・`restore_bundle`・`commit_bundle`・`State` の作り直し | `audio/mixing_bundle.rs:156-267`、`audio/post_mix.rs:449-642` |
| アプリの終了（`Drop`） | `take_children_for_shutdown` → 共通の2秒で `terminate_all` | `audio.rs:2952-2973`、`audio/post_mix.rs:641-645`、`audio/engine_life.rs:259-273` |

---

## 2. 子への書き込みと応答の待ち

### 2.1 書き込みと `flush` の場所（全経路）

書き込みの経路は2つだけ（`stdin` を使う箇所を `audio.rs`・`audio/` で grep：`audio.rs:1168-1174` と `audio/mode_vst.rs:646-666`。残りの出現は `None` への代入と試験）。

| 経路 | 書き込みを行うスレッド | 書き込み・`flush` | 上限 | 根拠 |
|---|---|---|---|---|
| 通常（E・R の全部。配信ミックスの子も同じ） | **呼び出したスレッド**（ロックを持ったまま） | `serde_json::to_string`（`audio.rs:1162`）→ `writeln!(stdin, "{}", json)` → `stdin.flush()`（`audio.rs:1169`）。`stdin` は `BufWriter<ChildStdin>`（`audio.rs:251,772`） | **書き込みの上限なし**（パイプが満杯でも戻らない。`BufWriter` の既定の容量を超える行は直接書く。std の仕様。推測） | `audio.rs:1168-1174` |
| モード VST の遷移 | 書き込み専用の使い捨てスレッド（命令ごとに `thread::spawn`）。JSON 化もそこで行う | `writeln!`＋`flush`（`audio/mode_vst.rs:656-667`）。`stdin` はスレッドへ `take` で移し、結果と一緒に戻す（`mode_vst.rs:646,666,546`） | 結果の受け取りは 10秒（`mode_vst.rs:552-553`）。超えたら遷移を失敗にして `kill_engine`（`mode_vst.rs:561,797`） | `audio/mode_vst.rs:644-673` |

- 書き込みの前の手順（通常の経路）：`guard_mode_vst` → `reader_active` の確認 → JSON 化 → `ReplySlot::begin` → `vst_operations.begin`（`audio.rs:1157-1167`）。
- 書き込みが失敗したとき（通常の経路）：`pending_reply_tx.cancel()` → `vst_operations.response(Error)` → **`kill_engine()`** → `audio-error`（`音声エンジンとの通信が切れました`）を emit → `io::Error` を返す（`audio.rs:1175-1187`）。応答は待たない。試験 `audio/tests/engine_life_tests.rs:230-247`（`w2_a_primary_write_failure_records_the_child_before_returning_the_original_error`：`Stdin not available`・記録・`audio-error`の名前）、`audio/engine_exit.rs:782`（`send_failure_clears_the_operation_and_retires_the_connection`）。
- 書き込み専用スレッドがある間、主の `stdin` は `None`（`mode_vst.rs:646`）。この間の通常の命令は `guard_mode_vst`（遷移中は拒否、`mode_vst.rs:244-247`）で止まるため `Stdin not available` にはならない。ただし `kill_primary_engine` は `stdin = None` にする（`audio.rs:2819`）。

### 2.2 応答の期限の値と起点

| 場所 | 値 | 起点 | 根拠 |
|---|---|---|---|
| 通常の命令の応答 | 10秒 | `writeln!`・`flush` が戻った後、`recv_timeout` を呼んだ時点（`begin` や JSON 化からは数えない） | `audio.rs:1189` |
| モード VST の遷移の1段 | 10秒（書き込み結果の待ち、応答の待ちの両方） | `send_mode_command` が `Pending` を作った時刻 `sent`（JSON 化・書き込みの時間を含む） | `audio/mode_vst.rs:553,573,671` |
| モード VST の遷移の全体 | 120秒 | トランザクションの `started` | `audio/mode_vst.rs:539` |
| `PostMixStatus` の準備待ち | 2秒（各回の IPC は別に最大10秒。ループ条件は各回の前に確認） | ループの開始 | `audio/post_mix_start.rs:52-53` |
| `set_output_gain` の反映待ち | 100回（各回 R 1＋ 10ms） | 最初の `SetOutputGain` の成功 | `audio.rs:2111-2123` |
| `with_bundle_live` の確認ループ | 100回（各回 R 1〜2＋ 10ms） | 操作の完了 | `audio/live_bundle.rs:154-182` |
| デバイスのスキャン | 35秒（`begin_device_scan` の古いチケット、`enumerate_devices_async` の期限） | `DeviceScanTicket.started` / 呼び出しの開始 | `audio.rs:1238`、`commands/audio.rs:204` |
| `session_rack` の予約 | 30秒（作成時・`Add` の成功ごとに更新） | `Instant::now()` | `audio/session_rack.rs:223,284` |
| VST 復元の期限 | 8,000ms（`expires_at_ms`＝ `unix_ms()` ＋ 8000。子へ絶対時刻で渡す。親の待ち（10秒）とは別） | 親が命令を組み立てた時刻 | `audio.rs:1814`、`audio/post_mix.rs:600`、`audio/mode_vst.rs:899-900`、`audio/session_rack.rs:258-259` |
| 子の終了の確認 | 50ms ごと（`POLL`）、`kill` 後 2秒（`CONFIRM`）、記録の子 2秒ごとに `kill` をやり直し（`RETRY_KILL`）、作り直しの要求は最初の `kill` から10秒（`DEADLINE`）、3回目で文言が変わる（`REPEAT_AT`）、アプリの終了 2秒（`SHUTDOWN`） | `retire_child` の `kill` の時刻 | `audio/engine_life.rs:28-38,128-144,238-273` |
| 開始直後の終了の分類 | 2秒（`DEVICE_OPEN_SETTLING`。終了の**原因の分類**だけに使う） | `Response::Started` を処理した時刻 | `audio/engine_exit.rs:9,139-146,172-176` |

- 応答がタイムアウトしたとき：`vst_operations.timeout()`（`device_open` の記録は残し、それ以外の `in_flight` を消す。`audio/engine_exit.rs:330-343`）。`Stop` などの後始末は送らない。`ReplySlot` は保留のまま残る（2.3）。試験 `commands/audio/compat_tests.rs:644-661`（`timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request`）。

### 2.3 `ReplySlot`（`audio/replies.rs`）の契約

- 型：`ReplySlot(Mutex<Option<mpsc::Sender<Response>>>)`（`replies.rs:7`）。**同時に待てるのは1件**。
- `begin`（`replies.rs:10-23`）：保留中（`Some`）なら `前の音声操作の応答待ちです。…` で失敗する。なければ新しい `channel` を作り、送り側を保持して受け側を返す。ロックの失敗は `IPC応答の状態を取得できません`。
- `deliver`（`replies.rs:25-36`）：保留中の送り側を `take` して `send`。受け側が既に捨てられていても `take` は行う（「古い応答の消費は完了する」）。保留がなければ `false`。**応答の ID・世代・種類は照合しない**（直列プロトコル）。
- `cancel`（`replies.rs:38-42`）：保留を `None` にする（送り側を捨てるので、待っている受け側は `Err` で戻る）。
- タイムアウトの後：受け側は捨てられるが、保留は `Some` のまま残る。次の `begin` は失敗する。遅い応答が届くと `deliver` が `take` して消費し、その後の `begin` が通る（試験 `replies.rs:50-62`）。応答が届かないときは、`reset_engine_reader`（新しい `ReplySlot`、`audio.rs:1151`、`ensure_engine_running` からだけ）か `cancel` まで残る。
- 呼ぶ場所：`begin` ＝ `audio.rs:1166`・`audio/mode_vst.rs:645`。`deliver` ＝ reader（`audio.rs:810,1061`）。`cancel` ＝ `audio.rs:1176`・`audio/mode_vst.rs:548,647`。スロットは接続ごと（`reset_engine_reader` で差し替え）。
- 遅い応答の扱い：待ち手がないときの `Response` は `log::warn!("Received Response but no one is waiting")` だけ（`audio.rs:810-812`）。
- 試験：`replies.rs:50-75`（上の2つ）、`commands/audio/compat_tests.rs:644-661`、`audio/mode_vst.rs:1732`（`emergency_mute_and_stop_cancel_pending_receiver_without_waiting`）、`2082`（`blocked_writer_keeps_early_reply_pending_and_stop_remains_immediate`）。

### 2.4 書き込みの失敗と応答の優先

- 通常の経路：書き込みが失敗したら、応答を待たずに失敗を返す（`audio.rs:1175-1187`）。書き込みが成功すれば応答を待つ。書き込みの成功と応答の到着の前後は、書き込みの `flush` が戻ってから `recv_timeout` を始めるため、応答が先に届いていても `ReplySlot`（`begin` 済み）が保持している（`audio.rs:1166` が `1168` より前）。
- reader が EOF を見て `deliver(Error("Engine Crashed/Exited"))` したときは、待ち手は `Err` ではなく `Response::Error` を受け取る（`audio.rs:1061`）。EOF の前に読めた行は先に処理される（reader は行の順に処理する、`audio.rs:794`）。試験 `audio/tests/compat_tests.rs:106-128`。
- `reader_active` が偽になった後に書き込みへ進まない確認は、`begin` の**前**にある（`audio.rs:1158-1161`）。確認と `begin` の間に reader が EOF を処理すると、`deliver` は待ち手がなく `false`、そのあとの書き込みは、子が `stdin` を開けたままなら成功し、応答は来ず10秒でタイムアウトし、スロットは保留のまま残る（コードの読み取りからの推測。試験なし。W2a の「stdout だけが閉じる子」に当たる）。
- モード VST の経路：書き込みの失敗（`Ok((_, Err))`）が先に判定され、そこで遷移を失敗にする（`mode_vst.rs:547-551`）。書き込みの結果の後で、応答を `try_recv`（`mode_vst.rs:566-582`）。書き込みの結果が来る前に応答が届いても、応答の処理は書き込みの結果の後（`mode_vst.rs:543-566`）。

### 2.5 複数の行（応答・通知）を伴う命令

親の待ち手は **`Response` の1行だけ**を待つ（`audio.rs:1166,1189`）。通知の行は reader が独立に処理し、待ち手とは対応づけない。

| 命令 | 子が書く行（順） | 親の側 | 根拠 |
|---|---|---|---|
| `Start` | `Event::Log`（`audio_engine/core/startup.rs:2254`）→ `Event::Started`（`startup.rs:2260`）→ `Response::Started`（`audio_engine/core/commands.rs:603`）。失敗時は `Event::Stopped` ほか → `Response::Error`（`commands.rs:623`） | reader は `Event::Started` を処理して通知を出し終えてから次の行を読む。待ち手は `Response::Started`（または `Error`）で解放される。したがって `audio-started` の emit は `start_audio` の結果を返すより前（試験 `audio/tests/compat_tests.rs:56-75`）。待ち手は `Event` を待たない | `audio.rs:794,919-941,1166-1193` |
| `Stop` | `Event::Stopped`（`audio_engine/core.rs:1354-1360`）→ `Response::Success`（`commands.rs:626-629`） | 同上（`audio-stopped` が先。試験 `compat_tests.rs:93-102`） | 同上 |
| `RestorePlugin`・`RestoreSessionPlugin` | 応答は次の `AboutToWait` の turn（`pending_restore`。`audio_engine/core.rs:723-732,1907-1966`）。途中で `Event::ControlStall`（別スレッド、`audio_engine/core/control_stall.rs:197`）が出うる | 待ち手は10秒待つ。`operation_id` を応答と照合（`validate_restore_response`、`audio.rs:2996-3014`）。応答の ID 以外は `ReplySlot` は照合しない | `audio.rs:1811-1816` |
| `LoadPlugin` | 応答は `PluginLoaded`。遅延初期化（次の turn）の失敗は応答ではなく `Event::Error`＋音声の停止（`audio_engine/core.rs:734-765`） | 応答の後に reader が `audio-stream-error` を出しうる | 同上 |
| `BeginDeviceScan`・`PollDeviceScan`・`CancelDeviceScan` | 即時の応答（トークン・状態） | 待ちは10秒。結果は親が 100ms ごとにポーリング（2.2） | `audio.rs:1231-1370` |
| ボイスチェックの録音・試聴 | `Response::Success`の後、`Event::VoiceCheckState`・`VoiceCheckEnvelope` が非同期に流れる | `voice_activity` を reader が更新（`audio.rs:947-950`）。`start_voice_check`・`play_voice_check` は成功時に `voice_activity` を立てる（`audio.rs:2403,2494`） | — |
| 子の EOF（待ち手がいるとき） | 行なし | reader が通知を出してから `Response::Error("Engine Crashed/Exited")` を `deliver`（`audio.rs:1047-1061`） | 試験 `compat_tests.rs:106-128` |
| 想定外の2つ目の `Response` | — | `deliver` が `false`（`log::warn`、`audio.rs:810-812`） | — |

---

## 3. reader のスレッド

### 3.1 主の reader（`ensure_engine_running` が起動）

- 起動：`thread::spawn`（名前なし・`JoinHandle` を保持しない・join しない）。1接続に1本（`audio.rs:793`）。`child.stdout` の `BufReader` を `move`（`audio.rs:773,794`）。`stderr` は親へ継承（`audio.rs:724`）。
- クロージャが持つもの（`audio.rs:783-791`）：`reader_active`（接続ごとの `Arc<AtomicBool>`）、`vst_operations`（接続ごと）、`pending_reply_tx`（接続ごと）、`voice_activity`（接続ごと）、`emitter`（**全接続で共有**の `Arc<Mutex<Option<AudioEmitter>>>`）、`conditions`（**全接続で共有**の `Arc<Conditions>`）、`condition_epoch`（接続の世代）、`engine_generation`（`stream_generation` のラベル用）。**ホストのロックは持たない・取らない**。
- 行の処理（`audio.rs:794-1045`）：
  1. 先頭で `reader_active` が偽なら `break`（`audio.rs:795-797`）。
  2. 行の読み取りが `Err`（I/O エラー・不正な UTF-8）なら `continue`（`audio.rs:798-800`）。空行は `continue`（`audio.rs:801-803`）。
  3. `IPC:` で始まる行だけを `OutputMessage`（`ipc.rs`）として解釈する（`audio.rs:805-806`）。それ以外は `log::trace!("[Engine Raw] ...")`（`audio.rs:1043`）。
  4. 解釈に失敗したら `log::error!("Engine IPC parse error: ...")` だけ（`audio.rs:1037-1039`）。待ち手の解放・通知・`reader_active` は変えない。行は捨てる。
  - **1行の長さの上限なし**（`BufRead::lines`）。

| 行の種類 | 変える状態 | 取るロック | 出す通知（順） | epoch の照合 | 根拠 |
|---|---|---|---|---|---|
| `Response` | `vst_operations.response`（`in_flight` の解除、VST の ID の対応表、`device_open` の `settling`）→ `ReplySlot::deliver` | `Operations` の `Mutex`、`ReplySlot` の `Mutex` | なし（待ち手がなければ `warn`） | なし | `audio.rs:808-813`、`audio/engine_exit.rs:133-168,324-328` |
| `Event::ControlStall` | なし | `emitter` | `audio-control-stall` | なし | `audio.rs:815-835` |
| `Event::MixingSourceFailed`・`MixingOutputFailed` | `conditions.engine_changed(epoch)`（`revision += 2`。`epoch` 不一致・`running` が偽なら `false`） | `emitter` | `audio-conditions-changed` → `mixing-source-failed` / `mixing-output-failed`（`false` なら何も出さず次の行へ） | あり | `audio.rs:836-852`、`audio/conditions.rs:152-161` |
| `Event::Log` | なし | なし | なし（`log::info`） | — | `audio.rs:853` |
| `Event::Error` | `conditions.engine_event(epoch, false)`（`pending`・`revision`・`running = false`）。`false` なら**黙って捨てる**（`log::error` も出さない） | `emitter` | `audio-conditions-changed` → `audio-stream-error`（文字列） | あり | `audio.rs:854-863`、`conditions.rs:134-150` |
| `Event::LevelMeter` | なし（メーターの値を保持しない） | `emitter` | `audio-level`（`LevelPayload`：`input`・`output`・`stream_generation` のラベル） | なし | `audio.rs:864-882` |
| `Event::Stopped` | `engine_event(epoch, false)`。`false` なら捨てる | `emitter` | `audio-conditions-changed` → `audio-stopped`（`stream_generation`・`ended_stream_generation`） | あり | `audio.rs:883-906` |
| `Event::Loudness` | なし | `emitter` | `audio-loudness` | なし | `audio.rs:907-911` |
| `Event::ChannelLevels` | なし | `emitter` | `audio-channel-scan` | なし | `audio.rs:912-918` |
| `Event::Started` | `engine_event(epoch, true)`。`false` なら捨てる | `emitter` | `audio-conditions-changed` → `audio-started`（`sample_rate`・`buffer_size`・`stream_generation`） | あり | `audio.rs:919-941` |
| `Event::VoiceCheckState` | `voice_activity`（`recording`／`playing` で真） | `emitter` | `voice-check-state` | なし | `audio.rs:942-967` |
| `Event::EditorOpened`・`EditorClosed` | なし | `emitter` | `plugin-editor-opened`・`plugin-editor-closed` | なし | `audio.rs:968-983` |
| `Event::ProcessingHealth` | なし | `emitter` | `audio-processing-health` | なし | `audio.rs:984-1015` |
| `Event::VoiceCheckEnvelope` | なし | `emitter` | `voice-check-envelope` | なし | `audio.rs:1016-1034` |

- すべての `emit` は `emitter.lock().unwrap()` を持った**まま** `emit` を呼ぶ（`if let Some(h) = emitter_clone.lock().unwrap().as_ref() { h.emit(..) }`、`audio.rs:824,841,859,868,890,908,913,927,951,969,977,991,1020,1054`）。1つの `if let` の中で複数の `emit` を呼ぶ箇所（`audio-conditions-changed` と本体）は、同じロックの下で続けて呼ぶ（`audio.rs:841-851,859-862,890-905,927-940,1054-1058`）。ロックの失敗は `unwrap()`（パニック）。
- **EOF（`stdout` の終端）**（`audio.rs:1047-1062`）：`log::warn!("Engine stdout closed.")` → `vst_operations.unexpected_exit(&reader_active)`（`audio/engine_exit.rs:345-359`）：`reader_active.swap(false)` が元から偽（意図した停止・再起動・`Drop`）なら `None` → **何も通知せず、待ち手も解放せずに終了**（`audio.rs:1048-1050`）。真だったときだけ、原因の分類（`device_open`／`vst_operation`／`unknown`。直前の `in_flight`・`settling`（2秒）から）を作り、`conditions.engine_event(epoch, false)`（結果は無視、`audio.rs:1053`）→ `emitter` の下で `audio-conditions-changed` → `audio-engine-exited`（原因のペイロード）→ `audio-error`（`Audio Engine Process Exited (Crash?)`）（`audio.rs:1054-1058`）→ 最後に `ReplySlot::deliver(Error("Engine Crashed/Exited"))`（`audio.rs:1061`）。EOF の処理は epoch を照合しない（`reader_active` の `swap` だけが判定）。`child`・`stdin`・`is_running` は reader は変えない（試験 `compat_tests.rs:124-127`：EOF の後も `is_running = true`）。
- **パースの失敗**：上のとおり、ログだけで行を捨てる。`Response` の行が捨てられると、待ち手は10秒待ってタイムアウトし、スロットは保留のまま残る（2.3）。試験なし。
- **`LevelMeter` とメーター**：親はメーターの値を保持・間引き・集計しない。子が約16ms 間隔（`audio_engine/core.rs:635,795-803`。無音のときは75ms 経過後に `idle` の値を送る）で出す行を、そのまま `audio-level` として出す。`stream_generation` のラベルは `"{engine_generation}:{child}"`（`engine_generation` は reader の起動時の値で固定、`audio.rs:103-110,791,873-876`）。`stream_generation` のない旧の子の行も解釈でき、ラベルは省略される（試験 `compat_tests.rs:337-368`）。`emit` の失敗は `log::warn`（`audio.rs:878-880`）。
- **古い reader の無効化**：
  - `reset_engine_reader`（`audio.rs:1148-1154`）は `ensure_engine_running` からだけ呼ばれる（`audio.rs:783`）：旧の `reader_active` を `false` にし、`ReplySlot`・`reader_active`（新しい `Arc<AtomicBool>(true)`）・`vst_operations` を差し替える。`voice_activity` も新しい `Arc`（`audio.rs:788`）。
  - `kill_primary_engine`（`audio.rs:2796-2823`）、`Drop`（`audio.rs:2955`）、`release_engine`／`take_engine_for_shutdown`（`audio.rs:2979,2988`）、`ensure_engine_running` の `try_wait` 分岐（`audio.rs:743,752`）は、`reader_active.store(false)` を先に行う。
  - 旧の reader は、**次の行を読んだとき**に `reader_active`（旧の `Arc`）を見て抜ける（`audio.rs:795`）。読んでいる最中の1行は処理される。旧 reader が持つ `conditions`・`emitter` は新旧で共有なので、epoch で照合しない種類の通知（`audio-level`・`audio-loudness`・`audio-channel-scan`・`audio-control-stall`・`voice-check-*`・`plugin-editor-*`・`audio-processing-health` の9種）は、旧 reader からも出うる。epoch で照合する種類（`Started`・`Stopped`・`Error`・`Mixing*`）の再照合に隙がある（`engine_event` の最初の照合の後、`running` を書いてから再照合するまで。試験 `compat_tests.rs:467-487` が現行の窓として固定）。
  - 旧の子の EOF は `unexpected_exit` が `None`（旧の `reader_active` が既に偽）なので何も出さない。

### 3.2 配信ミックスの子の reader

- 同じコード（`ensure_engine_running`）で動く。違いは次のとおり。
  - 子 `AudioHost` は自前の `emitter`（`Arc::new(Mutex::new(None))`、`audio.rs:523`）を持ち、`set_event_emitter` は主にだけ呼ばれる（`lib.rs:393`）ので、**子の reader は `emit` を一切行わない**（`if let Some` を通らない）。ただし `emitter.lock().unwrap()` は行う。
  - `conditions`（`audio.rs:512`）・`ReplySlot`・`vst_operations`・`reader_active`・`voice_activity`・`mode_vst`・`live_modes`・`frontend_bootstrap`・`mixing`・`post_mix`は、子の `AudioHost` が自前で持つ（`audio.rs:508-553`）。子の `Conditions` は主の `Conditions` と別（主の witness を変えない）。
  - 子の起動は `--post-mix-worker`（`audio.rs:718-720`）、`engine_life` の役割は `PostMix`（`audio.rs:555-561`）。
  - EOF：子の `reader_active` が真だったときは、通知（`emit` は出ない）の後に `deliver(Error("Engine Crashed/Exited"))`。待ち手（主のロックを持つスレッド）が解放される（`audio.rs:1047-1062`）。主は子の終了を `reader_active`・`child` で見る（`audio/post_mix.rs:312-339,660,719-738`）。

---

## 4. 通知（`emit`）の全箇所

- 発行口：音声系は `AudioEmitter::emit`（`audio/emit.rs:48-55`）→ `AppHandle::emit`。`AURALYN_EMIT_TRACE=1` のとき、呼んだ順を通し番号つきでログに残す（`audio/emit.rs:12-31`）。`trace_mark("return", ..)` はコマンドの結果を返す直前の印だけ（`start_audio`・`stop_audio`・`restart_audio_engine`、`commands/audio.rs:449,518,727`）で、`emit` ではない。
- 音声系の `emit` の呼び出し箇所：**32**（`audio.rs` 26・`audio/live_modes.rs` 2・`audio/mode_vst.rs` 4。試験と `audio_engine` を除く）。名前は **23** 種。
- 出す場所の種別：「reader」（子の行を処理するスレッド）／「`AudioHost`」（ホストのロックを持つスレッド）／「`dispatch`」（`Conditions::dispatch` が受け取る閉包、`audio.rs:1134-1146`）。コマンド本体（`commands/*.rs`）は音声系の `emit` を呼ばない。
- 「ロック」の列：reader の `emit` は、ホストのロックを**持たず**、`emitter` の `Mutex` を持ったまま `emit` する。ホスト側の `emit` は、ホストのロック**と** `emitter` の `Mutex` を持った状態。
- 「K 群」の列：F1a-0 の互換の試験（`audio/tests/compat_tests.rs`、`commands/audio/compat_tests.rs`）が、名前・順・ペイロードのどれかを固定しているか。

### 4.1 音声系 23 種

| 名前 | 出す場所（種別：ファイル:行） | ロック | 同じ操作の中での順 | K 群で固定済みか |
|---|---|---|---|---|
| `audio-conditions-changed` | reader：`audio.rs:842,860,891,928,1055`。`AudioHost`：`notify_conditions_changed`（`audio.rs:576-580`。呼び出し：`audio.rs:766`（子の起動）、`audio.rs:2809`（`kill_primary_engine`）、`audio/live_bundle.rs:223`、`audio/output_bundle.rs:132`、`audio/mode_vst.rs:397,445,845`）。`dispatch`：前（`changes` が真のとき）と後（`changes` か `Err`）、`audio.rs:1137-1145`、`audio/conditions.rs:103-122` | reader は `emitter` のみ。`AudioHost`・`dispatch` はホスト＋ `emitter` | 起動：`CC`（`ensure`）。`SetGlobalMute`：`CC`（前）・`CC`（後）。`Start`：`CC`（前）→ reader の `CC`・`audio-started` → `CC`（後）。`Stop`：`CC`（前）→ reader の `CC`・`audio-stopped` → `CC`（後）。EOF：`CC`（前）→ reader の `CC`・`audio-engine-exited`・`audio-error` → `CC`（後。`Err` のため） | 固定（`compat_tests.rs:58-75,93-102,106-128,449-465`、`conditions.rs:474`）。`live_bundle.rs:223`・`output_bundle.rs:132`・`mode_vst.rs` の3箇所は名前の列で固定していない |
| `audio-control-stall` | reader：`audio.rs:825-833`（`command`・`pluginId`・`module`・`elapsedMs`） | `emitter` | 他の行と独立 | 固定（`compat_tests.rs:532-612`） |
| `mixing-source-failed`・`mixing-output-failed` | reader：`audio.rs:843-850` | `emitter` | `audio-conditions-changed` の直後 | 固定（`compat_tests.rs:491-528`） |
| `audio-stream-error` | reader：`audio.rs:861` | `emitter` | `audio-conditions-changed` の直後 | 固定（`compat_tests.rs:132-155`） |
| `audio-level` | reader：`audio.rs:869-880` | `emitter` | 約16ms 間隔で連続（子が出す間隔、`audio_engine/core.rs:635,795`）。他と独立 | 形・名前は固定（`compat_tests.rs:337-368`）。件数・間隔・順は固定していない |
| `audio-stopped` | reader：`audio.rs:892-904` | `emitter` | `audio-conditions-changed` の直後。失敗した `Start` では、`Response::Error` を返す前（`compat_tests.rs:79-91`） | 固定（`compat_tests.rs:79-102,247-269,614-652`） |
| `audio-loudness` | reader：`audio.rs:909` | `emitter` | 独立 | 固定（`compat_tests.rs:532-612`） |
| `audio-channel-scan` | reader：`audio.rs:914` | `emitter` | 独立 | 固定（同上） |
| `audio-started` | reader：`audio.rs:929-939` | `emitter` | `audio-conditions-changed` の直後。`start_audio` の結果を返すより前 | 固定（`compat_tests.rs:56-75,614-652`） |
| `voice-check-state` | reader：`audio.rs:958-965` | `emitter` | 独立 | 固定（`compat_tests.rs:532-612`） |
| `voice-check-envelope` | reader：`audio.rs:1026-1032` | `emitter` | 独立 | 固定（同上） |
| `plugin-editor-opened`・`plugin-editor-closed` | reader：`audio.rs:970,978` | `emitter` | 独立 | 固定（同上） |
| `audio-processing-health` | reader：`audio.rs:1004-1012` | `emitter` | 独立 | 固定（同上） |
| `audio-engine-exited` | reader：`audio.rs:1056` | `emitter` | EOF で `audio-conditions-changed` の次 | 固定（`compat_tests.rs:106-128,654-690`） |
| `audio-error` | reader：`audio.rs:1057`（EOF）。`AudioHost`：`audio.rs:1183`（書き込みの失敗。文字列は `音声エンジンとの通信が切れました`） | reader は `emitter`／書き込みの失敗はホスト＋ `emitter` | EOF：`audio-engine-exited` の次。書き込みの失敗：`kill_engine` の通知（`audio-conditions-changed`）の後 | EOF は固定（`compat_tests.rs:106-128`）。書き込みの失敗は名前の存在だけ（`engine_life_tests.rs:230-247`）。文字列・順は固定していない |
| `global-mute-changed` | `AudioHost`：`audio.rs:1897`（VST 切替中の緊急ミュート）、`audio.rs:1907`（通常。`SetGlobalMute` の成功後）、`audio/mode_vst.rs:504`（`cancel_mode_vst`） | ホスト＋ `emitter` | `SetGlobalMute` の `dispatch` の後（`CC` の後） | **固定していない**（名前を含む試験が見つからない） |
| `global-bypass-changed` | `AudioHost`：`audio.rs:2219`（成功後） | ホスト＋ `emitter` | `dispatch` の後 | **固定していない** |
| `live-modes-invalidated` | `AudioHost`：`audio/live_modes.rs:143`（世代の失効）、`151`（保護の解除）、`audio/mode_vst.rs:484`（状態の更新）、`849`（遷移の完了） | ホスト＋ `emitter`（`live_modes.rs` は `.lock().unwrap()`、`mode_vst.rs` は `if let Ok`） | `kill_engine` では `audio-conditions-changed` の前（`live-modes-invalidated`→ `CC`） | `kill_engine` 経由だけ固定（`compat_tests.rs:247-269,449-465`、`commands/audio/compat_tests.rs:469-490`） |
| `session-rack-change-started` | `AudioHost`：`audio/mode_vst.rs:398,446`（`emit_mode_rack_event`、`mode_vst.rs:519-525`） | ホスト＋ `emitter` | `audio-conditions-changed` の次、`live-modes-invalidated` の前 | **固定していない** |
| `session-rack-change-cancelled` | `AudioHost`：`audio/mode_vst.rs:516` | ホスト＋ `emitter` | `cancel_mode_vst` の最後 | **固定していない** |
| `session-rack-invalidated` | `AudioHost`：`audio/mode_vst.rs:801`（確定失敗）、`849`（完了） | ホスト＋ `emitter` | `849` は `live-modes-invalidated` の次 | **固定していない** |

### 4.2 音声系以外の `emit`（参考。ホストのロックとの関係だけ）

| 名前 | 出す場所 | ホストのロックとの関係 |
|---|---|---|
| `shortcut-noise-toggled`・`shortcut-stopped-gain`・`shortcut-output-gain` | `shortcuts.rs:502,518,521` | **ホストのロックと `gate` の `Mutex` を持ったまま** `app.emit` |
| `shortcut-error` | `shortcuts.rs:534` | ロックの外（動作の後） |
| `shortcut-captured` | `shortcuts.rs:398` | `gate` を `try_lock` で持った状態（OS の通知のコールバック、`shortcuts.rs:104-109,386-411`）。ホストのロックなし |
| `obs://timing-invalidated`・`obs://reach-invalidated`・`obs://live-scene-changed`・`obs://scene-changed`・`obs://live-scene-invalidated` | `obs.rs:450,476,500,504,507,516,519,532` | ロックなし（tokio のタスク） |
| `minimized-to-tray` | `lib.rs:417` | ロックなし（ウィンドウのイベント） |
| `second-instance` | `coexistence.rs:11` | ロックなし |
| `app://window-activity` | `window_activity.rs:13` | ロックなし |

---

## 5. 定期の処理と非同期の処理

### 5.1 モード VST のスケジューラ（10ms）

- 起動：`lib.rs:315`（`AudioControl::new` の直後、`set_event_emitter`・warmup の前）。`thread::spawn`、`loop`：`sleep(10ms)` → `Weak::upgrade`（失敗なら `break`）→ `lock(Entry::new(Scheduler, "poll_mode_vst"))` → `poll_mode_vst`（`audio/control.rs:231-240`）。周期は「10ms ＋ ロックの待ち ＋ 処理の時間」（固定の周期ではない）。
- 取るロック：ホストのロック（毎回）。受付の記録は件数だけ（`audio/control.rs:102-104`）。
- ロックを持つ時間：トランザクションがなければ `poll_orphan_mode_disk`（`try_recv`）と `take` だけ（`audio/mode_vst.rs:526-530,728-773`）。トランザクションがあれば、1 tick に1段：保留中の応答の `try_recv`・次の命令の組み立て・書き込みスレッドの起動（`mode_vst.rs:543-643`）。長くなりうる処理：`MonitorConfigure` の `live_output.json` の読み取り（`mode_vst.rs:937-941`）、完了時の `remove_file`（`mode_vst.rs:805`）、失敗時の `kill_engine`（最大 約4秒、`mode_vst.rs:797,808`）、`complete_mode_transaction` の通知（`mode_vst.rs:845-851`）。ディスクの書き込みは別スレッド（`spawn_mode_disk`、`mode_vst.rs:674-686`）。
- 取り消しの方法：スレッド自体を止める手段はない（`Weak` の `upgrade` が失敗したときだけ終わる。試験 `audio/tests/control_tests.rs:160`）。トランザクションの取り消しは `cancel_mode_vst`（`mode_vst.rs:488-518`）：`stop_primary`（`audio.rs:1749-1753`）・`set_global_mute`（`audio.rs:1890-1900`）・`kill_primary_engine`（`audio.rs:2799-2801`）・時間切れ（120秒／10秒、`mode_vst.rs:539,553,573`）・世代の変化（`mode_vst.rs:531`）から。
- 起動の順序：スケジューラが先に動き、`set_event_emitter` が後（`lib.rs:315,389-394`）。この間の `emit` は `emitter` が `None` で出ない。

### 5.2 機器のスキャン（`DeviceScanTicket`）

- 周期：呼び出し側（tokio）が 100ms ごと（`commands/audio.rs:205-207`）。ホスト側にスレッド・タイマーはない。
- 取るロック：手順ごとに別の `run_blocking` でホストのロック（Begin・Poll・Cancel、`commands/audio.rs:192-197,209-215,221-227,233-239`）。
- ロックを持つ時間：Begin（キャッシュヒットなら IPC なし。なければ E の `BeginDeviceScan` 1回、`audio.rs:1231-1258`）、Poll（E の `PollDeviceScan` 1回、`audio.rs:1267-1311`）、Cancel（E の `CancelDeviceScan` 1回、`audio.rs:1352-1370`）。各 IPC は最大10秒。ポーリングの間にロックは手放される。
- 取り消しの方法：(1) 35秒の期限で Cancel（`commands/audio.rs:208-217`）。(2) Poll の失敗で Cancel（`commands/audio.rs:232-241`）。(3) 接続の世代の変化で、ホストが `device_scan = None`（`audio.rs:779,2811`）にし、古いチケットは `poll`・`cancel` で失効（`audio.rs:1272-1275,1353-1355`）。(4) `begin_device_scan` が35秒を過ぎた古いチケットを `cancel_device_scan`（`audio.rs:1237-1243`）。チケットの `terminal`（`Arc<OnceLock<Result<..>>>`）は呼び出し側の共有（`audio.rs:40-45,1276-1278`）。
- 試験：`audio/tests/device_scan_tests.rs:11-215`（世代・キャッシュ・並列・終端の共有）。

### 5.3 warmup と `frontend_bootstrap`

- warmup：`lib.rs:397-407`。専用スレッド1本が、起動のたびに1回だけ `lock(Warmup)` → `warmup()`。ロックを持つ時間：`prepare_warmup`（既存の子があれば `auto_gain(Status)` 1回）→ `ensure_engine_running`（子の起動：`ensure_clear` 最大10秒・引き継ぎ IPC 最大2）→ 移行の確認（`migration::review_required`、ファイル）→ `last_audio_config.json` の読み取り → 設定があれば `start_internal_guarded_with_ids`（1.5 の `start_audio` の手順。`Some(generation)` つき）（`audio.rs:2825-2916`、`audio/frontend_bootstrap.rs:133-168`）。
- `audio_frontend_bootstrap`：フロントエンドからの呼び出し。`frontend_seen` か `canceled` なら即戻る（`frontend_bootstrap.rs:171-192`）。それ以外は `warmup_once`（上と同じ）を呼び、`auto_gain(Status)` 1回、動作中なら `SetInputGain`・`SetOutputGain`・`SetInputChannels`（最大3回）、未動作なら `initial_controls` つきの `start_internal_guarded_with_ids`（`frontend_bootstrap.rs:193-414`）。
- 取り消しの方法：`frontend_bootstrap.cancel()`（`frontend_bootstrap.rs:18-21`）が `canceled` を立てる。呼ぶ場所：`start`・`start_with_device_ids`（`audio.rs:1380,1404`）、`execute_command` の `command_changes`（`audio.rs:1094`）、`stop_primary`（`audio.rs:1754`）、`kill_primary_engine`（`audio.rs:2803`）、`begin_live_changes`（`audio/live_modes.rs:245`）、`begin_mode_vst`（`audio/mode_vst.rs:394`）、`execute_command_if_running`（`audio/engine_exit.rs:218`）。確認は `prepare_warmup` の先頭（`frontend_bootstrap.rs:137`）と `frontend_bootstrap` の2点（`frontend_bootstrap.rs:182,246`）。**warmup・`frontend_bootstrap` はロックを持って最後まで進むので、実行中の warmup は他の入口の `cancel()` では途中で止まらない**（他の入口はロックを待つ。`cancel()` はその入口がロックを得た後に立つ）。
- 試験：`audio/frontend_bootstrap.rs:463-966`（warmup と最初の画面の関係の14本）、`commands/audio/compat_tests.rs:494-640`（K8a〜d）。

### 5.4 OBS の到達の確認のトーン

- 開始：`check_audio_reach`（`obs.rs:634-690`）が OBS の `client` の `tokio::Mutex` を持ち、`stop_reach` で前の確認を止めてから、`tokio::spawn` で `run_audio_reach` を動かす。
- ホストのロック：`play`（`lock(Obs, "play")`、`begin_obs_reach_tone`：`conditions.snapshot` → `guard_live_command` → R の `PlayTestTone` 1回 → `snapshot`、`obs.rs:47-63`、`audio.rs:2532-2545`）と、`stop`（`lock(Obs, "stop")`、`finish_obs_reach_tone`：`witness.validate` → R の `StopTestTone` 1回、`obs.rs:65-82`、`audio.rs:2547-2557`）の2回。各回のロックを持つ時間は IPC 1回（最大10秒）。
- 周期・待ち：`tone` の長さ `duration_ms` は 100〜5000ms（`obs.rs:644-646`）。tokio が `duration + 500ms` の `sleep` で待つ（`obs.rs:864`）。OBS 側の待ちは別に 5秒・2秒（`obs.rs:770-779,838,816`）。トーンの停止の期限は子の `PlayTestTone` の `duration_ms` 自身（コメント：`obs.rs:807-808`）。
- 取り消しの方法：`stop_reach` が `watch` の `cancel` を送り、タスクの終了（`play` 済みなら `stop` の完了）を待つ（`abort` はしない、`obs.rs:536-543`）。`stop_connection`（`obs.rs:562`）・`check_audio_reach` の冒頭（`obs.rs:648`）から呼ぶ。条件が変わった（`Witness` の不一致）場合は、別のトーンを止めない（`obs.rs:807-815`、`audio.rs:2547-2551`）。
- 試験：`obs.rs:981-1270` の `reach_*`（`reach_cancellation_closes_a_pending_handshake_without_starting_audio` など）。

---

## 6. 今のロックの持ち方の性質

### 6.1 `Mutex` の種類

- ホストのロックは `std::sync::Mutex<AudioHost>`（`audio/control.rs:9,174`）。`parking_lot` は使っていない（`src-tauri/Cargo.toml` に出現しない）。
- 実装：プロジェクトのツールチェーンは `1.100.0`（`rust-toolchain.toml`）。`1.100.0` には `rust-src` がなく、std の実装は読めなかった。同じ機械の別のツールチェーン `stable`（`rustc 1.99.1`、`x86_64-pc-windows-msvc`）の std ソースを読んだ：`library/std/src/sys/sync/mutex/mod.rs` は、`target_os = "windows"` かつ `target_vendor != "win7"` を **`futex` の `Mutex`** にする。`futex.rs` は3状態（`UNLOCKED=0`・`LOCKED=1`・`CONTENDED=2`）。`lock` は `compare_exchange` → 競合なら100回までスピン → `CONTENDED` に `swap` して `futex_wait`。`unlock` は `swap(UNLOCKED)` して `CONTENDED` だったときだけ**1スレッドを起こす**。Windows の `futex_wait` は `WaitOnAddress`（`library/std/src/sys/sync/futex/windows.rs:67`）。**FIFO でも公平でもない**（起こされたスレッドが取る前に、新しく `lock` を呼んだスレッドが取れる）。`1.100.0` で同じかどうかは確かめていない（推測：同じ）。
- 試験 `audio/tests/control_tests.rs:43`（K11）は、受付の記録が A→B でもロックの取得が B→A になりうることと、結果が取得順で決まることを固定している。
- ポイズン：保持中のスレッドがパニックすると以後の `lock` は `Err`。各入口は 1.7 の文言に写す。

### 6.2 他のロック（ホストのロックの内側・外側）

| ロック | 種類 | 持つ時間 | 持つ間に待つもの | 根拠 |
|---|---|---|---|---|
| `emitter` | `std::sync::Mutex<Option<AudioEmitter>>`。全接続で共有 | `emit` の呼び出しの間（reader・ホスト側とも） | `AppHandle::emit`（Tauri 内部。内容は未確認） | `audio.rs:256,824-1057` ほか |
| `ReplySlot` | `std::sync::Mutex<Option<Sender>>`（接続ごと） | `begin`・`deliver`・`cancel` の間だけ（葉） | なし | `audio/replies.rs:7-42` |
| `engine_exit::Operations` | `std::sync::Mutex<State>`（接続ごと） | `begin`・`response`・`timeout`・`unexpected_exit` の間だけ（葉） | なし | `audio/engine_exit.rs:50-51,317-360` |
| `engine_life::Store.slots` | `std::sync::Mutex<[Vec<Retired>;2]>`（主＋配信ミックスで共有） | `ensure_clear` は**ロックを持ったまま `settle`（50ms ごとの `sleep`、最大10秒／記録）**。`recheck` は待たない | `try_wait`・`sleep` | `audio/engine_life.rs:128-144,153-189,192-211` |
| `Admission.log` | `std::sync::Mutex<VecDeque<Record>>`（葉） | 採番と追記の間だけ | なし | `audio/control.rs:65-116` |
| `BundleState` | **`tokio::sync::Mutex`** | `broadcast_bundle` の**コマンドの最後まで**（各 `await` をまたぐ） | 音声のロックの取得・OBS・`sleep(50ms)` | `commands/bundles.rs:2017` |
| ショートカットの `gate` | `std::sync::Mutex<CaptureGate>` | 動作の実行の間（ホストのロックを取った後に取り、動作の終わりまで持つ） | ホストのロックで行う動作（IPC）・`app.emit` | `shortcuts.rs:430-436,73` |
| OBS の `client`・`reach_task` ほか | `tokio::sync::Mutex` | 接続・確認の間 | OBS の通信 | `obs.rs:448,537,640,677` |

- 観察できる順序：(a) `BundleState`（tokio）→ ホストのロック（`run_blocking` ごとに取って放す）。(b) ホストのロック → `emitter`、→ `ReplySlot`、→ `Operations`、→ `Store.slots`。(c) reader → `emitter`、→ `ReplySlot`、→ `Operations`（**reader はホストのロックを取らない**、`audio.rs:783-791`）。(d) ショートカット：ホストのロック → `gate`。ただし OS の通知のコールバックは `gate` を `try_lock`（待たない）（`shortcuts.rs:104-109`）。`begin_shortcut_capture`・`end_shortcut_capture` は `gate` を `lock()` で待つ（`shortcuts.rs:128-132,151-155`）ため、動作が `gate` を持ったままホストのロックを待つ間は待たされる。(e) 逆順（`gate` →ホスト、`emitter` →ホスト、`Store.slots` →ホスト、`ReplySlot` →ホスト）で取る箇所は、grep の範囲では見つからなかった。

### 6.3 ロックを長く持つ経路の上位10件（待ちの上限の合計で並べる）

**「待ちの上限」は、コードにある各待ち（IPC 1回＝10秒、`kill` の確認、固定の `sleep`、ループの回数）を全部最大まで積み上げた理論値。実測ではない。分岐（ミックスなし・本番モードなし・VST の件数・失敗の後始末）で大きく変わる。IPC の回数は、1.3・1.5・1.6 に出した手順を数えたもの（±数回の誤差がありうる）。**

| 順位 | 経路（ロックを持つ範囲） | 内訳（最大） | 上限（概算） |
|---|---|---|---|
| 1 | `broadcast_bundle` の `Undo`（`undo_owned` の `lock`、`bundles.rs:2874-2891`） | `capture` 約39（ミックスあり）＋ `apply_selected`（約500、下の 2 と同じ）＋ `stop` 2 | 約540 IPC ≒ **5,400秒** |
| 2 | `broadcast_bundle` の `Apply`（`apply_owned` の `lock`、`bundles.rs:2721-2731`） | ミックス：`capture_bundle_mixing` 34＋ `stop` 2＋ `apply_engine_mixing` 2＋ `restore_bundle`（`stop` 1＋ `RestorePlugin` 32＋ `capture_bundle` 34）＋ `stage_bundle_voice`（`ProcessingState` 1＋ `GetPluginRack` 1＋ unload 32＋ restore 32＋ `capture_bundle_state` 1）。本番モードの確認ループ 100 回×2＝200。`start_bundle` 約19。プロファイルの適用 約10。ゲイン 1＋ 1＋100。＋ `kill_engine` 4秒・起動 10秒・ファイルの `fsync` 多数 | 約500 IPC ≒ **5,000秒** |
| 3 | `apply_profile`・`restore_backup_profile`（`commands/profiles.rs:146-160,189-203`） | バックアップ 約2＋ `pre_stats` 1＋ `GetDevices` 0〜1＋ `start_bundle` 約19＋ `kill_engine` 4秒＋ノイズ・FX の復元 約3＋ `set_input_gain` 1＋ `set_output_gain` 1＋100＋ノイズ・FX 約2＋（再起動なしなら unload 最大32）＋ restore 最大32 | 約160 IPC ≒ **1,600秒** |
| 4 | ショートカットの音量（`GainUp`・`GainDown`、`shortcuts.rs:504-523`）。`gate` も持つ | `auto_gain(Status)` 1＋ `set_output_gain`（1＋最大100）＋ `shortcut_gain_intent`（`Status` 1）。コマンドの `set_output_gain` 単体（`commands/audio.rs:1030-1043`）は 101回＋ 1秒の `sleep` ≒ 1,011秒 | 約103 IPC ≒ **1,031秒** |
| 5 | `restart_temporary_session`（`preserve_runtime`、ミックスあり。`temporary_session.rs:285-345`） | `preflight_runtime_checkpoint` 約3＋ `capture` ×2（各 約39）＋ `prepare_update`（`check_can_interrupt` 1＋ `stop` 2＋ `kill_engine` 4秒）＋ファイル I/O（`fsync`）＋ `Command::spawn`。ミックスなしなら約170秒 | 約85 IPC ≒ **850秒** |
| 6 | `capture_async`（ミックスあり。`Save`・`Preview`・`Apply` の前後で複数回、`bundles.rs:1985-1993`） | `capture_bundle_state` 1＋ミックス 34＋ `capture_bundle_output` 1＋ `capture_bundle_live` 2 ほか。ミックスなしなら約5回＝ 50秒 | 約39 IPC ≒ **390秒** |
| 7 | `post_mix` の `RestoreSaved`・`Save`（`audio/post_mix.rs:827-864,919-923`） | `RestoreSaved`：`post_mix_stopped` 1＋ `discard_child`（2秒）＋子の起動（10秒）＋ `RestorePlugin` 32＋ `snapshot` 2＋ `PostMixStatus` 1。`Save`：`capture_bundle` 34＋ `persist`（`fsync`） | 約36 IPC＋ 12秒 ≒ **372秒** |
| 8 | `start_audio`・`restart_audio_engine`・warmup・`audio_frontend_bootstrap` の全部入り（`audio.rs:1496-1725`） | IPC 約19（1.5 D）＋起動 10秒＋ `PostMixStatus` の待ち 2秒＋（再起動のとき `kill_engine` 4秒）。失敗の後始末で＋4 IPC | 約19 IPC＋ 16秒 ≒ **206秒**（失敗で 246秒） |
| 9 | `mixing` の `Configure`・`Reset`（`audio/mixing.rs:177-319`） | 起動 10秒（子が居ないとき）＋ R 約5〜8＋ `persist`・バックアップの `fsync` | 約8 IPC＋ 10秒 ≒ **90秒** |
| 10 | `session_rack` の `Begin`（`audio/session_rack.rs:131-229`）、`live_modes` の `SingingOn`・`TalkOn`（`audio/live_modes.rs:411-422`） | `Begin`：起動 10秒（ピーク保護の引き継ぎ 最大2）＋ `sync_live_modes` 2＋ゲイン 2＋ `GetPluginRack` 1。`live_modes`：起動＋ `sync` 2＋ `Snapshot` 1＋ `LiveMode` 1 | 約7 IPC＋ 10秒 ≒ **80秒** |

- 参考：子が居なければ、E の1回のコマンド（1.5 C）でも、起動 10秒＋引き継ぎ IPC 最大2＋同期 最大2＋ IPC 1 ＝ 約5 IPC＋ 10秒 ≒ 60秒がロックを持つ間になりうる。
- 上限のない待ち：通常の経路の書き込み（2.1）。IPC 以外の同期の待ち（`sleep(50ms)` のポーリング・`fsync`・OS の列挙）は上の概算に十分入っていない。

### 6.4 読み取りの入口が、先行する操作の完了を待つ境界

| 入口 | 待つ境界と、返す値 | 根拠 | 試験 |
|---|---|---|---|
| `get_audio_state` | ホストのロックを取る＝先行する操作がロックを放すまで待つ。待った後の `child.is_some()`・`active_config`・`conditions.snapshot()` を返す（`pending` が0でなければ `condition_witness` は省く）。IPC なし | `commands/audio.rs:294-305`、`audio.rs:2923-2936`、`audio/conditions.rs:176-192` | K2：`commands/audio/compat_tests.rs:138`（開始がロックを持つ間、読み取りは待つ）。形：`:104` |
| `get_saved_audio_config` | ロックを取ってから、毎回ファイルを直接読む。欠損は `None`、空の `host` は `保存済み接続方式が空です`、破損は JSON のエラー | `commands/audio.rs:279-291`、`audio.rs:2939-2949` | K10：`compat_tests.rs:186` |
| `get_engine_tuning_config` | ロック待ち（値のコピー） | `commands/audio.rs:308-319` | なし |
| `get_audio_devices`（キャッシュあり） | Begin でロックを取る（IPC なし） | `audio.rs:1231-1236`、`commands/audio.rs:192-201` | `device_scan_tests.rs:44` |
| `get_output_gain_observation`・`get_engine_runtime_stats`・`get_plugin_state`・`noise_measurement`・`live_modes`（`Snapshot`）・`mixing`（`Snapshot`）・`post_mix`（`Snapshot`）・`session_rack`（`Snapshot`）・`builtin_effects`（`Snapshot`）・`peak_protection`（設定なし）・`get_round_trip_measurement` | ロック待ち＋ IPC 1回以上（子が居なければ IPC なしの分岐もある） | 1.5 の B・C・D | 一部（`frontend_bootstrap.rs:966`：`gain_observation`） |
| `get_routing_diagnostics`・`get_process_input_sources` | ロック待ち＋ OS の列挙（ロックの中） | `commands/audio.rs:1212-1224,1392-1400` | なし |
| `preflight_live_changes`・`end_live_changes` | ロック待ち（IPC なし。`live-modes-invalidated` を出しうる） | `audio/live_modes.rs:163-170,267-283` | なし |
| `obs_timing_targets` | **ロックを取らない**。`ConditionState`（`Arc<Conditions>`）を直接読む | `lib.rs:137-143,312` | なし |

---

## 7. 既存の試験

### 7.1 1〜6 の性質を固定している試験（ファイル：行は `fn` の行）

| 性質 | 試験 |
|---|---|
| 入口：受付の記録・勝敗・採番・`note`・記録の上限・スケジューラ・配信ミックスの子の作成 | `audio/tests/control_tests.rs`：`lock_records_the_acceptance_then_the_grant_with_the_entry_name`（21）、K11 `k11_the_result_follows_the_lock_order_not_the_recorded_acceptance_order`（43）、`the_record_order_matches_the_acceptance_numbers_when_a_thread_is_interrupted_after_numbering`（76）、`note_records_without_taking_the_lock`（140）、`the_log_is_bounded`（150）、`the_scheduler_goes_through_the_entry_and_stops_when_the_state_is_dropped`（160）、`the_post_mix_child_host_is_built_only_through_the_control_module`（189） |
| 入口：Tauri のコマンドの関数での応答・エラー | `commands/audio/compat_tests.rs`：`get_audio_state_shape_and_is_running_means_a_child_exists`（104）、K2・K10 `k2_k10_reads_wait_for_the_start_that_holds_the_lock_and_return_the_finished_values`（138）、`k10_saved_config_is_read_directly_from_the_file_on_every_call`（186）、B14 `b14_expected_state_must_match_exactly_and_the_error_text_is_not_localized`（215）、K12 `k12_stop_audio_registers_its_pending_before_waiting_for_the_lock`（258）、K4・K14 `k4_k14_input_source_errors_are_returned_raw_by_start_and_restart`（320）、`k4_restart_preflight_rejection_is_raw_and_keeps_the_running_engine`（347）、K5 `k5_access_denied_markers_become_the_microphone_guidance`（385）、K14 `k14_child_and_parent_errors_are_wrapped_and_stop_errors_are_not`（404）、`lock_failure_texts_are_fixed`（446）、D3 `d3_restart_retires_the_old_connection_silently_and_starts_a_new_one`（471）、K8a〜d（494・537・560・577・620） |
| 入口：`prepare_update`（K9a〜e） | `audio/tests/compat_tests.rs`：232・249・271・289・319 |
| 入口：配信セットの割り込み・再照合 | `audio/live_bundle.rs:232`（`stop_intent_invalidates_an_owned_restore_before_waiting_for_the_host_mutex`）、`commands/bundles/tests.rs:468`（`undo_lock_wait_revalidates_conditions_before_mutation_and_pending_blocks_next_apply`）、`audio/output_bundle.rs:166,235`、`audio/mixing_bundle_tests.rs:37-210`、`audio/conditions.rs:282`（`queued_stop_or_mute_blocks_fresh_witnesses_until_its_handler_finishes`） |
| 入口：条件の版（`command_changes`・`dispatch`） | `audio/conditions.rs:265-528`（11本） |
| 書き込み・応答：`ReplySlot` | `audio/replies.rs:50`（`timed_out_response_cannot_complete_a_later_request`）、`:64`（`exit_and_send_failure_release_the_waiter`）、`commands/audio/compat_tests.rs:644`（`timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request`） |
| 書き込み・応答：失敗と記録 | `audio/tests/engine_life_tests.rs:230`（W2：主の書き込みの失敗）、`audio/engine_exit.rs:782`（`send_failure_clears_the_operation_and_retires_the_connection`）、`audio/engine_exit.rs:429-771`（原因の分類 18本） |
| 書き込み・応答：モード VST の書き込みと応答（スレッド分離） | `audio/mode_vst.rs:1732`（`emergency_mute_and_stop_cancel_pending_receiver_without_waiting`）、`:2056`（`delayed_durable_write_does_not_hold_host_or_resume_canceled_transaction`）、`:2082`（`blocked_writer_keeps_early_reply_pending_and_stop_remains_immediate`）、`:2125`（`actual_full_child_pipe_does_not_block_stop_or_emergency_mute`。実際の子のパイプ）、遷移の状態機械（1442-1756） |
| reader：行の解釈・通知の順・EOF | `audio/tests/compat_tests.rs`：K1・K13（58）、K13 失敗（79）、K13 停止（95）、D2・D9（106）、A13（132）、K6（160）、K15・F12（339）、A9(b)（470）、混合の失敗（491）、残りの通知（532）、ペイロード（614）、開始中の終了（654）、VST の操作中の終了（675）、`audio/engine_exit.rs:753,771`（旧 reader の無効化・終了は1回） |
| 通知：K13 の順・D3（再起動は通知しない） | `compat_tests.rs:58-128,449-465`、`commands/audio/compat_tests.rs:471-490` |
| 定期・非同期：機器のスキャン | `audio/tests/device_scan_tests.rs:11,32,44,63,107,129,148,178` |
| 定期・非同期：warmup・最初の画面 | `audio/frontend_bootstrap.rs:463-966`（14本）、`commands/audio/compat_tests.rs:494-640` |
| 定期・非同期：OBS の到達の確認 | `obs.rs:981,1035,1079,1126,1189,1235,1264`（`reach_*`・`stopping_connection_waits_for_reach_cleanup_before_returning`） |
| 定期・非同期：スケジューラ | `audio/tests/control_tests.rs:160`、`audio/mode_vst.rs:1442-2183` |
| 子のプロセスの寿命（ロックの保持時間に関わる上限） | `audio/tests/engine_life_tests.rs`（W1a・W1b・W1b'・W1c・B17・D7・B18・B17b・W2・J-13・B40a・Drop の2秒・W4a・W4b：52-544）、`audio/tests/post_mix_life_tests.rs:59-216`（配信ミックスの W2・J-13・B40a） |
| 配信ミックスの停止・開始・復元の失敗 | `audio/tests/post_mix_life_tests.rs:59,72,84,99,114,135,160,187,216` |
| 開始の拒否（実際のサイドカー） | `tests/audio_engine_start_rejection.rs`（K6 の子の側） |

### 7.2 固定されていない性質（grep・試験名・本文の読み取りで、該当の試験が見つからなかったもの）

1. 通常の経路の書き込みに上限がないこと、満杯のパイプでホストのロックが戻らないこと（`audio.rs:1168-1174`）。モード VST の経路の満杯のパイプは固定（`mode_vst.rs:2125`）。
2. 通知 `global-mute-changed`・`global-bypass-changed`・`session-rack-change-started`・`session-rack-change-cancelled`・`session-rack-invalidated` の名前・件数・順。`live-modes-invalidated` は `kill_engine` 経由だけ。
3. `audio-error`（書き込みの失敗）の文字列と、前後の通知の順（名前の存在だけ、`engine_life_tests.rs:245`）。
4. `audio-level` の件数・間隔・順、満杯のときの件数と順（PRE-F1b-12 の (7) は計画の記述）。
5. reader のパースの失敗（`Response` の行を失う場合を含む）、`Err` の行（I/O エラー・不正な UTF-8）、1行の長さの上限。
6. 確認（`reader_active`）と `begin` の間の EOF の窓（2.4）。
7. `emitter` の `Mutex` を持ったままの `emit`、ポイズンの連鎖（`unwrap()` と `if let Ok` の混在）。
8. epoch で照合しない9種の通知が、旧 reader から出ること（A9(b) は `Conditions` の窓だけを固定）。
9. 配信ミックスの子の reader が `emit` しないこと。
10. `Mutex` の公平性・飢餓（K11 は受付順と取得順の食い違いだけ）。ロックを持つ時間の上限・上位の経路（6.3）。
11. トレイ・ショートカットが実行するスレッドの種類、トレイのミュート切替がロックを待つこと。
12. `interrupt_restore` の確認点：`live_bundle.rs:232`・`bundles/tests.rs:468` 以外（`set_output_gain` のループ・`post_mix` の `RestorePlugin` の繰り返し・`apply_profile`・トレイ・ショートカットのミュート）。
13. `retired.ensure_clear` が `Store.slots` の `Mutex` を持ったまま待つこと（時間・記録の結果は固定、ロックの保持は未固定）。
14. `set_output_gain`・`with_bundle_live` の確認ループ（100回）の上限の時間。
15. `get_audio_state`・`get_saved_audio_config` 以外の読み取りが先行する操作を待つ境界（`get_engine_tuning_config`・`get_audio_devices` のキャッシュヒット・各 `Snapshot` など。`device_scan_tests.rs:44` はキャッシュのヒットで子を起動しないことだけ）。
16. warmup・`audio_frontend_bootstrap` がロックを持つ時間、実行中の warmup が他の入口の `cancel()` で止まらないこと（5.3）。
17. スケジューラの周期（10ms）と、ロックの競合による tick の遅れ。
18. `get_routing_diagnostics`・`get_process_input_sources` がロックの中で OS を呼ぶこと。
19. 機器のスキャンの35秒の期限（Cancel）と、ポーリングの間に他の入口がロックを取ること。
20. `profile::apply_profile`・`save_profile` が途中で停止の要求を確認しないこと。

---

## 8. 気づいたこと（設計案ではなく、事実として不安な点）

1. **通常の経路の書き込みには上限がなく、ホストのロックを持って行う**（`audio.rs:1168-1174`）。子が `stdin` を読まなくなると、そのロックを待つ入口（`stop_audio`・トレイ・ショートカット・スケジューラ・各読み取り）がすべて止まる。子を `kill` する手段（`stop`・`kill_engine`）も同じロックの中にある。モード VST の経路だけが書き込みを別スレッドに分け、満杯のパイプの試験もある（`mode_vst.rs:2125`）。
2. **`ReplySlot` はタイムアウトの後も保留のまま残る**（`replies.rs:15-17,25-36`）。この間、`Stop` も `begin` で失敗する（`audio.rs:1760`→`1166`）。`reap_confirmed_stopped_connection` は reader が止まっているときだけ動く（`audio.rs:1728-1740`）。応答を返さない子に対して、`stop_audio` は `前の音声操作の応答待ちです` で失敗し、`restart_audio_engine`（`kill_engine`→`ensure_engine_running`→ `reset_engine_reader`）か EOF でしか戻らない。
3. **トレイのミュート切替は、ホストのロックを呼び出したスレッドで直接待つ**（`lib.rs:353-361`）。Tauri のメニューのコールバックのスレッドは、主のイベントループのスレッドの可能性が高い（推測）。ロックが 6.3 のように長く持たれる間は、UI のスレッドが止まりうる。`setup` の `set_event_emitter` も主スレッドで `lock` する（`lib.rs:389-394`）。
4. **`emitter` の `Mutex` は `emit` の間保持され**、`.lock().unwrap()` が音声系に 19 箇所ある（`audio.rs:569,577,824,841,859,868,890,908,913,927,951,969,977,991,1020,1054,1906`、`audio/live_modes.rs:142,150`）。`if let Ok(..)` の箇所もある（`audio.rs:1181,1895,2217`、`audio/mode_vst.rs:482,502,520,846`）。`emit` が panic すると、以後の `unwrap()` が panic し、ホスト側の panic はホストのロックを poison する（全入口が 1.7 のロック失敗の文言を返す）。
5. **接続の同一性が3つの別の仕組みで表されている**：`reader_active`（接続ごとの `Arc<AtomicBool>`、`audio.rs:1150-1152`）、`Conditions.engine_epoch`（`new_engine`・`retire_engine`、`conditions.rs:123-132`）、`engine_generation`（`wrapping_add`、`audio.rs:778,2810`）。reader の通知のうち、epoch を照合するのは `Started`・`Stopped`・`Error`・`Mixing*` だけで、他の9種（`audio-level`・`audio-loudness`・`audio-channel-scan`・`audio-control-stall`・`voice-check-state`・`voice-check-envelope`・`plugin-editor-opened`・`plugin-editor-closed`・`audio-processing-health`）は、旧 reader が次の行を読むまで出うる（`audio.rs:795,815-1034`）。
6. **`Mutex` は公平でなく**（6.1）、スケジューラは 10ms ごとにロックを取り合う（`audio/control.rs:233-239`）。受付の記録の順とロックの取得の順は一致しない（K11）。
7. **停止・ミュートの意図（`interrupt_restore`）を登録するのは3コマンドだけ**（`commands/audio.rs:509,854,871`）。トレイ・ショートカットのミュート、`apply_profile` は登録しない。配信セットの復元が確認する点は 1.6 の列挙のとおりで、`execute_running_command` の内側・`set_output_gain` のループ・`post_mix` の子への `RestorePlugin` の繰り返し（最大32回）には確認がない。
8. **`retired.ensure_clear` は `Store.slots` の `Mutex` を持ったまま、50ms ごとの `sleep` で最大10秒待つ**（`engine_life.rs:128-144,172-189`）。ホストのロックも持っている。
9. **確認（`reader_active`）と `begin` の間の EOF**で、書き込みが成功したまま応答が来ない窓がある（2.4。推測）。
10. **パースに失敗した `Response` の行は、ログだけで失われる**。待ち手は10秒待ち、スロットは保留のまま残る（`audio.rs:1037-1039`、2.3）。`BufRead::lines` は1行の長さに上限がない。
11. **ロックの中で OS を呼ぶ入口**：`get_routing_diagnostics`（`commands/audio.rs:1212-1224`）・`get_process_input_sources`（`audio/process_inputs.rs:22-58`）。所要時間は確かめていない。
12. **warmup と `audio_frontend_bootstrap` は、ロックの中でファイルの読み取りと Start の全手順を行い**（`audio.rs:2825-2916`）、実行中は他の入口の `cancel()` で止まらない（5.3）。最初のコマンドは、その完了まで待つ（K2 と同じ境界）。
13. **ショートカットの動作は、`gate` の `Mutex` とホストのロックを持ったまま `emit` する**（`shortcuts.rs:430-436,502-521`）。キャプチャの開始・終了（`begin_shortcut_capture`・`end_shortcut_capture`）は `gate` を `lock()` で待つ（`shortcuts.rs:128-132,151-155`）。
14. **配信ミックスの子の通知は UI に届かない**（子の `emitter` が `None`、`audio.rs:523`、`lib.rs:393`）。子が出す `ControlStall`・`Error` は、親では `ReplySlot` と `Conditions`（子自身の）に反映されるだけ。
15. **`ensure_engine_running` は、子の生成の前に `conditions.new_engine()` と通知を行う**（`audio.rs:765-767`）。生成が失敗しても、世代が進み、`audio-conditions-changed` が出る。
16. **`set_output_gain` と `with_bundle_live` の確認ループは、ロックを持ったまま最大100回**（`audio.rs:2111-2123`、`audio/live_bundle.rs:154-182`）。各回が IPC を含む。
17. **`bundles.rs` のコマンド全体が `tokio::Mutex`（`BundleState`）を持つ**（`bundles.rs:2017`）。音声のロックと別の層で、`Apply`・`Undo`・`Save`・`Preview` が直列になる。

## 9. 調べきれなかったこと

- 実行はしていない（コードの読み取りだけ）。時間・競合・実機の挙動は確かめていない。6.3 の上限は理論値。
- スレッドの種類：Tauri の `on_menu_event`・同期コマンド・`setup` が動くスレッドは、Tauri のコードを読んでいない（推測）。
- `Mutex` の実装：`1.100.0`（プロジェクト）の std ソースは読めず、`1.99.1` で確認した（6.1）。
- `AppHandle::emit` が内部で取るロック・待ち、`routing_diag::collect_routing_diagnostics`・`process_capture::candidates` の所要時間は読んでいない。
- 子（`audio_engine`）側の命令ごとの最大の処理時間（VST の読み込み・STA の turn・大きな状態）と、10秒を超えたときの子の挙動。
- `profile.rs:49-140`（`capture_profile_parts`）の IPC の回数は概算。`bundle.rs`・`obs_setup` がホストを間接的に触るか（`Entry` の grep では見つからなかった）。
- フロントエンド（`src/`）の呼び出しの順序・`await` の使い方・再試行。
- `src-tauri/tests/*.rs` の統合試験の中身（`maintenance.rs` ほか）。
- 試験の網羅は、試験名と本文の grep による。7.2 に挙げなかった性質が、別の試験で固定されている可能性は残る。

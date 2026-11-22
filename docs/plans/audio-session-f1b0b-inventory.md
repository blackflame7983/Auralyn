# F1b-0b の設計の前に確かめた、今のコードの事実（洗い出し）

- 対象：`bcd2dca2`（ローカルのブランチ `codex/audio-session-f1b0a2`。F1b-0a-1・F1b-0a-2 の実装の後。まだ main に入っていない）。ブランチ `codex/audio-session-f1b0b-design`（main `4273a707` から）。
- この文書は事実だけを書く。設計案は書かない（気づいたことは 6 章に、事実として不安な点だけを分けて書く）。
- 行は `bcd2dca2` の時点。パスは `src-tauri/src/` からの相対（例：`audio.rs:1155` は `src-tauri/src/audio.rs` の1155行）。`audio/` は `src-tauri/src/audio/`。
- 「推測」と書いたものは、コードを読んだだけでは確かめきれていない。製品のコード・試験は動かしていない（読み取りだけ）。
- 前の洗い出し（`audio-session-f1b0-inventory.md`、`292dfdb2`。以下「0洗い出し」。`audio-session-f1b0a2-inventory.md`、`189fee43`。以下「0a2洗い出し」）と同じ内容は繰り返さず、「0洗い出しの何章のとおり」と参照する。**0洗い出しの `audio.rs` の行番号はすべて動いている**（`audio.rs` は 794 行が変わった。`git diff --stat 292dfdb2 bcd2dca2`。下の 0 章）。`audio.rs` 以外で入口に関わるファイル（`lib.rs`・`commands/*`・`shortcuts.rs`・`obs.rs`・`updates.rs`・`migration.rs`・`temporary_session.rs`・`profile.rs`）は `292dfdb2` から `bcd2dca2` まで差がない（`git diff --stat 292dfdb2 bcd2dca2 -- src-tauri/src` の28ファイルがすべて `audio.rs`・`audio/`・`commands/audio/compat_tests.rs`）。

用語：

| 語 | 意味 |
|---|---|
| 保持者 | ホストのロック（`Arc<Mutex<AudioHost>>`、`audio/control.rs:174`）を持つスレッド。入口の呼び出し元・warmup・トレイ・ショートカット・更新・スケジューラ（モード VST の tick）の全部 |
| tick | モード VST のスケジューラ（10ms ごとにホストのロックを取って `poll_mode_vst`、`audio/control.rs:231-240`、`audio/mode_vst.rs:519`） |
| reader | 子の stdout を読むスレッド（接続ごとに1本。名前なし、`audio/reader.rs:22-24`）。ホストのロックは持たない・取らない |
| writer | 子の stdin へ書くスレッド（接続ごとに1本。名前 `auralyn-engine-writer`、`audio/writer.rs:149-156`）。ホストのロックは持たない |
| E | `AudioHost::execute_command`（`audio.rs:1005-1045`）。子が居なければ起動し、`sync_live_modes` を行う |
| R | `AudioHost::execute_running_command`（`audio.rs:1048-1056`）。起動しない。閉じた接続では `replies::CLOSED` で失敗する（`audio.rs:1068`） |
| 主 / 配信ミックスの子 | 主の `AudioHost`（アプリに1つ）/ `post_mix::State.child` が持つ2つ目の `AudioHost`（`audio/post_mix.rs:294`、`audio/control.rs:256-260`） |

---

## 0. 前の洗い出しから変わったところ（要約）

| 領域 | 0洗い出し・0a2洗い出し（前） | 今（`bcd2dca2`） |
|---|---|---|
| 子への書き込み（0洗い出し 2.1） | 呼び出したスレッドが、ホストのロックを持ったまま `BufWriter` に書く。書き込みの上限なし | 接続ごとの writer（`audio/writer.rs:94-158`）。列の容量は1（`writer.rs:146`）、送る側は `try_send`（`writer.rs:178-187`）。呼び出し側は書き込みの完了を最大5秒待つ（`writer.rs:13`、`audio.rs:1103-1117`）。**ホストのロックを持ったまま最大5秒**で、超えれば切り離す（C2）。モード VST も同じ writer（`audio/mode_vst.rs:700-726`）で、使い捨ての書き込みスレッドはない |
| 接続の開閉（0洗い出し 3.1） | `reader_active: Arc<AtomicBool>` と `unexpected_exit(&AtomicBool)` | `LinkState`（`AtomicU8` の CAS、`audio/link.rs:45-70`）。閉じた理由は5種（`link.rs:6-18`）。`Arc<LinkState>` を host・reader・writer・`post_mix::State.rack_pin` が共有（`audio.rs:292`、`reader.rs:9`、`writer.rs:133`、`post_mix.rs:310`） |
| 応答の待ち（0洗い出し 2.3） | `Mutex<Option<Sender>>`。期限の後も待ちが残る | `Idle`/`Waiting`/`Closed`（`audio/replies.rs:22-26`）。`ReplyOutcome::{Response{received_at}, Eof}`（`replies.rs:12-20`）。期限切れで閉じる（C3、`audio.rs:1155-1177`） |
| 応答の期限（0洗い出し 2.2） | 全命令で10秒 | A 10秒・B 30秒・C（`ProbeLoopback`）録音の時間＋10秒（`audio/deadline.rs:12-24`、`writer.rs:30-36`）。モード VST の1段も同じ（`mode_vst.rs:706`） |
| reader（0洗い出し 3.1・4） | `audio.rs` の中のクロージャ。`emitter.lock().unwrap()` を持ったまま `emit` | `audio/reader.rs` の `Reader`。各行の前に `link.is_open()`（`reader.rs:33`）、通知の列の直前（`order` を取った後）にも確認（`reader.rs:27-29`、`audio/emit.rs:110-123`）。`emitter` の `Mutex` は複製の間だけ（`emit.rs:93-98`） |
| 通知の発行口（0洗い出し 4・6.2） | `Arc<Mutex<Option<AudioEmitter>>>` | `Arc<Notifier>`（`emit.rs:65-71`）：`emitter` の `Mutex` と通知の列の `order`（`Mutex<()>`）。poison は `into_inner`（`emit.rs:86-91,93-98,101-107`） |
| 子の回収（0洗い出し 1.3） | `kill_primary_engine` が通知を出しながら進む | `close_connection`（`audio.rs:709-715`）→ `drop_connection`（`audio.rs:718-725`）。`kill_primary_engine` は `hold_notices`（`audio.rs:676-702`）の中で状態を変え、通知は回収の後に出す（`audio.rs:2797-2822`） |
| 主の子の stdout だけ閉じた（C5） | 次の操作が失敗し続ける | `ensure_engine_running` が回収して作り直す（`audio.rs:893-902`） |
| 起動の確認（J-24） | なし | `confirming_start`（`audio.rs:303`）、`ensure_engine_running` の中（`audio.rs:948-977`） |
| 配信ミックスの子への命令 | 各所が `child.execute_running_command` | `post_mix::State::exec_child`（`audio/post_mix.rs:429-456`）に集約。`settle`・`detach_with`・`detached`・`disconnected`・`rack_pin`（`post_mix.rs:305-310,458-481`） |
| 入口（0洗い出し 1.1〜1.6） | ロックを取る 95 箇所＋`note` 1 | **同じ**（`Entry::command`／`bundle`／`new` の呼び出しを数え直した。3 章） |

通知の全箇所（0洗い出し 4 章の 32 箇所・23 種）は、reader が `reader.rs` に移り、ホスト側が `notice()`（`audio.rs:659-673`）を通る形に変わった。今回は数え直していない（5 章に影響する部分だけ 4 章で触れる）。

---

## 1. 状態の持ち主の地図

### 1.1 ロックと atomic の全部

| 名前 | 種類 | 場所 | 持つ間にすること | 取る・書く者 |
|---|---|---|---|---|
| ホストのロック | `std::sync::Mutex<AudioHost>`（公平でない。0洗い出し 6.1） | `audio/control.rs:174` | 入口の処理の全部（IPC の待ち・ファイル I/O・子の回収を含む） | 保持者。`Ticket::lock`（`control.rs:248-252`） |
| `Admission` | `next_seq: AtomicU64`・`counts: [AtomicU64; 12]`・`log: Mutex<VecDeque<Record>>`（葉） | `control.rs:65-71` | 採番と追記だけ（`control.rs:97-116,138-145`） | 受付（ロックの前）。`push_granted` はロックの後 |
| `LinkState` | `AtomicU8` | `audio/link.rs:45` | — | host（`close`）・reader（`close(Eof)`）・writer（読むだけ） |
| `ReplySlot` | `Mutex<Idle/Waiting/Closed>`（葉） | `audio/replies.rs:28` | `begin`・`deliver_at`・`cancel`・`close` の間だけ | 保持者・tick・reader |
| `Operations` | `Mutex<State{in_flight,awaiting,settling,plugins}>`（葉） | `audio/engine_exit.rs:42-50` | `begin`・`response`・`timeout`・`take_exit` の間だけ（`engine_exit.rs:317-354`） | 保持者・reader |
| `Conditions` | `AtomicU64`×3（`revision`・`pending`・`engine_epoch`）・`AtomicBool`（`running`）・`AtomicU64`（`interrupt`）。すべて `SeqCst` | `audio/conditions.rs:31-37` | — | 保持者・reader・コマンド層（ロックの前） |
| `Notifier.emitter` | `Mutex<Option<AudioEmitter>>`（複製する間だけ） | `audio/emit.rs:66` | `AudioEmitter` の複製だけ（`emit.rs:93-98`） | `set_event_emitter`（保持者、`audio.rs:650-652`）・全発行者が複製 |
| `Notifier.order` | `Mutex<()>` | `emit.rs:67` | 通知の列の全体（`AppHandle::emit` を含む。`emit.rs:101-123`）。持つ間に取ってよいのは `emitter` だけ（`emit.rs:61-63`） | reader（`chain_if`・`chain`）・保持者（`notice`・`dispatch` の通知・`hold_notices` の保持分） |
| `held_notices` | `Mutex<HeldNotices{depth,notices}>` | `audio.rs:273-277,301` | 保持の深さと通知の控えだけ（`audio.rs:659-702`） | 保持者だけ（`&self` から書くための `Mutex`） |
| `Store.slots` | `Mutex<[Vec<Retired>;2]>`。主と配信ミックスの子の `AudioHost` で共有（`Arc<Store>`） | `audio/engine_life.rs:152-154` | **`ensure_clear` は持ったまま `settle`（50ms ごとの `sleep`、最大10秒／記録）**（`engine_life.rs:128-144,172-189`）。`recheck` は待たない | 保持者だけ（`audio.rs:912,2778,2966`、`engine_life.rs:243-261`） |
| `voice_activity` | `Arc<AtomicBool>`（接続ごとに差し替え） | `audio.rs:290,933` | — | reader（`reader.rs:196`）・保持者 |
| writer の列 | `mpsc::SyncSender<Job>`（容量1）。`WriteDone` は `Job` ごとの `mpsc` | `writer.rs:94-96,146` | — | 保持者・tick（`submit`）／writer（受信） |
| 応答の受け側 | `ReplySlot::begin` が作る `mpsc::channel`。1件ごと | `replies.rs:48` | — | 保持者・tick（受信）／reader（送信） |
| 機器スキャンの `terminal` | `Arc<OnceLock<Result<AudioDeviceList,String>>>`。呼び出し側のチケットと共有 | `audio.rs:57-62` | — | 保持者だけが `get`/`set`（`audio.rs:1282,1324,1354,1364`）。呼び出し側（tokio）は読まない |
| `Shortcuts` | `Mutex<Status>`・`AtomicBool`・`AtomicU64`・`Mutex<CaptureGate>` | `shortcuts.rs:73-79` | 4章・1.7 | OS 通知のコールバック・`spawn_blocking`・キャプチャのコマンド |
| `BundleState` | `tokio::sync::Mutex<Session>`。`broadcast_bundle` の最後まで | `commands/bundles.rs:14,2017` | 音声のロックの取得・OBS・`sleep` | `broadcast_bundle` |
| OBS | `ObsState.client`・`reach_task` ほか（`tokio::sync::Mutex`） | `obs.rs:160-190` | OBS の通信 | OBS のコマンド・タスク |
| 診断用の静的カウンタ | `static TRACE_SEQ: AtomicU64` | `emit.rs:10,22` | — | `trace_mark`（`AURALYN_EMIT_TRACE=1` のときだけ。reader・保持者の両方） |

### 1.2 主の `AudioHost` の直下の項目（40）

`AudioHost` は `audio.rs:279-331`。試験専用の `kept_writers`・`test_engine_launcher`（`audio.rs:305-308`）は数えない（40 のほか2）。「保」は保持者（ホストのロックを持つ）。「ロックなし」の書き手がいる行に **★**。

| # | 項目（型）・宣言行 | 書く者 | 読む者 | 守り |
|---|---|---|---|---|
| 1 | `post_mix: post_mix::State`（280） | 保：`post_mix.rs` の各メソッド、`kill_engine`（`audio.rs:2791`）、`Drop`（`audio.rs:2964`）。中身は 1.4 | 保：`post_mix_start.rs:20-35`、`post_mix`（`post_mix.rs:976-`） | ホストのロック |
| 2 | `post_role: bool`（281） | 作成時に1回だけ（`control.rs:258`） | 保：`role()`（`audio.rs:637-643`）・`audio.rs:893,1170,2956` | 変わらない |
| 3 | `post_attached: bool`（282） | 保：`audio.rs:2799`（`kill_primary_engine`）、`post_mix_start.rs:17,30,46,49,68` | 保：`post_mix_start.rs:5,22` | ホストのロック |
| 4 | `bundle_mixing_override: bool`（283） | 保：`audio/mixing_bundle.rs:236,239` | 保：`audio.rs:2282,2288,2296`、`mixing.rs:415,449`、`mixing_bundle.rs:97` | ホストのロック |
| 5 | `bundle_prepared_voice: bool`（284） | 保：`mixing_bundle.rs:153,237,240`、`audio.rs:2790` | 保：`audio.rs:2288` | ホストのロック |
| 6 | `conditions: Arc<Conditions>`（285） | 保：`new_engine`（`audio.rs:914`）・`retire_engine`（`audio.rs:2810,2955`）・`dispatch`（`audio.rs:1051`）・tick（`mode_vst.rs:391,441`）。**★ reader**：`engine_event`・`engine_changed`（`reader.rs:89,104,136,173,296`）。**★ コマンド層**：`interrupt_restore`（`conditions.rs:81-84`、`commands/audio.rs:509,854,871`）と `Pending::drop`（`conditions.rs:72-77`） | 保：`get_state`（`audio.rs:2926-2933`）・`restore_interrupt`（`audio.rs:2321,2341`）。**ロックなし**：OBS の `timing_targets`（`lib.rs:137-143`、`obs_setup.rs` の `conditions.snapshot()`）・OBS が保持する `Witness`（`obs.rs:35-38`） | atomic（`SeqCst`）。複数の読み取りの一貫性は `pending`・`revision` の前後比較（`conditions.rs:176-192`） |
| 7 | `last_config_path: PathBuf`（286） | 作成時だけ | 保：`audio.rs` の設定ファイルの読み書き | 変わらない |
| 8 | `maintenance: bool`（287） | 保：`audio.rs:2775,2779,2786`（`prepare_update`・`finish_update_attempt`） | 保：`audio.rs:877,2749`、`engine_exit.rs:208` | ホストのロック |
| 9 | `live_modes: HostModes`（288） | 保：`audio/live_modes.rs`・`audio.rs:1042,2809`・`live_bundle.rs:128,221`・`mode_vst.rs:332,881,1034-1035` | 保：多数（`guard_live_command`・`sync_live_modes` ほか） | ホストのロック |
| 10 | `mode_vst: mode_vst::State`（289） | 保・tick：`poll_mode_vst`・`cancel_mode_vst`・`begin_mode_vst`。ディスクの書き込みはスレッドで行い、結果を tick が `try_recv`（`mode_vst.rs:727-783`） | 保：`guard_mode_vst`（`mode_vst.rs:249-252`、ほぼ全入口の先頭） | ホストのロック。**★ 書き込みスレッド**は `live-mode-vst-journal.json` を書く（1.7） |
| 11 | `voice_activity: Arc<AtomicBool>`（290） | 保：`audio.rs:933`（差し替え）・`2403,2494`（`store(true)`）・`2819`（`store(false)`）。**★ reader**：`reader.rs:196` | 保：`check_can_interrupt`（`audio.rs:2754`） | atomic。接続ごとに `Arc` を差し替える（`audio.rs:933`） |
| 12 | `link: Arc<LinkState>`（292） | 保：`close_connection`（`audio.rs:710`）・`reply_timed_out`（`audio.rs:1156`）・`cut_off`（`audio.rs:1183`）・`fail_mode_deadline`（`mode_vst.rs:693`）・差し替え（`audio.rs:1062`）。**★ reader**：`close(Eof)`（`reader.rs:282`） | 保・tick：`connection_lost()`（`mode_vst.rs:697-699`。`connection_lost(` の一致は定義を含めて 47 行）・`is_open`（`audio.rs:1068`）。reader（`reader.rs:28,33`）・writer（`writer.rs:191`） | `AtomicU8` の CAS（一度だけ閉じる） |
| 13 | `vst_operations: Arc<Operations>`（293） | 保：`begin`（`audio.rs:1076`）・`response`（`audio.rs:1182`）・`timeout`（`audio.rs:1158`）・差し替え（`audio.rs:1063`）。**★ reader**：`response`（`reader.rs:46`）・`take_exit`（`reader.rs:294`） | reader（`take_exit`） | `Operations` の `Mutex`（葉） |
| 14 | `child: Option<Child>`（294） | 保：`audio.rs:889,924`（`ensure_engine_running`）・`drop_connection`（`audio.rs:720`）・`take_engine_for_shutdown`（`audio.rs:2983`） | 保：`get_state`（`audio.rs:2924`）・`try_wait`（`audio.rs:884`）・`audio.rs` に約20（grep の件数。`post_mix.rs` などの `.child` は別の構造体の項目を含む） | ホストのロック |
| 15 | `writer: Option<writer::Writer>`（296） | 保：`close_connection`（`audio.rs:713`、`None`）・`ensure_engine_running`（`audio.rs:932`） | 保・tick：`submit_write`（`audio.rs:1086`）・`send_mode_command`（`mode_vst.rs:702`） | ホストのロック（書き込みそのものは writer スレッド。1.7） |
| 16 | `pending_reply_tx: Arc<ReplySlot>`（298） | 保：差し替え（`audio.rs:1061`）・`begin`（`audio.rs:1075`、tick は `mode_vst.rs:701`）・`cancel`（`mode_vst.rs:703,716`）・`close`（`audio.rs:712`）。**★ reader**：`deliver_at`（`reader.rs:47`）・`close`（`reader.rs:284,293`） | 同上 | `ReplySlot` の `Mutex`（葉） |
| 17 | `emitter: Arc<Notifier>`（299） | 保：`set`（`audio.rs:650-652`、主だけ。`lib.rs:393`） | 保：`notice`（`audio.rs:672`）・`dispatch` の通知（`audio.rs:1050,1054`）・`hold_notices`（`audio.rs:695`）。**★ reader**：`chain_if`・`chain`（`reader.rs:28,297`） | `emitter` の `Mutex`＋通知の列の `order`（1.1） |
| 18 | `held_notices: Mutex<HeldNotices>`（301） | 保：`hold_notices`・`notice`（`audio.rs:659-702`） | 保 | `Mutex`（保持者だけが触る） |
| 19 | `confirming_start: bool`（303） | 保：`audio.rs:954,956` | 保：`audio.rs:1162,1170,1185` | ホストのロック |
| 20 | `cached_devices: Option<AudioDeviceList>`（309） | 保：`audio.rs:1229,1353` | 保：`audio.rs:1210,1239` | ホストのロック |
| 21 | `engine_generation: u64`（310） | 保：`audio.rs:926`（起動）・`audio.rs:2812`（`kill_primary_engine`） | 保・tick：`audio.rs` に23、`frontend_bootstrap.rs`・`live_modes.rs`・`mode_vst.rs:525`・`session_rack.rs`・`post_mix.rs`・`output_bundle.rs`。reader は起動時の値の複製を持つ（`audio.rs:942`、`reader.rs:16`） | ホストのロック（reader は複製） |
| 22 | `bundle_change_generation: Option<u64>`（311） | 保：`audio.rs:1590,2340,2347` | 保：`audio.rs:1023,1584,1588,1808,2319,2337,2636`・`engine_exit.rs:219`・`live_bundle.rs:115`・`output_bundle.rs:100`・`mode_vst.rs:345` | ホストのロック |
| 23 | `next_restore_operation: u64`（312） | 保：`audio.rs:1814`・`mode_vst.rs:950`・`session_rack.rs:209,240`・`post_mix.rs:488` | 保：同じ箇所・`mode_vst.rs:1172` | ホストのロック |
| 24 | `session_restore: Option<Lease>`（313） | 保：`session_rack.rs:67,214,304` | 保：`audio.rs:430`・`mode_vst.rs:345`・`session_rack.rs:15,64,…` | ホストのロック |
| 25 | `session_restore_generation: Option<u64>`（314） | 保：`session_rack.rs:119,161` | 保：`session_rack.rs:32,53` | ホストのロック |
| 26 | `peak_intent`（315） | 保：`audio.rs:452` | 保：`audio.rs:978` | ホストのロック |
| 27 | `true_peak_intent`（316） | 保：`audio.rs:467` | 保：`audio.rs:990` | ホストのロック |
| 28 | `frontend_bootstrap: Startup`（317） | 保：`cancel`（`audio.rs:1008,1386,1410,1762,2805,2901,2918`・`engine_exit.rs:217`・`live_modes.rs:241`・`mode_vst.rs:399`・`frontend_bootstrap.rs:151,162`）・`session_claimed`（`audio.rs:1763,2806,2919`・`mode_vst.rs:400`・`session_rack.rs:44,120,162`） | 保：warmup・`audio_frontend_bootstrap` | ホストのロック |
| 29 | `device_scan: Option<DeviceScanTicket>`（318） | 保：`audio.rs:927,1258,1326,1340,1362,2813` | 保：`audio.rs:1243,1268` | ホストのロック |
| 30 | `active_config: Option<ActiveAudioConfig>`（319） | 保：`audio.rs:1702`・`frontend_bootstrap.rs:675,713`・`process_bundle.rs:136`・`process_inputs.rs:150` | 保：`get_state`（`audio.rs:2925`）ほか | ホストのロック |
| 31 | `process_inputs: Inputs`（320） | 保：`process_inputs.rs:22-58` | 保：`process_bundle.rs` ほか | ホストのロック |
| 32 | `mixing: mixing::State`（321） | 保：`mixing.rs`・`mixing_bundle.rs:256-260`（作り直し）・`kill_engine`（`audio.rs:2792`、`selected = None`） | 保：`audio.rs:2239,2282` ほか | ホストのロック |
| 33 | `is_global_muted: bool`（322） | 保：`audio.rs:1705,1900,1910`・`mixing_bundle.rs:251`・`mode_vst.rs:418,501,883` | 保：`audio.rs:389,1629,1921`・`frontend_bootstrap.rs:400`・`live_bundle.rs:114`・`output_bundle.rs:98`・`process_bundle.rs:74` ほか | ホストのロック（トレイ・ショートカットのミュートも保持者として書く） |
| 34 | `engine_tuning: EngineTuningConfig`（323） | 保：`audio.rs:2628` | 保：`audio.rs:730-754`（子の起動の環境変数）・`2632` | ホストのロック |
| 35 | `bundle_output_override`（324） | 保：`output_bundle.rs:105,125` | 保：`audio.rs:1601`・`output_bundle.rs:99` | ホストのロック |
| 36 | `bundle_monitor_override`（325） | 保：`live_bundle.rs:129,200` | 保：`audio.rs:1620`・`live_bundle.rs:116` | ホストのロック |
| 37 | `bundle_interrupt: Option<u64>`（326） | 保：`audio.rs:2341,2348` | 保：`audio.rs:2321` | ホストのロック |
| 38 | `output_gain_initialized: bool`（327） | 保：`audio.rs:925,1706,2113,2203,2208,2800` | 保：`audio.rs:2154` | ホストのロック |
| 39 | `engine_job: Option<JobHandle>`（328） | 保：`audio.rs:721,890,901,919,2820,2985` | 保（持ち主として Drop で子と同時に解放） | ホストのロック |
| 40 | `retired: Arc<Store>`（330） | 保：`retire_child`（`audio.rs:647`、`engine_life.rs:243-261`）・`ensure_clear`（`audio.rs:912`）・`recheck`（`audio.rs:2778`）・`drain`（`audio.rs:2966`） | 保：`pending`・`unconfirmed_error`（`audio.rs:953,972,1160,1173,1184,1191`） | `Store.slots` の `Mutex`（実際は保持者だけが触る。主と配信ミックスの子が共有） |

**接続ごとに作り直す項目**（`ensure_engine_running` の `reset_engine_reader`、`audio.rs:1058-1064`、と `audio.rs:932-933`）：`link`・`pending_reply_tx`・`vst_operations`・`writer`・`voice_activity`。作り直しても、`conditions`・`emitter` は同じ `Arc`（reader の `conditions`・`notifier` は新旧で共有。`audio.rs:939-940`）。

### 1.3 接続ごとの共有（reader・writer が持つもの）

| 部品 | 持つもの | 場所 |
|---|---|---|
| reader（`Reader`） | `link`・`operations`（`vst_operations`）・`replies`（`pending_reply_tx`）・`voice_activity`・`notifier`・`conditions`・`epoch`（`new_engine` の値）・`engine_generation`（起動時の複製） | `reader.rs:8-19`、`audio.rs:934-945` |
| writer | `BufWriter<ChildStdin>`（唯一の持ち主）・`LinkState`（閉じていれば書かない） | `writer.rs:145-158,190-199` |
| 呼び出し側の1件ごとの口 | 応答の受け側（`ReplyOutcome`）・書き込みの完了の受け側（`WriteDone{result,flushed_at}`） | `audio.rs:1075-1079`、`writer.rs:53-65` |

reader は `child`・`writer`・`engine_generation`・`mode_vst`・`post_mix` を触らない。触るのは `link`（CAS）・`replies`・`operations`・`voice_activity`・`conditions`・`notifier` の6つだけ。

### 1.4 内側の状態の持ち主（`AudioHost` の項目の中身。すべてホストのロックだけで守る）

| 構造体（宣言） | 項目（数） | 主な書き手 |
|---|---|---|
| `post_mix::State`（`post_mix.rs:292-319`） | `path`・`child`・`retired`・`raw`・`saved`・`epoch`・`revision`・`enabled`・`restored`・`running`・`error`・`disconnected`・`detached`・`rack_pin`（14。ほか試験用3） | `exec_child`・`settle_with`・`detach_with`（`post_mix.rs:429-481`）、`discard_child`（`post_mix.rs:797-804`）、公開の操作（`post_mix.rs:1009-1157`） |
| `mode_vst::State`（`mode_vst.rs:44-57`） | `path`・`journal`・`blocked`・`transaction`・`status`・`cached`・`orphan_disk`（7） | tick（`poll_mode_vst`、`mode_vst.rs:519-689`）、`cancel_mode_vst`（`mode_vst.rs:489-515`）、`fail_mode_transaction`・`complete_mode_transaction`（`mode_vst.rs:831-899`） |
| `HostModes`（`live_modes.rs:11-26`） | `path`・`definitions`・`load_error`・`generation`・`intents`・`epoch`・`engine_epoch`・`retired`・`reservation`・`next_reservation`・`needs_sync`・`armed`・`bound`・`target`（14） | `observe_live_generation`（`live_modes.rs:71-83`）・`invalidate_live_protection`（`live_modes.rs:125-150`）・`begin_live_changes`／`end_live_changes`（`live_modes.rs:240,263`） |
| `Startup`（`frontend_bootstrap.rs:5-16`） | `frontend_seen`・`canceled`・`warmup_seen`・`automatic_attempted`・`warmup_succeeded`・`input_gain`・`output_gain`・`session_claimed`・`warmup_error`・`deferred_config`（10） | `cancel`（`frontend_bootstrap.rs:18-21`）、warmup（`audio.rs:2831-2915`）、`frontend_bootstrap`（`frontend_bootstrap.rs:169-`） |
| `mixing::State`（`mixing.rs:5-13`） | `path`・`raw`・`saved`・`selected`・`epoch`・`revision`・`error`（7） | `mixing`（`mixing.rs:146-`）、`kill_engine`（`audio.rs:2792`） |
| `Inputs`（`process_inputs.rs:6-10`） | `serial`・`candidates`・`selected`（3） | `process_input_sources`（`process_inputs.rs:22-58`） |
| `Lease`（`session_rack.rs:6-12`） | `token`・`generation`・`ids`・`revision`・`expires`（5） | `session_rack`（`session_rack.rs:62-`） |

### 1.5 ホストの外の共有状態

| 状態 | 持ち主・守り | 書く者 | 読む者 |
|---|---|---|---|
| `Admission`（`control.rs:65-71`） | `Arc<Admission>`（`AudioControl` と `WeakAudioControl` が共有）。`next_seq`・`counts`（atomic）、`log`（`Mutex`、最大256件、`control.rs:62`） | 受付（`accept`）・`push_granted`（`control.rs:97-116,138-145`）。ロックなしで書く（1.7） | **製品のコードには読み手がいない**（`accepted`・`accepted_of`・`records` の呼び出しは試験だけ。`control.rs:148-162` の定義と `audio/tests/control_tests.rs`・`commands/audio/compat_tests.rs:127`） |
| `Shortcuts`（`shortcuts.rs:73-79`） | `Mutex<Status>`・`AtomicBool`（`.1`）・`AtomicU64`（`.2`＝歌・雑談の意図の連番）・`Mutex<CaptureGate>`（`.3`） | `dispatch`（OS 通知のコールバック。`shortcuts.rs:384-411,414`）・動作（`spawn_blocking`。`shortcuts.rs:430-436`）・キャプチャのコマンド（`shortcuts.rs:118-155`） | 同じ |
| `BundleState` | `tokio::sync::Mutex<Session>`（`commands/bundles.rs:14`）。`broadcast_bundle` の最後まで（`bundles.rs:2017`） | `broadcast_bundle` | 同じ |
| OBS の状態 | `obs.rs:160-190` | OBS のコマンド | `Witness`（`obs.rs:35-38`）を介して `Conditions` を読む |
| アプリ全体 | `AudioState(AudioControl)`（`audio.rs:3068`）、`ConditionState(Arc<Conditions>)`（`conditions.rs:40`、`lib.rs:312-313`） | `lib.rs` の `setup`（`lib.rs:308-315`） | 各コマンド（`State<AudioState>`）・スケジューラの `Weak`（`control.rs:178-190,231-240`） |

### 1.6 配信ミックスの子の側

- 子 `AudioHost` は主と同じ型で、`post_role = true`（`control.rs:256-260`）。独自の `Mutex` を持たず、主のロックの内側だけで動く。起動は `post_mix::State::child()`（`post_mix.rs:519-542`、`exec`＝`ensure_engine_running`）。
- 子が自前で持つ（主と別）：`conditions`（`audio.rs:561`）・`link`・`pending_reply_tx`・`vst_operations`・`writer`・`voice_activity`・`emitter`（`Notifier` は空。`set_event_emitter` は主だけ、`lib.rs:393`。子の通知は UI に届かない）・`held_notices`・`mode_vst`・`live_modes`・`frontend_bootstrap`・`mixing`・`post_mix`・`process_inputs` ほか、1.2 の40項目の全部。
- 主と共有する：`retired`（`Arc<Store>`。`control.rs:256-260`、`audio.rs:592`）だけ。役割（`Role::PostMix`）ごとのスロット（`engine_life.rs:12-25`）。
- 子の reader は主と同じコード（`reader.rs`）で、`link`・`replies`・`operations`・`conditions` はすべて子のもの。`emit` は出さない（`Notifier` が空。`emit.rs:78-82`）。
- 子の状態を書く者：主のロックを持つ保持者（`exec_child` 経由。`post_mix.rs:429-456`）・`kill_engine`（`post_mix.kill` → `discard_child` → `child.kill_engine()`、`audio.rs:2791`、`post_mix.rs:797-804`）・`Drop`（`audio.rs:2964`）。子の tick・スケジューラは存在しない（スケジューラは主だけ。`control.rs:231-240`）。
- 子の `AudioHost` も作成時に `mode_vst::State::new`（ジャーナルのファイルを `try_exists` で調べる）・`HostModes::new`・`mixing::State::new`・`post_mix::State::new`（保存ファイルを読む）を行う（`audio.rs:557-606`）。子で使われているかは、上の「子の状態を書く者」の経路では確かめていない（推測：使われない）。

### 1.7 ロックを持たずに書く場所（11 か所）

「ロックを持たない」は、ホストのロック（`control.rs:174`）を持たないという意味。自分の葉のロック・atomic は持つ。

| # | 場所 | 書く者・スレッド | 書く内容 | 守り | 位置 |
|---|---|---|---|---|---|
| 1 | ★ `LinkState` の CAS | reader（EOF の競り） | `Open → Closed(Eof)` | `AtomicU8` の `compare_exchange`（host の `close` と競る。勝敗が決めるのは通知を出す者） | `reader.rs:282` |
| 2 | ★ `ReplySlot` | reader | `close`（待ちを `Closed` にして送り側を取り出す）・`deliver_at`（応答を渡す） | `ReplySlot` の `Mutex`（葉） | `reader.rs:47,284,293` |
| 3 | ★ `Operations` | reader | `response`（`in_flight` の解除・VST の対応表）・`take_exit`（原因の取り出し） | `Operations` の `Mutex`（葉） | `reader.rs:46,294` |
| 4 | ★ `Conditions`（reader 側） | reader | `engine_event`（`pending`・`revision`・`running`）・`engine_changed`（`revision`） | atomic（`SeqCst`）。epoch の照合（`conditions.rs:134-161`） | `reader.rs:89,104,136,173,296` |
| 5 | ★ `voice_activity` | reader | `store`（`recording`／`playing` のとき真） | `AtomicBool` | `reader.rs:196` |
| 6 | ★ 通知の列（`Notifier`） | reader | `order` を取って `emit`（`AppHandle::emit` を含む） | `order` の `Mutex<()>` ・`emitter` の `Mutex`（複製だけ） | `reader.rs:28,297`、`emit.rs:101-123` |
| 7 | ★ 子の stdin（パイプ） | writer スレッド | JSON 1行の書き込みと `flush` | 唯一の持ち主（`BufWriter`）。列の容量1 | `writer.rs:145-158,190-230` |
| 8 | ★ `Conditions`（コマンド層） | `stop_audio`・`toggle_global_mute`・`set_global_mute` のコマンド（ホストのロックの**前**、tokio のワーカー） | `interrupt`・`pending`・`revision` を進める。コマンドの終わりに `Pending::drop` が `revision`・`pending` を戻す | atomic（`SeqCst`） | `commands/audio.rs:509,854,871`、`conditions.rs:72-84` |
| 9 | ★ モード VST のジャーナル | ジャーナルの書き込みごとの使い捨てスレッド（保持者が起こす） | `live-mode-vst-journal.json` の `write_json`。結果は `mpsc` で tick が `try_recv` | ファイル I/O。結果の取り込みだけが保持者 | `mode_vst.rs:727-739,741-783,785-830` |
| 10 | ★ `Admission` | 受付（呼び出しのスレッド。`run_blocking` の中・イベントループ・スケジューラなど） | 採番・件数・ログへの追記（ロックを取る前）。`push_granted` はロックを得た直後 | `next_seq`・`counts` は atomic、`log` は `Mutex`（葉） | `control.rs:97-116,138-145,212-228,248-252` |
| 11 | ★ `Shortcuts` | OS 通知のコールバック（`try_lock`）・`spawn_blocking`・キャプチャのコマンド | `.2` の `fetch_add`（歌・雑談の連番。ホストのロックの**前**）・`CaptureGate` の `begin`/`end`・`shortcut-captured` の `emit` | `.2` は atomic、`CaptureGate` は `Mutex`（OS のコールバックは `try_lock`、動作は `lock`） | `shortcuts.rs:104-110,118-155,384-436` |

- 診断用の静的カウンタ `TRACE_SEQ`（`emit.rs:10,22`）も、reader・保持者の両方から書かれる（通知の内容には関わらない）。上の11には数えない。
- 保持者が子を回収するとき（`retire_child`）、`kill` と終了の確認（最大2秒）はホストのロックを持ったまま行う（`engine_life.rs:243-261`）。これは「ロックありで長く持つ」例で、ロックなしの書き込みではない。
- `AudioHost::drop`（`audio.rs:2951-2973`）は、最後の `Arc` を捨てたスレッドがロックなしで走る（排他なので競合はない）。

---

## 2. 役者×状態の表（材料）

### 2.1 役者

| 記号 | 役者 | スレッド・ロック | 位置 |
|---|---|---|---|
| H | 保持者（同期の呼び出し側） | tokio のブロッキングスレッド・イベントループ（トレイ・`setup`）・warmup の専用スレッド・`spawn_blocking`（ショートカットほか）。ホストのロックを持つ。応答の待ちの間も持つ | 0洗い出し 1.2 のとおり（呼び出し元は未変更） |
| T | モード VST の tick | スケジューラの専用スレッド。ホストのロックを持つ。1 tick に1段。IPC は `try_recv` だけで待たない | `control.rs:231-240`、`mode_vst.rs:519-689` |
| R | reader | 接続ごと。ロックなし | `reader.rs` |
| W | writer | 接続ごと。ロックなし | `writer.rs` |
| P | コマンド層（停止・ミュートの受付） | tokio のワーカー。ロックの前 | `commands/audio.rs:509,854,871` |
| D | `Drop` | 最後の `Arc` を捨てるスレッド。排他 | `audio.rs:2951-2973` |

### 2.2 「接続が切れる・期限が切れる・停止・作り直し」の瞬間に、役者が状態を触る順

#### A. 接続が切れる（子の stdout が閉じた）

| 順 | 役者 | 触る状態 | 位置 |
|---|---|---|---|
| 1 | R | 行の読み取りが終わり、`finish()` へ | `reader.rs:32-62` |
| 2 | R | `LinkState::close(Eof)` を競る。**負け**（host が先に閉じていた）：`ReplySlot::close()` で送り側を取り出して**捨てる**（待ち手は `Disconnected`）。通知なし。終了 | `reader.rs:282-286` |
| 3 | R（勝ち） | `ReplySlot::close()` で送り側を取る（`Closed` にする） | `reader.rs:293`（試験の継ぎ目 `pause` は `reader.rs:289-292`） |
| 4 | R | `Operations::take_exit()`（原因の取り出し） | `reader.rs:294` |
| 5 | R | `Conditions::engine_event(epoch, false)`（epoch 一致のときだけ `running = false`、`pending`・`revision`） | `reader.rs:296`、`conditions.rs:134-150` |
| 6 | R | `Notifier::chain`（`order`）：`audio-conditions-changed` → `audio-engine-exited` → `audio-error`。**EOF の列は接続の確認をしない**（勝った reader が出す） | `reader.rs:297-301` |
| 7 | R | 取り出した送り側へ `ReplyOutcome::Eof` を送る（通知の後） | `reader.rs:303-305` |
| 8 | H（待ち手） | `rx.recv_timeout` が `Eof`（または `Disconnected`）で戻り、`Ok(Response::Error("Engine Crashed/Exited"))` に写す。**`child`・`writer`・`engine_generation`・`conditions.retire_engine` は触らない** | `audio.rs:1145-1147` |
| 8' | T（待ち手） | `Eof`／`Disconnected` → `fail_mode_transaction(ENGINE_EXITED, ambiguous=true)`（`hold_notices` の中で `cancel_mode_vst` と `kill_engine`） | `mode_vst.rs:596-598,831-863` |
| 9 | W | 列にある次の `Job`：`LinkState` が閉じているので書かず `Aborted`。書き込みの最中なら、子が終わってパイプが壊れるまで戻らない（host は5秒で切り離す） | `writer.rs:190-199`、`audio.rs:1103-1117` |
| 10 | H（あとから） | 接続の後始末は、reader が行わないので、次の入口が行う：`ensure_engine_running` が C5（`link.cause() == Eof` で子が生きていれば `drop_connection`）か `try_wait` の `Some`（`close_connection`）、`stop` の `reap_confirmed_stopped_connection`（`connection_lost` かつ子が終了していれば `kill_engine`）、配信ミックスは `settle`→`detach_with`→`release_engine` | `audio.rs:884-908,1734-1746`、`post_mix.rs:458-481` |

#### B. 期限が切れる

B1. 書き込みの5秒（呼び出し側、`cut_off`）

| 順 | 役者 | 触る状態 | 位置 |
|---|---|---|---|
| 1 | H | `WriteDone` を5秒待ち、超える（または送れない・失敗）→ `cut_off(WriteTimeout/WriteFailed)` | `audio.rs:1103-1117` |
| 2 | H | `vst_operations.response(Error)`（**CAS の前**） | `audio.rs:1181-1182` |
| 3 | H | `link.close(cause)`（勝敗を得る） | `audio.rs:1183` |
| 4 | H | `retired.pending` を控える | `audio.rs:1184` |
| 5 | H | `confirming_start` なら `kill_primary_engine`、そうでなければ `kill_engine`（C の「作り直し」と同じ回収。下の `kill_engine` の順を参照） | `audio.rs:1185-1190` |
| 6 | H | 勝ったときだけ `audio-error`（`notice`。回収の後） | `audio.rs:1193-1195` |
| 7 | H | `WriteTimeout` で終了を確かめられなければ `EngineUnconfirmed` | `audio.rs:1196-1200` |

B2. 応答の期限（`reply_timed_out`）

| 順 | 役者 | 触る状態 | 位置 |
|---|---|---|---|
| 1 | H | `flushed_at + limit`（種類ごとの期限。書き込みが `Aborted` のときは `now + limit`）までの `recv_timeout`。期限を過ぎていても受け側を1回 `try_recv`。応答が `received_at <= deadline` なら成功 | `audio.rs:1118-1140` |
| 2 | H | 期限切れ → `link.close(ReplyTimeout)`（勝敗） | `audio.rs:1156` |
| 3 | H | **勝ったときだけ** `vst_operations.timeout()`（`device_open` の記録は残す） | `audio.rs:1157-1159`、`engine_exit.rs:329-342` |
| 4 | H | `retired.pending` を控え、`kill_primary_engine`（`confirming_start`）か `kill_engine` | `audio.rs:1160-1166` |
| 5 | H | 負け：`Ok(Response::Error("Engine Crashed/Exited"))`（通知は reader） | `audio.rs:1167-1169` |
| 6 | H | 勝ち：主で `confirming_start` でなければ `audio-error`。終了未確認なら `EngineUnconfirmed`、そうでなければ `REPLY_TIMED_OUT` | `audio.rs:1170-1176` |
| 並行 | R | 子が生きて stdout が開いている間、reader は次の行を待つ。`link` が閉じた後の次の行で `break` → `finish()`（CAS に負けるので通知なし）。子が `kill` されて EOF が来るまで reader スレッドは残る | `reader.rs:32-35,61,282-286` |

B3. モード VST の期限（tick）

| 順 | 役者 | 触る状態 | 位置 |
|---|---|---|---|
| 1 | T | 取消・世代違い（`tx.generation != engine_generation`）・120秒を先に判定 | `mode_vst.rs:525-536` |
| 2 | T | 書き込みの結果（`Ok`・`Aborted`・`Err`）と `sent.elapsed() < limit` を、応答より先に判定 | `mode_vst.rs:539-568` |
| 3 | T | 応答の `received_at > sent + limit` なら期限切れ、`Disconnected`／`Eof` なら切断 | `mode_vst.rs:569-609` |
| 4 | T | 期限切れ：`link.close(ReplyTimeout)` → `fail_mode_transaction(ambiguous=true)` | `mode_vst.rs:690-695` |
| 5 | T | `hold_notices` の中で `cancel_mode_vst`（`is_global_muted = true`・`global-mute-changed`・`live-modes-invalidated` を保持）→ `kill_engine` → 回収の後に保持した通知を順に出す | `mode_vst.rs:831-863,489-515`、`audio.rs:676-702` |

#### C. 停止（`stop_audio`・緊急のミュート）

| 順 | 役者 | 触る状態 | 位置 |
|---|---|---|---|
| 1 | P | `Conditions::interrupt_restore()`：`interrupt += 1`・`pending += 1`・`revision += 1`。**ホストのロックを待つ前**。`Pending` はコマンドの終わりまで持つ | `commands/audio.rs:509`、`conditions.rs:81-84,162-166` |
| 2 | H | `AudioControl::lock`：受付の記録（`accept`）→ `Mutex` の待ち（**優先はない**。取得順は `Mutex` が決める）→ `push_granted` | `control.rs:212-228,248-252` |
| 3 | H | `stop()`：`stop_primary` の後に `post_mix.stop()` | `audio.rs:1748-1752` |
| 4a | H | `mode_vst.blocked()`：`hold_notices` の中で `cancel_mode_vst("利用者が音声を停止しました")` → `kill_engine`。IPC なし | `audio.rs:1755-1761` |
| 4b | H | それ以外：`frontend_bootstrap.cancel()`・`session_claimed = true` → `reap_confirmed_stopped_connection`（`connection_lost` かつ子が終了なら `kill_engine`）→ R の `Stop`（`dispatch`：`conditions.begin()`・`audio-conditions-changed`・IPC・`Pending` の解放・`audio-conditions-changed`） | `audio.rs:1762-1772,1734-1746`、`conditions.rs:103-122` |
| 4b 並行 | R | 子が `Event::Stopped` → `engine_event(epoch,false)` → `audio-conditions-changed`＋`audio-stopped` の列。続いて `Response::Success` を `deliver_at` | `reader.rs:132-155,45-50` |
| 5 | H | `post_mix.stop()`：子があり開いていれば `exec_child(Stop)`。失敗なら子を `kill_engine`・`restored = false`・`running = false`。閉じていれば `detach_closed_child`（`release_engine`） | `post_mix.rs:813-838` |
| 6 | P | コマンドの終わりに `Pending::drop`：`revision += 1`・`pending -= 1` | `conditions.rs:72-77` |
| 並行 | H（別の入口。配信セットの復元） | ホストのロックの中の確認点で `bundle_interrupt == restore_interrupt()` を見る。変わっていれば「停止・ミュート操作が優先されたため…中断」 | `audio.rs:2318-2331`（呼び出し点は 4 章 C1） |
| 並行 | 緊急のミュート | `set_global_mute(true)` かつ `mode_vst.blocked()`：`is_global_muted = true` → `hold_notices` の中で `cancel_mode_vst`・`kill_engine` → `global-mute-changed`。解除（`false`）は拒否 | `audio.rs:1897-1907` |

#### D. 作り直し（`ensure_engine_running`、`restart_audio_engine`）

`restart_audio_engine` の入口：`preflight_live_changes` → `resolve_input_source` → `preserve_live_changes_for_restart` → `kill_engine` → `start_with_input_source`（`commands/audio.rs:699-724`）。

`kill_engine`（`audio.rs:2789-2794`）の順：`bundle_prepared_voice = false` → `post_mix.kill()`（`discard_child` → 子 `AudioHost` の `kill_engine`、`enabled`・`restored`・`running` を下ろす）→ `mixing.selected = None` → `kill_primary_engine`。

`kill_primary_engine`（`audio.rs:2797-2822`、`hold_notices` の中）の順：

| 順 | 状態 | 位置 |
|---|---|---|
| 1 | `post_attached = false`・`output_gain_initialized = false` | `audio.rs:2799-2800` |
| 2 | `mode_vst.busy()` なら `cancel_mode_vst`（通知は保持） | `audio.rs:2801-2803` |
| 3 | 子があれば `frontend_bootstrap.cancel()`・`session_claimed = true` | `audio.rs:2804-2807` |
| 4 | `invalidate_live_protection()`（通知は保持）・`live_modes.needs_sync = true` | `audio.rs:2808-2809` |
| 5 | `conditions.retire_engine()`（`engine_epoch += 1`・`running = false`）・`notify_conditions_changed`（保持） | `audio.rs:2810-2811` |
| 6 | `engine_generation += 1`・`device_scan = None` | `audio.rs:2812-2813` |
| 7 | `drop_connection(Intentional)`：`link.close`（reader に勝つ。勝敗は読まない）→ `pending_reply_tx.close()`（送り側を取って捨てる）→ `writer = None` → `child.take()` → `retire_child`（`kill`・終了の確認 最大2秒・確認できなければ `Store.push`） | `audio.rs:709-725`、`engine_life.rs:243-261` |
| 8 | `voice_activity.store(false)`・`engine_job = None` | `audio.rs:2819-2820` |
| 9 | 保持した通知を `chain` の中で順に出す（`order` を取る） | `audio.rs:694-700` |

`ensure_engine_running`（`audio.rs:875-1003`）の順：

| 順 | 役者 | 触る状態 | 位置 |
|---|---|---|---|
| 1 | H | `guard_mode_vst`・`maintenance` | `audio.rs:876-879` |
| 2 | H | `child` があれば `try_wait`：`Some`（終了）→ `close_connection`・`child = None`・`engine_job = None`／`None` かつ主で `link.cause()==Eof`（C5）→ `drop_connection`・`engine_job = None`／`Err` → `drop_connection`（終了の証拠ではないので子は記録へ） | `audio.rs:881-909` |
| 3 | H | `retired.ensure_clear(role)`（**ホストのロックと `Store.slots` のロックを持ったまま、最大10秒／記録**）（N3） | `audio.rs:912` |
| 4 | H | `conditions.new_engine()`（`engine_epoch += 1`・`lifecycle(false)`）→ `notify_conditions_changed`（保持なしで直接出す） | `audio.rs:914-915` |
| 5 | H | 子の生成→ `contain_and_resume`（Job）→ `child = Some`・`output_gain_initialized = false`・`engine_generation += 1`・`device_scan = None` | `audio.rs:916-927` |
| 6 | H | `reset_engine_reader`：旧 `link` を `Intentional` で閉じる（旧 reader は CAS に負ける）→ 新しい `ReplySlot`・`LinkState::open()`・`Operations` | `audio.rs:931,1058-1064` |
| 7 | H | `writer = Some(新)`・`voice_activity = 新`・`Reader{… epoch = 4 の値 …}.spawn` | `audio.rs:932-946` |
| 8 | H | 外の停止が重なった子（`externally_suspended`）：起動の確認（`StartIdentityCapability`、`confirming_start = true`）。失敗なら `kill_primary_engine`・`LAUNCH_FAILED`／`EngineUnconfirmed` | `audio.rs:948-977` |
| 9 | H | `peak_intent`・`true_peak_intent` の引き継ぎ（失敗なら `kill_engine`） | `audio.rs:978-1001` |
| 並行 | R（旧 reader） | 旧 `link` が閉じられた後の次の行で `break`→`finish()`（CAS に負ける）。閉じる前に検査を通った1行は処理される：epoch で照合する4種は `engine_event` が旧 epoch を拒否（4 の後）、4 の前は旧 epoch のまま通りうる。`voice_activity.store`（旧 `Arc`）は検査なし | `reader.rs:33,104,136,173,196,282-286` |

#### E. アプリの終了（`Drop`）

`close_connection(Intentional)` → `conditions.retire_engine()` → 配信ミックスの子は `release_engine`、主は `take_engine_for_shutdown`＋`post_mix.take_children_for_shutdown`＋`retired.drain()` → `terminate_all`（全部へ `kill`、共通の2秒）（`audio.rs:2951-2973`、`engine_life.rs:263-278`）。`quit_app` はロックを取らず `note` と `app.exit(0)` だけ（`lib.rs:72-79`）。

### 2.3 役者×状態の表（書く＝W、読む＝r、—＝触らない）

| 状態 | H 保持者 | T tick | R reader | W writer | P コマンド層 | D Drop |
|---|---|---|---|---|---|---|
| `link`（CAS） | W：`audio.rs:710,1156,1183,1062` | W：`mode_vst.rs:693`／r：698 | W：`reader.rs:282`／r：28,33 | r：`writer.rs:191` | — | W（`close_connection`） |
| `ReplySlot` | W：`begin` 1075・`close` 712 | W：`begin` `mode_vst.rs:701`・`cancel` 703,716 | W：`deliver_at` 47・`close` 284,293 | — | — | W（`close`） |
| writer の列 | W：作成 932・`None` 713・`submit` 1086 | W：`submit` `mode_vst.rs:712` | — | r：受信・書込 | — | W（`None`） |
| `child`／`engine_job` | W：`audio.rs:889,900,924,720,2983` | W（`kill_engine` 経由） | — | — | — | W（`take_engine_for_shutdown`） |
| `Operations` | W：`begin` 1076・`response` 1182・`timeout` 1158 | — | W：`response` 46・`take_exit` 294 | — | — | — |
| `Conditions` | W：`new_engine` 914・`retire_engine` 2810・`dispatch` 1051 | W：`begin` `mode_vst.rs:391,441` | W：`engine_event` 104,136,173,296・`engine_changed` 89 | — | W：`interrupt_restore`・`Pending::drop` | W：`retire_engine` 2955 |
| `engine_generation` | W：926・2812 | r：525 | r（複製）：942 | — | — | — |
| 通知の列（`order`） | W：`notice` 672・`dispatch` 1054・保持分 695 | W（`notice` 経由） | W：`chain_if` 28・`chain` 297 | — | — | — |
| `held_notices` | W：`hold_notices` 676-702・`notice` 659-673 | W（`hold_notices` 経由） | — | — | — | — |
| `voice_activity` | W：933,2403,2494,2819 | — | W：196 | — | — | — |
| `mode_vst`（transaction・journal・status） | W：`cancel_mode_vst`・`begin_mode_vst` | W：`poll_mode_vst` | — | — | — | — |
| `post_mix::State`（`child`・`enabled`・`restored`・`running`・`detached`・`disconnected`） | W：`post_mix.rs` | — | — | — | — | W：`take_children_for_shutdown` |
| `Store`（`retired`） | W：`audio.rs:912,2778,647` | — | — | — | — | W：`drain` 2966 |
| `kill_primary_engine` で一括して変える状態（`post_attached`・`output_gain_initialized`・`live_modes.needs_sync`・`device_scan`・`frontend_bootstrap.canceled`／`session_claimed`） | W：`audio.rs:2797-2821` | W（`kill_engine` 経由） | — | — | — | — |

### 2.4 既知の狭い競合3件（`audio-session-f1b0a-design.md` 11章、`audio-session-f1b0a2-design.md` 6章）が表のどこに当たるか

3件の再現の継ぎ目（`Reader::pause`・`after_exec_check`）は存在するが、F1b-0b の試験（仮）として挙がっていた3つの名前（`an_unsent_vst_operation_is_not_named_as_the_exit_cause`・`an_eof_right_after_settle_keeps_enabled`・`a_host_close_before_the_eof_race_still_reports_the_exit_to_the_waiter`）の試験は、まだ存在しない（`git grep` で `bcd2dca2` に該当なし）。

| # | 競合 | 当たる状態と順 | 位置 |
|---|---|---|---|
| 1 | 未送信の VST の操作が終了の原因に載る | 2.2 の A の 2 と 4 の間（reader が CAS に勝ち、`take_exit()` の前）。この間に H が `link.is_open()` を通り（`audio.rs:1068`）、`ReplySlot::begin()`（まだ `Closed` でない。`audio.rs:1075`）、`vst_operations.begin(&cmd)`（`audio.rs:1076`）で `Operations.in_flight` を書き、writer は閉じた接続で `Aborted`（`writer.rs:190-199`）を返して送らない。reader が再開して `take_exit()`（`reader.rs:294`）を呼ぶと、子が受け取っていない操作が原因に載る。**状態＝`Operations.in_flight`（葉の `Mutex`）、役者＝H と R** | `reader.rs:282-294`、`audio.rs:1068-1079`、`engine_exit.rs:53-131,169-195` |
| 2 | `settle()` の直後の EOF で `enabled` が落ちる | 配信ミックスの子の公開の操作の共通のエラー処理：`detached_before` を控え（`post_mix.rs:1011`）、`settle()`（`post_mix.rs:1018,1155`）が開いた接続を読んだ直後に、reader が CAS に勝つ（A の 2）。`detached` は更新されていないので `discard_child()`（`post_mix.rs:1156-1157`、`enabled = false`、`post_mix.rs:797-804`）に進む。**状態＝`post_mix::State.enabled`・`detached`、`LinkState`、役者＝H と R**。継ぎ目＝`after_exec_check`（`post_mix.rs:451-454`） | `post_mix.rs:458-467,1011-1018,1155-1157`、`reader.rs:282` |
| 3 | K13 で通知の前に `Disconnected` | reader が CAS に勝ち（A の 2）、`ReplySlot::close()`（A の 3、`reader.rs:293`）の前に、host の回収が `close_connection` で送り側を取って捨てる（`audio.rs:712`）。通知3件（A の 6）より前に、待ち手の結果が決まる。経路は2つ：(a) **同期の待ち手自身が、期限切れの直前に reader が勝っていたとき**（`reply_timed_out` の負け：`link.close` に失敗→`kill_engine`→`drop_connection`→`ReplySlot::close()`、そして `Ok(Error("Engine Crashed/Exited"))` を返す。`audio.rs:1155-1169`）、(b) **tick が待ち手のとき**に別の入口が `kill_engine`／停止で `drop_connection` し、tick の `try_recv` が `Disconnected` になる（`mode_vst.rs:596`）。どちらも待ち手は `Eof` と同じ `Engine Crashed/Exited` に写すので、利用者に見える結果の違いは通知と結果の順だけ。**状態＝`ReplySlot`（送り側の所有）、役者＝H（または別の H）と R**。継ぎ目＝`Reader::pause`（`reader.rs:289-292`） | `reader.rs:282-305`、`audio.rs:709-725,1145-1146,1155-1169`、`mode_vst.rs:596-598` |

3件とも、窓の両側は「ホストのロックなしで書く reader」（1.7 の 1〜3）と「保持者」の間にある。

---

## 3. 入口を種類でまとめる（95 か所＋`note` 1）

数え方：`Entry::command`／`Entry::bundle`／`Entry::new` の呼び出し箇所を `bcd2dca2` で数え直した。ロックを取る箇所 95、`note` 1（`quit_app`、`lib.rs:76`）で、**0洗い出し 1.1 の 5 と同じ**。内訳：`commands/audio.rs` 59（名前 56）・`commands/bundles.rs` 13（名前 5）・`commands/profiles.rs` 3・`commands/voice_check.rs` 8・`lib.rs` 3（トレイ・`setup`・warmup）・`migration.rs` 1・`obs.rs` 2・`shortcuts.rs` 1・`temporary_session.rs` 2・`updates.rs` 2・スケジューラ（`audio/control.rs:236`）1。

**分け方（排他。優先順は e → d → b → c → a）**：
- (e) IPC を送らず、子も起動しない（ファイル・OS・状態だけ）。
- (d) 読み取りだけ。子にもホストにも状態を変える命令を送らない（IPC は読み取りの命令で、回数は問わない）。要求で変わるものは、**いちばん広い要求**で数える。
- (b) 複数の IPC を続ける（状態を変える IPC を含む、または2回以上）。
- (c) 1回の E で済み（状態を変えうる）、子が居なければ起動しうる。
- (a) 1回の R の IPC で済み（起動しない）、状態を変えうる。
- 「IPC 1回」には、E に付く `sync_live_modes`（最大2）と、子の起動のあとの引き継ぎ IPC（最大2）、`dispatch` の通知を数えない。
- 起動しうるか（L）は、種類をまたぐ別の印として数える。

| 種類 | 数 | 代表の例（呼び出し箇所） |
|---|---|---|
| (a) 1回の IPC（R、起動しない） | 6 | `peak_protection`（`commands/audio.rs:122`）・`broadcast_true_peak`（`:138`）・`remove_plugin`（`:581`）・`noise_measurement`（`:1294`）・OBS の `play`（`obs.rs:51`）・`stop`（`obs.rs:70`） |
| (b) 複数の IPC を続ける | 21 | `start_audio`（`:426`）・`restart_audio_engine`（`:700`）・`stop_audio`（`:513`、Stop が主と配信ミックスの2つ）・`set_output_gain`（`:1036`、E 1＋最大100回の `Status`）・`apply_profile`（`profiles.rs:148`）・`restore_backup_profile`（`:191`）・配信セットの `apply_owned`（`bundles.rs:2723`）・`undo_owned`（`:2876`）・`audio_frontend_bootstrap`・warmup・スケジューラ・ショートカット・更新の `prepare_update`・設定の移行・一時利用の `switch_session` |
| (c) 1回の E（子を起動しうる） | 40 | `load_plugin`（`:565`）・`set_bypass`（`:612`）・`set_mute`（`:628`）・`set_gain`（`:659`）・`set_input_gain`（`:890`）・`set_global_mute`（`:875`）・`toggle_global_mute`（`:858`）・`enumerate_devices_async`（`:194,211,223,235` の4回）・`probe_loopback`（`:1198`）・`auto_gain`（`:1052`）・`start_voice_check`（`voice_check.rs:69`）・トレイの `mute_toggle`（`lib.rs:357`） |
| (d) 読み取りだけ | 12 | `get_engine_runtime_stats`（`:344`）・`get_plugin_state`（`:825`）・`get_output_gain_observation`（`:254`）・`get_round_trip_measurement`（`:1179`。E なので起動しうる）・`save_profile`（`profiles.rs:64`）・`validate_checked`（`bundles.rs:581`）・`capture_async`（`bundles.rs:1988`）・配信セットの `*_snapshot_supported`（`bundles.rs:2090,2111,2363,2386`）・一時利用の `acknowledge_session_review`（`temporary_session.rs:211`） |
| (e) IPC なし | 16 | `get_audio_state`（`:300`）・`get_saved_audio_config`（`:285`）・`get_engine_tuning_config`（`:314`）・`set_engine_tuning_config`（`:329`）・`get_routing_diagnostics`（`:1218`、OS の列挙）・`get_process_input_sources`（`:1398`、OS の列挙）・`preflight_live_changes`（`:1248`）・`begin_live_changes`（`:1263`）・`end_live_changes`（`:1278`）・配信セットの `begin_live_changes`・`end_live_changes` の呼び出し（`bundles.rs:2475,2493,2557,2565`）・`apply_owned` の `conditions().snapshot()`（`bundles.rs:2796`）・`set_event_emitter`（`lib.rs:389`）・更新の `finish_update_attempt`（`updates.rs:177`） |
| 合計 | 95 | 6＋21＋40＋12＋16 |

**起動しうる（L。`ensure_engine_running`・`start` を通りうる）**：57（(c) の 40 全部・(b) の 21 のうち 16・(d) の 1（`get_round_trip_measurement`））。(c) の 40 のうち、`set_noise_control_config`（`:956`）・`set_built_in_effects`（`:982`）は、`require_running` のときは起動しない（`audio/engine_exit.rs:239-261,263-287`）。(b) で起動しないのは5（`stop_audio`・スケジューラ・`prepare_update`・設定の移行・`switch_session`）。

**(b) の 21 の内訳**：`commands/audio.rs` 10（`post_mix`・`live_output`・`mixing`・`audio_frontend_bootstrap`・`start_audio`・`stop_audio`・`session_rack`・`restart_audio_engine`・`set_output_gain`・`live_modes`）・`profiles.rs` 2・`voice_check.rs` 1（`analyze_voice_check`：E 2回、`voice_check.rs:182`）・`bundles.rs` 2・非コマンド 6（warmup `lib.rs:400`・スケジューラ `control.rs:236`・ショートカット `shortcuts.rs:423`・`prepare_update` `updates.rs:166`・`apply_migration` `migration.rs:476`・`switch_session` `temporary_session.rs:286`）。

**(c) の 40 の内訳**：`commands/audio.rs` 32（`enumerate_devices_async` 4・`restore_plugin`・`load_plugin`・`reorder_plugins`・`set_bypass`・`set_mute`・`resume_plugin`・`set_gain`・`open_editor`・`set_plugin_state`・`toggle_global_mute`・`set_global_mute`・`set_input_gain`・`set_noise_reduction`・`start_noise_learning`・`cancel_noise_learning`・`set_noise_control_config`・`set_built_in_effects`・`builtin_effects`・`set_loudness_measurement`・`auto_gain`・`set_global_bypass`・`set_input_channels`・`set_channel_scan`・`play_test_tone`・`stop_test_tone`・`measure_round_trip`・`cancel_round_trip_measurement`・`probe_loopback`）・`voice_check.rs` 7・トレイ 1。

**E・R の呼び出し数（grep の行数。定義を含む）**：E（`execute_command(`・`execute_command_if_running(`）45（`audio.rs` 39・`audio/engine_exit.rs` 4・`frontend_bootstrap.rs` 1・`live_modes.rs` 1）、R（`execute_running_command(`）66（`audio.rs` 35・`post_mix_start.rs` 7・`live_bundle.rs` 4・`session_rack.rs` 4・`mixing.rs` 3・`post_mix.rs` 3・`live_modes.rs` 2・`mixing_bundle.rs` 2・`mode_vst.rs` 2・`output_bundle.rs` 2・`engine_exit.rs` 1・`frontend_bootstrap.rs` 1）。`AudioHost` の公開メソッド（`pub fn`・`pub(crate) fn`）は `audio.rs` の `impl AudioHost` に 81、ほかに `frontend_bootstrap.rs` 3・`live_modes.rs` 5・`mixing.rs` 1・`process_inputs.rs` 3・`session_rack.rs` 1・`mode_vst.rs` 1・`post_mix.rs` 1・`engine_exit.rs` 3・`output_bundle.rs` 2・`live_bundle.rs` 2・`mixing_bundle.rs` 3・`process_bundle.rs` 4（`pub fn`／`pub(crate) fn` の行を数えた。呼び出し側が使う数との一致は確かめていない）。

**種類ごとの、F1b-0a-2 の後の変わった点**：E・R の応答の期限は命令の種類で決まる（`deadline.rs:24-`）。(a)(d) で閉じた接続に当たると `replies::CLOSED`（`audio.rs:1068`）で失敗する（起動しないため）。(b) の途中で接続が切れた場合の扱いは、0洗い出し 1.6 のとおり入口ごとに分散した確認（`validate_bundle_connection`、`audio.rs:2318-2331`）で、F1b-0a の範囲では変わっていない。

全部の一覧（各入口の保持の間の IPC・emit・エラーの文言）は、0洗い出し 1.4〜1.7 を参照（入口の側のファイルは未変更。`audio.rs` の行だけ動いた）。

---

## 4. C1・C4・N1・N2・N3 の今の実装の位置

### C1：停止の受付（`interrupt_restore`・`Pending`）

- **`Conditions`**：`interrupt: AtomicU64`（`conditions.rs:36`）。`interrupt_restore()`（`conditions.rs:81-84`）は `interrupt += 1` と `begin()`（`pending += 1`・`revision += 1`、`conditions.rs:162-166`）。返す `Pending` は `Drop` で `revision += 1`・`pending -= 1`（`conditions.rs:71-77`）。
- **取る入口**：`stop_audio`（`commands/audio.rs:509`）・`toggle_global_mute`（`commands/audio.rs:854`）・`set_global_mute`（`commands/audio.rs:871`）の3コマンドだけ。`run_blocking` に入る前（ホストのロックを待つ前）に取り、コマンドの終わりまで持つ（`_interrupt`）。トレイ（`lib.rs:353-361`）・ショートカット（`shortcuts.rs:456-458`）のミュートは取らない。
- **読む側（`restore_interrupt()`、`conditions.rs:91-93`）**：配信セットの復帰の確認 `validate_bundle_connection`（`audio.rs:2318-2331`）。`bundle_change_scope`（`audio.rs:2333-2352`）が `bundle_interrupt` に登録し、`operation` の前後でも確認する（`audio.rs:2343,2346`）。確認点：`execute_command`（`audio.rs:1023-1024`）・`start_internal_with_source`（`audio.rs:1584-1585`）・`restore_plugin`（`audio.rs:1808-1809`）・`start_bundle_with_device_ids`（`audio.rs:2286`）・`get_engine_runtime_stats`（`audio.rs:2636-2637,2651`）・`execute_command_if_running`（`audio/engine_exit.rs:219-220`）・`with_bundle_live`（`audio/live_bundle.rs:131,155`）・`process_bundle_scope`（`audio/process_bundle.rs:77,107`）。**`execute_running_command` の中・`remove_plugin`・`set_output_gain` の確認ループ・`post_mix` の子への命令・`apply_profile` には確認がない**（0洗い出し 1.6 のとおり。この点に F1b-0a の変更はない）。
- **`Witness`・`ControlWitness` との関係**：`pending != 0` の間は新しい `Witness` を作れず（`conditions.rs:176-192`）、`validate()` も失敗する（`conditions.rs:60-68,204-210`）。停止の `Pending` が、並んでいる間の `Witness` を失効させる（試験 `conditions.rs:282`）。
- **ロックの待ちへの優先はない**：`Ticket::lock` は `host.lock()` を呼ぶだけ（`control.rs:248-252`）。停止が先に実行されるかは `Mutex` が決める（K11、`audio/tests/control_tests.rs:43`）。K12（`commands/audio/compat_tests.rs:258`）が「停止の `Pending` はロックを待つ前に登録される」ことを固定している。
- **ほかの `Pending` の作り手**：`dispatch`（`command_changes` が真の命令の前後、`conditions.rs:103-122`）・モード VST の遷移（`condition_pending`、`mode_vst.rs:219,391,441`。完了・取消で `drop`、`mode_vst.rs:905`）。

### C4：受付の記録（`Admission`）

- `accept`（`control.rs:97-116`）：種別ごとの件数（`counts[kind]`、`Relaxed`）→（`Scheduler` は `next_seq` だけ進めて戻る）→ `log` の `lock` → 採番（`next_seq`、`SeqCst`）→ 追記（最大256件、`control.rs:62,131-136`）。ログの `Mutex` が poison されていれば採番だけ。
- 段階は `Accepted`・`LockGranted` の2つだけ（`control.rs:49-53`）。**完了の段階（`Completed`）も、未完了の件数も持たない**。`accepted()` は受付の累計（`control.rs:148-150`）。
- **上限・拒否・期限はない**：`accept` は常に番号を返し、`Ticket::lock` はホストのロックを無期限に待つ（`control.rs:248-252`）。`run_blocking` は `tauri::async_runtime::spawn_blocking`（`commands/mod.rs:7-13`）で、待つスレッドの数を数える仕組みはこの層にない。
- **製品のコードに読み手がない**：`accepted`・`accepted_of`・`records` を呼ぶのは試験だけ（`audio/tests/control_tests.rs`、`commands/audio/compat_tests.rs:127`）。`AudioControl::admission()`（`control.rs:200-202`）の製品側の呼び出しもない。
- 記録を取る入口の範囲：95 のロックと `note` 1（3 章）。`Scheduler` はログに残さない（`control.rs:102-104,139-141`）。

### N1：トレイ・ショートカットの呼び出しのスレッド

`lib.rs` と `shortcuts.rs` は `292dfdb2` から変わっていない。スレッドの根拠（Tauri・Wry の依存のソースの確認）は 0洗い出し 1.2 のとおりで、今回は依存のソースを開き直していない。

- **トレイの「ミュート切替」**：`TrayIconBuilder::on_menu_event` のクロージャ（`lib.rs:344-365`）の `mute_toggle` の分岐（`lib.rs:353-362`）が、そのスレッドで `lock(Entry::new(Tray, "mute_toggle"))`（`lib.rs:355-357`）→ `host.toggle_global_mute()`（`lib.rs:359`）。結果は捨てる（`let _ =`）。0洗い出しのとおり、そのスレッドはイベントループ（確定。0洗い出し 1.2）。`interrupt_restore` は取らない。
- **`setup` の `set_event_emitter`**：`lib.rs:389-394`。同じくイベントループのスレッドでロックを待つ（0洗い出し 1.2）。
- **warmup**：`std::thread::spawn` の専用スレッド（`lib.rs:397-407`）。
- **グローバルショートカット**：`lib.rs:257-259` の `with_handler` が `shortcuts::dispatch`（`shortcuts.rs:384`）を呼ぶ。`dispatch` は OS 通知のコールバック上で、`CaptureGate` を `try_lock`（待たない。`shortcuts.rs:103-110`）して意図の連番を進め（`shortcuts.rs:414`）、`spawn_blocking` に渡す（`shortcuts.rs:418`）。ホストのロックを待つのはそのブロッキングスレッド（`shortcuts.rs:421-427`）で、`gate` の `Mutex` をホストのロックの後に取り、動作の終わりまで持つ（`shortcuts.rs:430-436`）。`shortcut-noise-toggled` ほかの `app.emit` もこの間に出す（`shortcuts.rs:502,518,521`）。
- **`quit_app`**：同期コマンド。`note` と `app.exit(0)`（`lib.rs:72-79`）。トレイの「終了」も `quit_app` を呼ぶ（`lib.rs:363`）。
- 更新（`updates.rs:162-186`）・移行（`migration.rs:473-503`）・一時利用（`temporary_session.rs:209-222,284-347`）・OBS（`obs.rs:49-82`）は `spawn_blocking`／`run_blocking`（0洗い出し 1.2 のとおり）。

### N2：reader の通知の直前の確認

- **各行の先頭**：`if !self.link.is_open() { break }`（`reader.rs:33`）。
- **通知の列の直前**：`emit_chain`（`reader.rs:27-29`）→ `Notifier::chain_if(|| link.is_open(), 列)`（`emit.rs:110-123`）。`order` を取った後に `open()` を確認し、閉じていれば列の全体を出さない。列の途中では確かめ直さない。対象は reader の通知の全部（`audio-control-stall`・`mixing-*`・`audio-stream-error`・`audio-level`・`audio-stopped`・`audio-loudness`・`audio-channel-scan`・`audio-started`・`voice-check-*`・`plugin-editor-*`・`audio-processing-health`。`reader.rs:64-276`）。
- **確認しない列**：EOF の通知の列（`audio-conditions-changed`→`audio-engine-exited`→`audio-error`）は `Notifier::chain`（確認なし）。CAS に勝った reader が出す（`reader.rs:297-301`）。
- **確認の前に状態を変えるもの**：`conditions.engine_event`・`engine_changed`（epoch の照合のみ、`reader.rs:89,104,136,173`）・`voice_activity.store`（`reader.rs:196`）・`operations.response`・`replies.deliver_at`（`reader.rs:46-47`）。
- **確認の直後に閉じた場合**：1つの列が出うる（F1b-0a-1 設計 3.4 の既知の範囲）。
- **epoch の照合**：`Started`・`Stopped`・`Error`・`Mixing*` の4種は `engine_epoch` で照合（0洗い出し 3.1 のとおり）。`engine_epoch` が進むのは `new_engine`（`audio.rs:914`）と `retire_engine`（`audio.rs:2810,2955`）だけ。`close_connection`・`drop_connection`（`audio.rs:709-725`）は `retire_engine` を呼ばない（`kill_primary_engine` が先に呼ぶ）。
- 試験：`audio/tests/link_tests.rs` の `t9_a_closed_connection_emits_no_notice_chain`（493）・`t9_a_chain_that_waited_for_the_order_lock_is_dropped_when_the_connection_closed_meanwhile`（518）・`t9_k13_a_chain_is_never_interleaved_with_notices_from_other_threads`（546）。

### N3：終了の確認の待ち（`retired.ensure_clear`）

- **呼び出し元は1つだけ**：`ensure_engine_running`（`audio.rs:912`）。`child` の `try_wait` の分岐（`audio.rs:881-909`）の後、`conditions.new_engine()`（`audio.rs:914`）の前。保持者のスレッドで、ホストのロックを持ったまま。
- **中身**：`Store::ensure_clear(role)`（`engine_life.rs:172-189`）が `Store.slots` の `Mutex` を持ったまま、対象の役割の記録ごとに `Retired::settle`（`engine_life.rs:128-144`）を呼ぶ。`settle` は終了を確かめ、期限（最初の `kill` から10秒、`DEADLINE`、`engine_life.rs:34`）まで、`RETRY_KILL`（2秒）ごとに `kill` をやり直し、`POLL`（50ms）ごとに `sleep` する。確かめられなければ `unconfirmed += 1`（`REPEAT_AT = 3`、`engine_life.rs:36`）で `EngineUnconfirmed`。
- **ほかの待ち**：`retire_child`（`kill`＋最大2秒、`CONFIRM`。`engine_life.rs:243-261`。ホストのロックを持つ。`Store` のロックは確認の後の `push` だけ）・`recheck`（待たない。`audio.rs:2778`）・`terminate_all`（アプリの終了の共通2秒、`SHUTDOWN`。`engine_life.rs:263-278`）。
- **専用の見張り役（reaper）のスレッドはない**：記録の確認は、呼び出したスレッドがロックを持ったまま行う。
- 試験：`audio/tests/engine_life_tests.rs`（`b17_d7…` 262・`b18…` 288・`b17b…` 302・`w2_…` 320・`j13_…` 341・`drop_waits_at_most_the_shared_two_seconds…` 388）。仮想時計の継ぎ目で `sleep` を進める（`engine_life.rs:72-86`）。

---

## 5. 既存の試験のうち、F1b-0b の「互換の安全網」になるもの

数え方：行頭の `#[test]`／`#[tokio::test]` を数えた（`#[cfg(test)]` のヘルパーは数えない）。「内部参照」は、試験の中の `.link`・`.pending_reply_tx`・`.vst_operations`・`.writer`・`.child`・`.engine_generation`・`.conditions`・`.mode_vst.`・`.post_mix.`・`.retired`・`.emitter`・`set_link_for_test` ほかの出現の行数（`AudioHost` の非公開の項目に直接触る度合いの目安）。

### 5.1 モジュールごとの数

| モジュール | 数 | 内部参照 | 性格 |
|---|---|---|---|
| `audio/tests/compat_tests.rs` | 24 | 8 | K 群（reader・通知・`prepare_update`）。台本つきの実プロセスと実 reader |
| `commands/audio/compat_tests.rs` | 17 | 2 | K 群（コマンドの関数の応答・エラー・warmup・タイムアウト） |
| `audio/tests/control_tests.rs` | 7 | 0 | K11・受付の記録・スケジューラ |
| `audio/tests/link_tests.rs` | 20 | 61 | F1b-0a-1（C2・EOF・通知の列・C5） |
| `audio/tests/reply_deadline_tests.rs` | 6 | 29 | F1b-0a-2（C3・期限） |
| `audio/tests/engine_life_tests.rs` | 24 | 44 | F1a-1（W 群・B17・J-13・Drop） |
| `audio/tests/post_mix_life_tests.rs` | 31 | 153 | 配信ミックスの子（W2・T10・P1〜P3・T2・T8） |
| `audio/tests/config_storage_tests.rs` | 36 | 128 | 保存ファイル・設定 |
| `audio/tests/device_scan_tests.rs` | 7 | 20 | 機器のスキャン |
| `audio/tests/permission_error_tests.rs` | 2 | 0 | マイク許可の写し |
| `audio/tests/compat_support.rs` | 6（195・221 は台本つきの子・孫のプロセスの入口で、`#[test]` として起動される。585・590・602・619 は終了の確認の補助の試験） | 2 | 台本つきの子（`Step::StallStdin`・`CloseStdout` など。`compat_support.rs:12-28`） |
| `audio.rs`（内側） | 2 | — | `checked_snapshot_scope_tests`（`audio.rs:344-`） |
| `audio/mode_vst.rs`（内側） | 33 | `mode_vst.rs:1360-` に集中 | モード VST の状態機械・writer・期限 |
| `audio/engine_exit.rs`（内側） | 18 | — | 原因の分類・旧 reader の無効化 |
| `audio/conditions.rs`（内側） | 11 | — | `Witness`・`dispatch`・停止の `Pending` |
| `audio/frontend_bootstrap.rs`（内側） | 14 | — | warmup と最初の画面 |
| `audio/writer.rs`（内側） | 7 | — | writer 単体（列・`flushed_at`・`Aborted`） |
| `audio/replies.rs`（内側） | 6 | — | `ReplySlot` 単体 |
| `audio/emit.rs`（内側）・`link.rs`・`deadline.rs` | 2・3・3 | — | 通知の列・`LinkState` の競り・期限の分類 |
| `audio/live_modes.rs`・`session_rack.rs`・`mixing.rs`・`post_mix.rs`・`process_inputs.rs`・`process_bundle.rs`・`live_bundle.rs`・`output_bundle.rs`・`mixing_bundle_tests.rs` | 7・6・4・3・2・1・1・3・5 | — | 各機能の内側 |
| `commands/bundles/tests.rs` | 27 | 4 | 配信セットの割り込み・再照合 |
| `shortcuts.rs`・`obs.rs`・`updates.rs`・`migration.rs`・`temporary_session.rs`・`bundle.rs` | 9・19・2・9・6・18 | — | 入口の周辺 |

`audio` の下（`audio.rs`・`audio/`）の合計は 294。このうち `audio/tests/` が 163、`audio/` 直下の内側の試験が 129、`audio.rs` が 2。

### 5.2 とくに重要な試験（ファイル：行は `fn` の行）

- **K 群（互換の契約）**
  - `audio/tests/compat_tests.rs`：K1・K13（`k1_k13_start_success_emits_conditions_then_started_before_the_result_returns` 58）・K13 失敗（82）・K13 停止（98）・D2・D9・K13 の EOF（`d2_d9_k13_eof_emits_exit_notifications_before_releasing_the_waiting_call` 109）・A13（135）・K6（163）・K7（193）・K9a〜e（235・252・274・292・322）・K15・F12（342）・K16（375）・B15（391）・B12（401）・C4（441）・D3（453）・A9b（473）・混合の失敗（494）・残りの通知（535）・ペイロード（617）・開始中の終了（657）・VST の操作中の終了（678）。
  - `commands/audio/compat_tests.rs`：K2・K10（138）・K10（186）・B14（215）・**K12（258）**・K4・K14（320）・K5（385）・K14（404）・ロックの失敗の文言（446）・D3（471）・K8a〜d（494・537・560・577・620）・タイムアウト（`timeout_waits_ten_seconds_retires_the_child_sends_no_stop_and_does_not_block_the_next_request` 645）。
  - `audio/tests/control_tests.rs`：**K11**（43）・受付の順（76）・`note`（140）・記録の上限（150）・スケジューラの終了（160）・配信ミックスの子の作成が `control.rs` だけを通ること（189）。
  - 実プロセスの台本の足場は `compat_support.rs`（`Script`・`Step`、`compat_support.rs:12-35`）。K 群は `AudioControl`／`AudioHost` の公開の入口から呼ぶ形で、内部参照は 10 行にとどまる。
- **W5（旧の通知とコマンドの応答の到着順）**：自動の試験ではなく**手動の測定の手順**（`docs/TESTING.md:42-110`）。Rust 側は `AURALYN_EMIT_TRACE=1` のときの `trace_mark`（`audio/emit.rs:12-31`、`commands/audio.rs:449,518,727`）、WebView 側は開発ビルドだけの `src/lib/w5Probe.ts` と、その試験 `src/lib/__tests__/w5Probe.test.ts`。**CI で回らない**。`docs/TESTING.md:99` には、今の debug の子が実機の `Start` で落ちる（#829）ため W5 を測れないとの注記がある。Rust の `emit` の呼び出し順は `Recorder` の試験（K13）が固定し、WebView への到着順は W5 が別に測る。
- **`engine_life_tests.rs`（24）**：W1a（52）・W1b（72・93）・W1c（114・146・169・656・671・691）・`the_product_spawn_creates_the_child_suspended…`（201）・B17・D7（262）・B18（288）・B17b（302）・W2（320）・J-13（341）・B40a（`engine_generation` の更新点、366）・Drop の2秒（388）・W4a・W4b（601・620・632・644）。
- **`link_tests.rs`（20）**：T1（C2、93）・T2（157・171・185・198）・T3（228）・T4（270・702）・T5（310・347）・T6（375）・T7（426）・T8（C5、443・480）・T9（493・518・546）・T13（578）・書き込みの共有（627）・P2（646）。
- **`reply_deadline_tests.rs`（6）**：T1（C3、75）・T9（119）・T3（155）・T13（189）・T4（227）・T12（266）。
- **`post_mix_life_tests.rs`（31）**：W2（66・79・91・106・121・142・223）・J-13（167）・B40a（194）・T10（415・460・477・531）・P1（605・627・886・991・1031・1209）・P2（659・832・845・939・1064・1091・1114・1156・1233）・P3（1272）・T2（C3、717）・T8（766）。
- **`post_mix_life_tests.rs`／`link_tests.rs` の継ぎ目**：`Reader::pause`（`reader.rs:309-331`）・`after_exec_check`（`post_mix.rs:312,451-454`）・`SinkOverride`（`writer.rs:98-143`）・`before_begin_hook`（`audio.rs:255-271`）・`set_limits_for_test`（`writer.rs:38-45`）・`set_link_for_test`・`replace_writer_for_test`・`fail_writes_for_test`・`attach_stdin_for_test`（`audio.rs:608-635`）。F1b-0b で書き換わる可能性が高いのは、これらの継ぎ目に触る試験（内部参照の列で大きいもの：`post_mix_life_tests` 153・`config_storage_tests` 128・`link_tests` 61・`engine_life_tests` 44・`reply_deadline_tests` 29）。公開の入口だけで書かれたものは K 群と `control_tests.rs`。

### 5.3 固定していない性質（今回の読み取りで見つけたもの）

0洗い出し 7.2 の20項目のうち、F1b-0a-1・F1b-0a-2 で固定が増えたもの：書き込みの上限（C2、`link_tests` T1）・書き込みの失敗の通知（T2）・`audio-error` の順（T6）・reader の通知の接続確認（T9）・`emitter` の poison（`emit.rs` の試験）・応答の期限（`reply_deadline_tests`）。F1b-0b の設計の入力として、**今も固定していない**もの：
1. 2.4 の3件の競合を実際に再現する試験（継ぎ目はあるが試験がない）。
2. `cut_off`（`audio.rs:1180-1201`）で `vst_operations.response` が CAS の前に呼ばれること（6 章 1）。
3. `voice_activity` の更新が接続の確認の前にあること（6 章 2）。
4. `Admission` を製品のコードが読まないこと、完了・未完了の件数がないこと（4 章 C4）。
5. トレイ・ショートカットのミュートが `interrupt_restore` を取らないこと（`shortcuts.rs:456-458`、`lib.rs:353-361`）。
6. トレイのコールバックがイベントループのスレッドでロックを待つこと（スレッドの種類の確認は依存のソースの読み取りで、試験ではない）。

---

## 6. 気づいたこと（設計案ではなく、事実として不安な点）

1. **`cut_off` と `reply_timed_out` で、`vst_operations` の書き換えと `LinkState` の競りの順が違う。** `reply_timed_out` は競りに勝った後にだけ `vst_operations.timeout()` を呼ぶ（`audio.rs:1156-1159`）。`cut_off` は、競りの前に `vst_operations.response(Error)` を呼ぶ（`audio.rs:1181-1183`）。書き込みの失敗・期限切れの前に reader が EOF の CAS に勝っていても、`cut_off` は `in_flight` を先に消す（`engine_exit.rs:132-168`）ので、reader の `take_exit()` が採る原因が変わりうる。2.4 の競合1と同じ状態（`Operations.in_flight`）を、別の経路が先に書く形。
2. **古い reader の `voice_activity.store` は接続の確認の前にあり、`kill_primary_engine` の `store(false)` の後にも走りうる。** `reader.rs:196` は `is_open` の検査（`reader.rs:33`）を通過した1行の中で、`emit_chain`（`reader.rs:206`）より前に `store` する。`kill_primary_engine` は `drop_connection` の後に `voice_activity.store(false)`（`audio.rs:2819`）。この順の間に、検査を通過していた `VoiceCheckState` が `store(true)` すると、新しい接続を作る（`audio.rs:933` が `Arc` を差し替える）まで `voice_activity` が真のまま残り、`check_can_interrupt`（`audio.rs:2754-2758`）が「ボイスチェックの録音・試聴を終了してから更新してください」で拒否しうる。窓は1行ぶん（推測：実際に起きる頻度は測っていない）。
3. **epoch を進めずに接続を閉じる経路がある。** `ensure_engine_running` の 888（`try_wait` が `Some`）・900（C5）・906（`try_wait` が `Err`）と `reset_engine_reader`（`audio.rs:1060`）は `link` を閉じるが `conditions.retire_engine()` は呼ばない。`engine_epoch` が進むのは `new_engine`（`audio.rs:914`）で、その前に `retired.ensure_clear`（`audio.rs:912`、最大10秒／記録）がある。この間、旧 reader が検査を通過した1行の `Started`・`Stopped`・`Error` は旧 epoch のまま `engine_event` を通りうる（`reader.rs:104,136,173`、`conditions.rs:134-150`）。窓は1行ぶん（推測）。
4. **通知の `order` は、reader と保持者（ホストのロックを持つ）の両方が取る。** 保持者は `notice`（`audio.rs:672`）・`dispatch` の通知（`audio.rs:1054`）・保持した通知の `chain`（`audio.rs:695`）でホストのロックを持ったまま `order` を待つ（`emit.rs:101-107`）。reader が `AppHandle::emit` の最中に止まると、`order` を待つ保持者が止まる。子の回収は通知より前に行う（`hold_notices`、`audio.rs:2797-2822`）ので回収は止まらないが、回収の後の通知で止まりうる（F1b-0a-1 設計 3.3 の既知の範囲）。`Conditions::dispatch` の IPC の前の通知（`audio.rs:1054`、`conditions.rs:110-112`）は、切り離しの経路ではないので変えていない。
5. **`Admission` の記録・件数は製品のコードから読まれない。** 受付の累計・種別の件数・256件のログは、試験だけが読む（4 章 C4）。`Phase` は `Accepted`・`LockGranted` の2つだけで、完了の記録も未完了の件数もない。
6. **`ensure_clear` は、ホストのロックと `Store.slots` のロックの両方を持って最大10秒待つ。** 呼び出し元は `ensure_engine_running` だけ（`audio.rs:912`）。`Store` のロックは配信ミックスの子とも共有するが、触るのは保持者だけなので `Store` のロックの競合はない（ホストのロックの待ちが実際の待ち）。専用の見張り役はない。
7. **配信ミックスの子の `AudioHost` は、作成のたびに保存ファイル・ジャーナルを読み直す。** `post_mix_child_host`（`control.rs:256-260`）→ `AudioHost::with_retired`（`audio.rs:557-606`）が `mode_vst::State::new`・`HostModes::new`・`mixing::State::new`・`post_mix::State::new` を呼ぶ。子の `root` は `post-mix-runtime`（`post_mix.rs:522-526`）。子が使わない状態（モード VST・本番モードなど）を持つ。子の tick・スケジューラはない（`control.rs:231-240` は主だけ）。
8. **`ConditionState` はホストのロックなしで読まれる。** OBS の `obs_timing_targets`（`lib.rs:137-143`）は `conditions.snapshot()` を直接呼び（`obs_setup.rs` の `timing_targets`）、取った `Witness` は後でホストのロックの外・内で `validate` される（`obs.rs:35-38`、`bundles.rs:1227,1310,2729` はホストのロックの内側）。
9. **トレイ・ショートカットのミュートは `interrupt_restore` を取らない**（`lib.rs:353-361`、`shortcuts.rs:456-458`）。配信セットの復元は、これらのミュートで中断されない（0洗い出し 8 章 7 のとおり。F1b-0a で変わっていない）。
10. **`apply_profile`・`restore_backup_profile` の経路には、途中の接続・停止意図の確認がない**（`commands/profiles.rs:148,191`、`profile.rs:225-499`。0洗い出し 1.5 D のとおり）。この経路は IPC の回数の上限が決まらない（0洗い出し 6.3）。F1b-0a-2 で B の応答の期限は30秒になったが、ロックを持つ時間の上限は変わっていない。
11. **B の命令の応答の期限は30秒、書き込みは5秒、終了の確認は最大2秒（回収）＋最大10秒（作り直し）**（`deadline.rs:14`、`writer.rs:13`、`engine_life.rs:30,34`）。ホストのロックを持つ時間は、この組み合わせでさらに延びる（0洗い出し 6.3 の例の秒数は上限ではない。今回も測っていない）。
12. **`execute_command` の `GetFrameTimingTrace` の直行（`audio.rs:1020-1022`）に、製品の呼び出し元がない**（`git grep` で `audio.rs:1020`・`ipc.rs:648`・`conditions.rs:234`・`deadline.rs:38` と試験だけ）。
13. **`kill_primary_engine`・`stop_primary`・`set_global_mute`・`fail_mode_transaction` の `hold_notices` の中の通知の順は、各経路で固定している**（`audio.rs:1756-1759,1901-1905,2798-2821`、`mode_vst.rs:853-862`）。保持した通知を出す `chain`（`audio.rs:694-700`）は、深さが0に戻った最外の `hold_notices` だけが出す（`audio.rs:687-693`）。入れ子（`stop_primary`→`kill_engine`→`kill_primary_engine`）では最外が出す。この仕組みが `Mutex<HeldNotices>`（ホストのロックの内側の `Mutex`）に依存している。
14. **ロックを持たない書き手の11か所（1.7）のうち、reader の6か所はすべて「接続の確認の前」にある**（`reader.rs:33` の検査は行の先頭の1回で、行の処理の途中の `conditions`・`voice_activity`・`operations`・`replies` の書き込みは検査の後）。通知（6番）だけが列の直前に再確認する（`emit.rs:110-123`）。

---

## 7. 調べきれなかったこと

- 実行はしていない（コードの読み取りだけ）。時間・競合・実機の挙動は確かめていない。
- Tauri・Wry の依存のソース（イベントループのスレッド）は開き直していない（0洗い出し 1.2 の確認を、`lib.rs` が未変更であることを根拠に引き継いだ）。
- 通知（`emit`）の全箇所の数え直し（0洗い出し 4 章の 32 箇所・23 種のうち、reader 以外の位置）。
- 全95入口の保持の間の IPC の回数は、今回は数え直していない（入口の側のファイルが未変更のため、0洗い出し 1.4〜1.7 を使う）。`audio.rs` の関数の行は動いたので、そこへの参照は上の表で更新した。
- `profile.rs` の `apply_profile`・`capture_profile_parts` の IPC の回数、`bundle.rs`・`obs_setup` がホストを間接的に触るか（0洗い出し 10 章のとおり）。
- フロントエンドの呼び出しの順序・再試行（`src/`）。
- 子（`audio_engine`）側の命令ごとの最大の処理時間（0a2洗い出し 1 章・7 章のとおり）。
- 試験の数は行頭のアトリビュートの grep による（`#[test]` を属性の途中に書く形・マクロで生成する試験は数えていない可能性がある）。「内部参照」の列は行数の目安で、試験ごとの結合の強さの判定ではない。
- 1.2 の「読む者」の列の `audio.rs` の件数（`child` の約20 など）は grep の件数で、読み取りと書き込みを区別していない箇所がある（書き込みの行は別に挙げた）。

# 旧 API の互換の契約（`9567061a` の実際の振る舞い）

状態：F0 の成果物（第3回のレビューを反映した改訂版）。コードを読んで確かめた事実を表にした。通知の順序と応答の到着順だけは、開発ビルドの実際の WebView と実機の WASAPI で実測した（9章。release の子。debug の子、聴感、複数ウィンドウ、本番ビルドは確かめていない）。
設計は [audio-session-controller.md](audio-session-controller.md)。試験の行は [audio-session-acceptance.md](audio-session-acceptance.md)。

読み方：

- 「事実」の列は、`9567061a` のコードで確かめたこと。根拠を `ファイル:行` で示す（行は `9567061a` の値）。
- 「F1a」の列：**変えない**（互換の試験で固定する）。F1a は、F1a-0（互換の試験・入口の一本化・受付順の記録）と、F1a-1（プロセスの寿命。今の `Mutex` と実行の経路を保つ）の全体を指す。actor・受信箱・writer・reaper・入口の持ち主の移行（旧 F1a-2）は、受付と実行の順を変えるので **F1b-0** で、D-9・D-10 の承認とともに入れる（J-14）。受付順を記録することは、勝ち負けを変えることとは別の差分で、F1a-0 は勝敗を変えない。
- 「F1b」の列：安全のために変える候補。個別の承認が要る差分（8.2 の表）。
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
| 子を起動するか・ロック | **起動しない**。読み取りだけ。ただし `state.lock()` を取ってから読む（`Start` がロックを持っていれば、その完了後の値を返す） | `commands/audio.rs:285-295` | **変えない。** F1a-0・F1a-1 は同じ `Mutex` の経路を使う。F1b-0 で actor に移した後も、同じ待ちの境界（先行する命令が保存と状態の更新を終えた後に読む）を保つ | 待たない読み取り（`SnapshotCell`）は D-8（承認）。既存の `get_audio_state` の待ちを外す変更と、新しい `get_audio_session` の追加は別の差分 |
| ロック待ち | `Mutex` を待つ。10秒の IPC 待ちの間は、応答が遅れる。基準の順序：`Start` がロックを持つ → `get_audio_state` が呼ばれる → 開始が保存と `active_config` の更新を終える → 読む | `audio.rs:3041`、`commands/audio.rs:290-293` | **変えない**（F1a-0・F1a-1 は同じ `Mutex` の経路。F1b-0 で actor に移した後も、待ちの境界は同じ。`SnapshotCell` にしない） | D-8 |

## 2. `expectedState`（`start_audio` の任意の引数）の完全一致

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 適用先 | `start_audio` だけ。`restart_audio_engine` は `expected_state` を受け取らない（フロントは付けるが、Tauri が無視する） | `commands/audio.rs:383-388`、`:624-628`、`api/audio.ts:206-219` | 変えない | 変えない |
| 照合の規則 | 次のいずれかなら失敗：`current.is_running == false`、`current.condition_witness == None`、`expected` に `condition_witness` キーがない、`serde_json::to_value(current) != expected`（**JSON の完全一致**） | `commands/audio.rs:433-447` | 変えない | 変えない |
| 完全一致の意味 | `config` を含む全体を比べる。項目の欠落・余分な項目は不一致。`revision`・`epoch` の文字列の差も不一致 | 同上 | **F1a-0 は、既存の完全一致のまま**（旧の形に写す処理は入れない） | F1b で `get_audio_state` に拡張のキーを実際に足すときに、旧の形に写して比べる処理を入れる（試験は F1b の K3） |
| 同じ設定でも拒む場合 | 停止・再開（`lifecycle`）は **`revision` だけ**を進める（`pending` を挟んで +2）。`engine_epoch` は、子の生成（`new_engine`）と退役（`retire_engine`）でだけ進む。したがって、同じ子で Stop → Start すると、旧の witness は `revision` の不一致で拒まれる（`epoch` の更新によるものではない）。接続が変わると、両方が変わる | `commands/audio.rs:455-481`（試験）、`audio/conditions.rs:95-104`、`:138-146` | 変えない | 変えない |
| 古い reader による `running` の書き込み | `engine_event` は、最初の epoch の照合に通った後、`running` を書き、再照合で接続が変わっていたら `running = false` を書く。**照合の後に接続が変わると、新しい接続の `running` を落とせる**（旧 reader が最初の照合を通った場合）。「古い接続の通知は `Conditions` に作用しない」のは、最初の照合の前に接続が変わった場合に限る | `audio/conditions.rs:106-121` | 変えない（試験で、この窓があることを固定） | 接続の照合を `conn == current` に一本化して窓を閉じる（D-6 に含める） |
| 照合の時点 | ロックを取った後、`resolve_input_source` と開始の前 | `commands/audio.rs:409-416` | 変えない（F1b-0 で actor の上に移した後も、同じ順序で照合） | 変えない |
| エラーの文字列 | `音声の条件が変わりました。現在の設定を確認してから再試行してください。`（`localize_audio_error` を通さない） | `commands/audio.rs:442-444`、`:409-412` | 変えない | 変えない |

## 3. 開始・停止・再起動の応答

### 3.1 `start_audio`

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| 引数 | 平坦な引数 `inputSource?`・`input`・`output`・`host`・`bufferSize`・`sampleRate`・`inputId`・`outputId`・`channelRouting?`、および `expectedState?`。引数の検証は Tauri が行う | `commands/audio.rs:335-381`、`:383-388` | 変えない | 任意の項目を足してよい（`clientRequestId`、`origin`） |
| 成功の応答 | `AudioConfig { sample_rate, buffer_size, channels: 2（固定）, routing: ChannelRouting または null, stream_generation?: "e:c" }`。`stream_generation` は `None` のとき出力しない。`routing` は `None` のとき `null` | `audio.rs:89-98`、`:1698-1707` | 変えない | 任意の項目を足してよい（`sessionRevision` など） |
| エラーの文字列 | `localize_audio_error(e.to_string())`。**対象は、子の応答のエラーだけでなく、`start_with_input_source` から伝わる親の側のエラー（入力元の検証、ミキシングの選択、機能確認の失敗など）も含む**。「sample clock or rate cannot be determined」「device not found」「access is denied」「0x80070005」「アクセスが拒否」「stream configuration is not supported」を含めば、決まった日本語。それ以外は `オーディオエラーが発生しました。\n\n詳細: {元の文字列}`。**日本語の元のエラーも、この形で包まれる**。包まない例外は、`expectedState` の不一致と、`start_audio` 内の入力元の解決（`commands/audio.rs:413-415`）| `audio.rs:3044-3078`、`commands/audio.rs:409-429` | 変えない | 変えない |
| ロックの取得失敗 | `Failed to lock audio state` | `commands/audio.rs:409` | 変えない | — |
| 開始時の副作用 | `start_with_input_source` が `require_explicit_start()` を呼び、frontend の自動の開始の取り消し（`session_claimed`）を行う | `audio/process_inputs.rs:127` | 変えない | 変えない |
| 保存の副作用 | 成功のたびに `last_audio_config.json` を書く。失敗はログだけで、結果は成功 | `audio.rs:1686-1689` | 変えない | `persist` の失敗の注記を足す（任意の項目） |
| 保存する応答の内容 | 保存する `ActiveAudioConfig` は、`Response::Started` の機器 ID・経路・レート | `audio.rs:1674-1684` | 変えない | 変えない |
| 子を起動するか | **起動する**（`ensure_engine_running`）。`expected_generation` つきの warmup の開始は、既存の接続を要求する | `audio.rs:1567-1581` | 変えない | 変えない |
| 通知の前後 | `EngineEvent::Started` は子が `Response::Started` より先に出す。reader は `Started` を読んだ時点で `audio-conditions-changed` と `audio-started` を `emit` し、次の行の `Response` を待ち手へ渡す。つまり **`emit` の呼び出しは、コマンドの応答の前** | `audio_engine/core/startup.rs:2259-2265`、`core/commands.rs:603-621`、`audio.rs:914-936`、`:803-808` | 変えない（順序を試験で固定） | 新しい通知は、確定の後に出してよい。旧の通知を新しい確定に結び付けて遅らせる変更は、承認が要る |
| 失敗したときの通知 | 子の `start_audio_impl` が失敗すると、`Stopped` イベントの後に `Response::Error`。したがって失敗の開始でも、`audio-stopped` が、エラーの応答の前に出る。**例外：子の `Start` の事前の検証（`initial_controls` の検証など）による `Error` には、`Stopped` が付かない**（次の「子の `Start` の事前の検査」の行） | `audio_engine/core.rs:1328-1334`、`core/commands.rs:547-565`、`:618-622` | 変えない | 変えない |
| タイムアウト | 命令の種類で決まる（A 10秒・B 30秒・C `ProbeLoopback` は録音の時間＋10秒。F1b-0a-2、`audio/deadline.rs`）。期限を過ぎたら接続を切り離して子を回収し（C3）、`音声エンジンが応答しないため、終了しました。もう一度お試しください`（終了を確かめられなければ `engine_unconfirmed`）を返す。**タイムアウト後も `Stop` を送らない**。次の要求は、前の応答待ちで断られず、子を作り直す操作で新しい接続を使う（旧：10秒固定で、`Timeout or disconnect waiting for engine response…` を返し、`前の音声操作の応答待ちです…` で拒み続けた） | `audio.rs` の `await_reply`・`reply_timed_out`、`audio/replies.rs` | **F1b-0a-2 で変える（D-10）** | 隔離と清掃の `Stop`（承認が要る差分。設計 5.3） |
| 開始の内部の手順 | 通常の開始：`SetGlobalMute{active}` → `Start` の2コマンド（`start_with_mute`）。**`initial_controls` つきの開始では、`SetGlobalMute` を送らず、`start_on_existing_generation` が `Start`（初期の制御を載せたもの）を送る。** そのほか前提として、機能確認・二系統出力・モニターの復帰（それぞれ別の IPC）。1つでも失敗すれば、その時点で失敗 | `audio.rs:1586-1626`、`:2349`、`:3028-3038` | 変えない（`Start` に初期の制御が載ることを、送った行で観測して固定する） | 変えない |
| 確認に失敗した成功 | 機器 ID の不一致、経路の確認不能、アプリ入力の確認不能では、`Stop` を送り、`開始した機器のIDを確認できません。機器を選び直してください`、`音声エンジンが接続設定の確認に対応していません`、`アプリ入力で開始したことを確認できません。音声エンジンを更新してください` で失敗。**この `Stop` の結果は無視される**（`let _ =`）。したがって、`Stop` が失敗しても、エラーを返し、音声が残りうる | `audio.rs:1647-1672` | 変えない（残りうることを試験で固定） | 清掃の `Stop` の成功を、失敗を返す条件にする（B12。D-1 に含める） |
| 入力元の解決のエラー | `start_audio` の `resolve_input_source` のエラーは、**`e.to_string()` を直接返す**（`localize` を通さない）。`restart_audio_engine` では、マイク許可の確認だけ `localize` を通し、`preflight_live_changes`・`resolve_input_source` のエラーは `e.to_string()` を直接返す | `commands/audio.rs:413-415`、`:650-663` | 変えない | 変えない |
| `localize` の分岐 | `access denied`・`access is denied`（小文字化して判定）・`0x80070005`・`アクセスが拒否` を含めば、マイク許可の案内の日本語。`device not found`、`sample clock or rate cannot be determined`、`stream configuration is not supported` も固定の日本語 | `audio.rs:3044-3078` | 変えない | 変えない |
| 子の `Start` の事前の検査 | `initial_controls` の検証に失敗すると、子は **`Stopped` を出さずに** `Response::Error` を返す。それ以外の失敗（`start_audio_impl` の失敗）は `Stopped` の後に `Error`。親の旧の通知にも、前者では `audio-stopped` が出ない | `audio_engine/core/commands.rs:547-565`、`audio_engine/core.rs:1328-1334` | 変えない | 変えない |
| 開始の命令の列（`initial_controls` つき） | 上の「開始の内部の手順」のとおり。`SetGlobalMute` を挟まない | `audio.rs:1618-1626`、`:2349` | 変えない | 変えない |

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
| 意図した終了の通知 | `kill_engine` は `reader_active` を先に偽にするので、`audio-engine-exited`・`audio-error`（クラッシュ）は出ない。`audio-stopped` も出ない。出るのは `audio-conditions-changed`（`retire_engine` の後）と、条件つきの `live-modes-invalidated`（本番モードの世代が有効で未退役、または保護が有効のとき。`invalidate_live_protection`。`audio-conditions-changed` より前に、1回または2回）。続けて新しい接続の通知 | `audio.rs:2779-2816`、`:1042-1056` | 変えない | 終了の確定の履歴（`reason = restart`）を足す。旧の通知は増やさない |

### 3.4 補助のコマンド

| コマンド | 応答 | 子を起動するか | 備考 | 根拠 | F1a | F1b |
|---|---|---|---|---|---|---|
| `get_saved_audio_config` | `Option<ActiveAudioConfig>`。ファイルがなければ `null`、`host` が空ならエラー `保存済み接続方式が空です`、破損していれば JSON のエラー | 起動しない | **`state.lock()` を取った後で**、`last_audio_config.json` を呼び出しのたびに直接読む（`Start` がロックを持っていれば、その完了後に読む）。スナップショットにすると、欠損・破損・移行の後の結果と待ちの境界が変わりうる | `commands/audio.rs:270-283`、`audio.rs:2932-2942` | **変えない。** F1a-0・F1a-1 は同じロックの経路。F1b-0 で actor に移した後も、同じ待ちの境界を保ち、ファイルを直接読む | D-8 の対象にしない（別の差分） |
| `audio_frontend_bootstrap` | `{outcome: "started"\|"attached"\|"inactive", initialPage, error}` | **最初の呼び出しは `warmup_once` を実行する**（子を生成しうる）。4つの場合：(1) **子がない最初の呼び出し**：`warmup_once` が `ensure_engine_running` で子を作り、保存した設定で自動開始する。(2) **準備済み**：warmup が済んでいれば、状態を確かめるだけ（`auto_gain` の `Status`）。(3) **保存済みの入力のペアを待っている**（旧形式の設定）：開始せず、frontend から組が届いてから一度だけ開始する。(4) **失敗済み・既存の接続が不明**：自動では生成し直さず `inactive` を返す | 一度だけ有効。`frontend_seen`・取り消し後（reload を含む）は、状態を触らず `attached` または `inactive` | `commands/audio.rs:256-268`、`audio/frontend_bootstrap.rs:133-210`、`audio.rs:2825-2909` | 変えない | 変えない |
| `get_output_gain_observation` | `{generation: string, state: auto_gain.Snapshot}`。`generation` は `engine_generation` の10進数 | 起動しない（`Status` は `existing_only`） | 子への IPC を1回 | `commands/audio.rs:243-254`、`audio/frontend_bootstrap.rs:112-120` | 変えない | 変えない |
| `auto_gain`（`status`） | `Snapshot`（camelCase）。`running`・**`streamFailed`**・`confirmedGain` などを含む。フロントの `getAudioStreamState` は `{running, streamFailed}` を読む | 起動しない | 子への IPC（ロックを取って10秒まで待つ） | `audio.rs:2128-2190`、`audio_engine/auto_gain.rs:228-245`、`api/audio.ts:144` | 変えない | 変えない |
| `get_engine_runtime_stats`、`set_*`（ゲイン・NR・ミュートなど） | それぞれの型 | `execute_command` 経由は**起動する**。`existing_only` と `*_routed(require_running=true)` は起動しない | 個別の差は多い。F1a は全入口で「起動する／しない」を保存する | `audio.rs:1086-1126`、`audio/engine_exit.rs:222-300` | 変えない | 変えない |
| `audio_frontend_bootstrap`（旧形式の設定の、組が届いた後の開始） | 上の (3) の場合。保存した組と音量を引き継いで、一度だけ**開始する**。開始には初期の制御が載りうる | 条件つきで起動する | 上の (1)〜(4) を、K8a〜K8d で別々に固定 | `audio/frontend_bootstrap.rs:360-372`、`audio.rs:1618-1626` | 変えない | 変えない |
| `prepare_update`（更新・移行・一時利用） | `check_can_interrupt`（録音・試聴中や `maintenance` 済みなら失敗。子があれば `auto_gain` の `Status` を送る）→ 子があれば **`stop()`**（主の `Stop`、続いて配信ミックスの停止）→ `maintenance = true` → `kill_engine`。場合ごと：(a) 子がない：停止せず `maintenance` にして `kill_engine`。(b) 子があり `stop()` が成功：`audio-stopped` が出て、先へ進む。(c) **主の `Stop` が失敗**：先へ進まず、`maintenance` にならない。(d) **主は止まり、配信ミックスだけが失敗**：`stop()` はエラーを返すので更新に進まないが、**主の音声は止まったまま**。(e) `check_can_interrupt` が失敗：何も止めない | 起動しない | `finish_update_attempt` で `maintenance` を戻す | `audio.rs:2743-2777`、`:1737-1741` | 変えない | 変えない |
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

通知はすべて、reader（stdout を読むスレッド）か `AudioHost` のメソッドが、`emitter` の Mutex を持って `emit` する。`emit` はアプリ全体へ配る。**順序の契約は、reader の `emit` だけでは決まらない。** 次の3つが合わさって、今の順序になる：(1) reader が出す通知、(2) ホスト側の `Conditions::dispatch` が、`command_changes` が真の命令の前後（と、失敗時）に出す `audio-conditions-changed`（`audio/conditions.rs:70-93`、`audio.rs:1129-1141`）、(3) 同じ出来事の複数の通知（`audio-conditions-changed` → 個別の通知）を、`emitter` の Mutex を1回持つ間にまとめて出すこと（`audio.rs:836-857` など）。**F1a-0 は、この今の経路を、そのまま使う。**

| 通知 | 出る条件 | ペイロード | 同時に出るもの（`emit` の順序） | 根拠 |
|---|---|---|---|---|
| `audio-started` | 子の `Started` イベントを読み、`conditions.engine_event(epoch, true)` が真（接続が現在のもの） | `{sample_rate, buffer_size, stream_generation?}` | `audio-conditions-changed` → `audio-started` | `audio.rs:914-936` |
| `audio-stopped` | 子の `Stopped` を読み、`engine_event(epoch, false)` が真 | `{stream_generation?, ended_stream_generation?}` | `audio-conditions-changed` → `audio-stopped` | `audio.rs:878-901` |
| `audio-stream-error` | 子の `Error`（文字列）を読み、`engine_event(epoch, false)` が真 | 文字列。**番号なし** | `audio-conditions-changed` → `audio-stream-error` | `audio.rs:849-858` |
| `audio-error` | (a) 子の stdout が閉じ、`unexpected_exit` が真（`reader_active` を `swap(false)` で下げられた）(b) stdin の書き込みの失敗、応答の期限切れ（書き込み済みの VST の操作があるときは、Host が (a) と同じ `audio-engine-exited` → 旧の文字列の `audio-error` を出す） | (a) `"Audio Engine Process Exited (Crash?)"` (b) `"音声エンジンとの通信が切れました"` | (a) `audio-conditions-changed` → `audio-engine-exited` → `audio-error`。その後、待っている呼び出しに `Error("Engine Crashed/Exited")` を渡す | `audio.rs:1042-1056`、`:1170-1182` |
| `audio-engine-exited` | 上の (a) | `ExitPayload`（camelCase：`cause`、`op?`、`pluginId?`、`path?`、`classId?`、`name?`、`elapsedMs?`、`host?`、`input?`、`output?`、`phase?`） | 上の (a) | `audio/engine_exit.rs:10-33` |
| `audio-conditions-changed` | (1) 子の起動（`new_engine` の後）(2) `command_changes` が真の命令の前後・失敗時 (3) `Mixing*Failed`／`Error`／`Stopped`／`Started` の `engine_event` が真 (4) 子の終了（EOF、`kill_primary_engine`） | `()` | 同じ子のイベントに対する通知の列の中では、対応する他の通知より**先**（reader が出す列に限る。`dispatch` や `AudioHost` が応答の後に出す分は含まない。9章） | `audio.rs:638-639`、`:2798-2799`、`audio/conditions.rs:70-93` |

**この表と、下の「順序の事実」の短い列は、reader が同じ子のイベントに対して出す列に限る**（たとえば `Stopped` に対する `audio-conditions-changed` → `audio-stopped`）。これは観測される完全な列ではない。完全な列には、reader の外から出る通知が加わる。(1) `Conditions::dispatch` が、`command_changes` が真の命令の前後（と失敗時）に出す `audio-conditions-changed`。(2) `AudioHost` のメソッドが直接出す通知。終了の経路（`kill_engine` など）では、`invalidate_live_protection` が `audio-conditions-changed` より**先に** `live-modes-invalidated` を出すことがある（本番モードの世代が有効で未退役、または保護が有効なとき。`audio.rs:2812` 付近）。実測した完全な列は 9章を見る。たとえば C（停止・接続あり）の完全な列は、(1) `dispatch` の前の `audio-conditions-changed`、(2) reader が `Stopped` を受けて `audio-stopped` の直前に出す `audio-conditions-changed`、(3) `audio-stopped`、(4) 応答を受けた後に `dispatch` が出す `audio-conditions-changed`、(5) `stop_audio` の戻り（応答）、の順になる。`audio-stopped` の後に `audio-conditions-changed` が続くのは、この (4) による。
その他の通知（互換の対象。F1a は変えない）：`audio-level`、`audio-loudness`、`audio-channel-scan`、`audio-control-stall`、`audio-processing-health`、`voice-check-state`、`voice-check-envelope`、`plugin-editor-opened`、`plugin-editor-closed`、`mixing-source-failed`、`mixing-output-failed`（`audio.rs:810-1030`）。

順序の事実。

- **`audio-conditions-changed` は、同じ事象の他の通知より前に `emit` される。** フロントはこの順序を前提にしている（`NoiseMeasurementPanel.tsx:67`、`useVoiceCheck.ts:498`、`usePreparation.ts:187`）。
- 開始の成功：`audio-conditions-changed`、`audio-started`、（応答）。開始の失敗：`audio-conditions-changed`、`audio-stopped`、（エラーの応答）。停止：`audio-conditions-changed`、`audio-stopped`、（応答）。
- **上の `audio-stopped` を含む列は、現行の接続の子が `Stopped` を送り、reader がそれを受け取った場合の順序**（`engine_event` が真を返すとき：`audio-conditions-changed` → `audio-stopped` → 応答）。次の場合は、これとは別の扱いになる。(a) 開始前の拒否（親が子へ送る前の検査、または子が初期の制御などをデバイスを開く前に拒むとき）：`Stopped` が出ないので `audio-stopped` も出ない。(b) 接続なし：`kill_engine` の経路で、`audio-conditions-changed` だけ（子へ `Stop` を送らない）。(c) 手動の復旧中の停止：本番モードの VST の切替・復旧が止まっているときは、`Stop` を送らず、復旧を取り消して `kill_engine`（`stop_primary` の先頭の分岐）。出るのは `audio-conditions-changed`（と条件つきの `live-modes-invalidated`）だけ。(c') 子がすでに終了した接続（reader が無効）の停止は、`reap_confirmed_stopped_connection` が後始末し、`Stop` を送らない。(d) 旧い接続の破棄：`epoch` が違う旧 reader の `Started`・`Stopped`・`Error` は `emit` されない（次の項）。また、`payload` を付けない旧いサイドカーの `Stopped` は、今の Host がパースエラーとして捨てる（`audio.rs:1049`）ので、`audio-stopped` は出ない。
- **reader が `Response` より先に読んだ `Event` に対する旧の通知は、その `Response` より前に `emit` される**（応答の後に `Conditions::dispatch` や `AudioHost` が出す通知は含まない。reader が `Response` を待ち手へ渡す前に、同じスレッドが先に `Event` の行を読んで `emit` する。子が `Event` を `Response` より前に出すため）。**これは Rust が `emit` を呼ぶ順序の事実。WebView に届く順序は別で、W5 で測って分けて記録する。** F1a-1 は通知を出す場所を変えない（J-14）。F1b-0 で変えるなら、(a) 同じ出来事の通知の列、(b) EOF の通知から、待っている呼び出しを解放する（`Error("Engine Crashed/Exited")` を渡す）までの順序、の2つを試験で固定する。
- 古い接続の通知：`engine_event(epoch, …)` は、`epoch` が現在と違えば偽を返し、`continue` する。したがって古い `Started`・`Stopped`・`Error` は `emit` されない。ただし、`LevelMeter`・`Loudness`・`ChannelLevels`・`VoiceCheck*`・`EditorOpened/Closed`・`ProcessingHealth`・`ControlStall` は、**`reader_active` が真のあいだは epoch を見ずに `emit` される**（旧 reader が終われば止まる）。
- `audio-stream-error` の文字列は、自動の再開が `Stream Error` を含むかで判定している（`hooks/useAudioRecovery.ts:29`）。文字列は契約。

### 意図した終了の通知

| 経路 | 通知 |
|---|---|
| `stop_audio`（接続あり） | `audio-conditions-changed`、`audio-stopped`（子から） |
| `stop_audio`（接続なし） | `audio-conditions-changed`（`kill_engine` の `retire_engine`）。`audio-stopped` は出ない。`kill_engine` を通るので、条件によっては `live-modes-invalidated` も出る（下の行） |
| `restart_audio_engine`／`kill_engine` | `audio-conditions-changed`。本番モードの世代が有効で未退役、または保護が有効（`armed`）のときは、その前に `live-modes-invalidated` も出る（`invalidate_live_protection`。1回または2回）。`audio-engine-exited`・`audio-error` は出ない（`reader_active` を先に偽にするため） |
| `prepare_update`（子がある） | 先に `Stop`：`audio-conditions-changed`、`audio-stopped`、その後の `kill_engine` で `audio-conditions-changed`。`audio-engine-exited`・`audio-error` は出ない。子がなければ `audio-conditions-changed`（と、条件によって `live-modes-invalidated`）。`kill_engine` の前に `live-modes-invalidated` が出る条件は上の行と同じ |
| アプリの終了（`quit_app`。`Drop` が走るかは保証しない） | 何も出さない |
| 異常終了（EOF） | 上の `audio-error` の (a) |

## 6. メーター

| 項目 | 事実 | 根拠 | F1a | F1b |
|---|---|---|---|---|
| イベント名 | `audio-level` | `audio.rs:863-876` | 変えない | 変えない |
| 形 | `{ input: [f32, f32], output: [f32, f32], stream_generation?: "e:c" }`。`input`・`output` はペイロードの最上位（`flatten`）。`stream_generation` は `None` のとき出力しない | `audio.rs:111-117`、`ipc.rs:880-910` | 変えない | 任意の項目 `seq` を足してよい |
| 子から親の形（ワイヤ） | **1行**。`IPC:` で始まる行に JSON。外側は `{"kind":"Event","data":{…}}`（`OutputMessage`）。内側は `{"type":"LevelMeter","payload":{"input":[..],"output":[..],"stream_generation":N}}`。**`stream_generation` は省略できる**（`None` のとき出力しない。旧の子はなし）。#827 で、仕様書の記述が食い違っている | `audio.rs:800-803`、`ipc.rs:880-910`、`:951-975`、`:1074-1082` | 変えない | 仕様書は別の文書の修正（設計 J-6） |
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
3. **旧の通知は、今の経路のまま出す（F1a-0）。** reader からの `emit`、`AudioHost` のメソッドからの `emit`、`Conditions::dispatch` の前後の `audio-conditions-changed`、`emitter` の Mutex の下での複数の通知のまとめを、いずれも変えない。保証するのは次の2つに限る。(1) 同じ子のイベントに対する通知の列（reader が出す順）。(2) reader がその要求の応答を待ち手へ渡すまでの順序（その要求の応答より前に、同じ子のイベントに対する通知を出し終えている）。応答の後に `dispatch` や `AudioHost` が出す `audio-conditions-changed`（たとえば停止・再起動の実測の列。9章）は、この保証に含めない。Emitter のキューを経由して順序を変えない。Emitter は F1b の新しい通知（`audio-session`）とメーターのためだけに使う。F1a-1 は通知を出す場所を変えない（J-14）。F1b-0 で場所を変える場合は、5章の最後の2つの順序（同じ出来事の通知の列、EOF の通知から待ち手の解放まで）を試験で固定してから変える。
4. **読み取りの待ちの境界：** `get_audio_state` と `get_saved_audio_config` は、いずれも `state.lock()` を取ってから読む。`Start` がロックを持っている間に呼ばれた読み取りは、開始が保存と `active_config` の更新を終えた後の値を返す。F1a-0・F1a-1 は同じ `Mutex` の経路を使い、F1b-0 で actor に移した後も同じ待ちの境界を保つ（`SnapshotCell` にしない）。
5. **`expectedState` の比較：** F1a-0 は、既存の完全一致のまま（`commands/audio.rs:433-447`）。旧の項目に写す処理は、F1b で拡張のキーを実際に足すときに入れる（試験は F1b の K3）。
6. 意図した終了で `audio-engine-exited`・`audio-error` を出さないこと。
7. `localize_audio_error` の包み方（start／restart で、子の応答のエラーと、`start_with_input_source` から伝わる親の側のエラーの両方。3.1 の直接返るエラー〔入力元の解決・事前の検査〕は包まない）。`stop_audio` を包まないこと。
8. `expectedState` の完全一致の規則と、エラーの文字列。
9. 子を起動する／しない（4章）。
10. 保存の副作用（成功のたびに `last_audio_config.json` を書く。失敗はログだけ）。
11. 10秒の期限と、タイムアウト後の「応答待ち」の拒否の文言。
12. `get_saved_audio_config` は、`state.lock()` を取ってから、ファイルを直接読む。
13. `Stop` が無視される箇所（機器 ID の不一致の後）も、そのまま（試験で、音声が残りうることを固定する）。

### 8.2 F1b で安全のために変える候補（個別に承認する差分）

受付順を記録すること（F1a-0）と、その順序で利用者から見た勝ち負けを変えること（D-9）は、別の差分として承認を求める。F1a-1 の安全のための変更（D-13）も、F1a の中で個別に承認を求める。実行の順や別の接続の進行を変える差分（D-9・D-10。actor・受信箱・writer・reaper の F1b-0）は、F1a には含めない（J-14）。

| # | 変更 | 影響する利用者の挙動 | 承認の観点 |
|---|---|---|---|
| D-1 | 開始のタイムアウトの後に、清掃の `Stop` を送り、応答がなければ接続を隔離する。機器 ID の不一致の後の `Stop` の成功を、失敗を返す条件にする | タイムアウト後に、音声が止まる（今は遅れて動き出す）。**音が止まるまでの時間：`Reaped`（プロセスの終了）を確かめられた場合に、最大でおよそ32秒**（設計 5.3）。確かめられない場合は、物理的な停止も確かめられていないものとして扱い（`Unconfirmed`）、「音が止まった」とは言わない。隔離すると VST の状態（読み込み済みのプラグイン、パラメーター）が失われる | VST の状態を失う条件（`Stop` の応答なしが20秒続いたとき）と、音が出続ける窓のどちらを優先するか。窓そのものの解消は別の Issue（J-4） |
| D-2 | `is_running` を、プロセスの終了の確定後に `false` にする（既存の `get_audio_state` の意味の変更。D-8 の「待ちの境界を外す」変更とも、新しい `get_audio_session` の追加とも別の差分） | EOF で死んだ後の表示が、すぐ正しくなる | EOF とプロセスの終了を分ける。`is_running` を使う VST の復元の経路（`hooks/usePlugins.ts:370`、`:440`）と、動作を比べてから決める |
| D-3 | `Start` の期限（10秒）は**保つ**（推奨）。延ばす変更は、別の承認 | 失敗の表示の速さが変わる | 利用者の体験（J-4 で10秒を維持と決定） |
| D-4 | 保存の結果を、開始の応答の任意の項目（`persist`）に足す。保存の結果が決まるまでは、`failed` と報告しない（`PersistPending`） | 今はログだけ | 旧フロントの型（追加の項目を許すか）。`PersistPending` の表示（設計 J-10） |
| D-5 | 子のエラーのコールバックを、atomic の印（世代・input／output の区別）だけにし、文字列と番号つきの通知は制御ループから出す | 旧の `audio-stream-error` の出るタイミングがわずかに遅れうる | RT の試験。**契約に含めるもの：入力と出力の区別、ストリームの世代、文字列に `Stream Error` を含めること**（`hooks/useAudioRecovery.ts:28-31` の旧の復旧のフィルター）。固定の印だけでは再現できない詳しい文面（`Input Stream Error: …` の詳細）は、ログへ残し、通知の文字列は区別の語を保つ |
| D-6 | 古い接続の `LevelMeter`・`Loudness` などを世代で捨てる。`Conditions` の接続の照合の窓を閉じる | 旧 reader の遅れた値が出なくなる | **同じ接続の中のストリームの切り替え（A → B）での旧のメーター**、旧のメーターの購読側の頻度と最初の値（`hooks/useMeterLevels.ts:48-58`）を、確かめてから決める |
| D-7 | `Stop` の応答待ちで子が応答しないときの隔離。**主のエンジンと配信ミックスを分ける**：配信ミックスは、`Stop` が失敗すると、今も子を終わらせる（`child.kill_engine()`）。主は今は10秒で失敗するだけ | 主の応答なしで、VST の状態を失う条件が新しく生じる | D-1 と同じ観点。配信ミックスの今の挙動（`audio/post_mix.rs:644-650`）は、変えない前提で比べる |
| D-8 | **既存の** `get_audio_state` の待ちの境界を外し、`SnapshotCell` から返す（待たない）。**新しく作る** `get_audio_session` は、最初から待たない読み取りで、この承認の対象ではない（新しい契約） | 先行する命令の完了前の値が返る。直後の `expectedState` の照合に影響する（旧の境界を変える） | 旧の読み取りの待ちの境界。F1a は変えない |
| D-9 | 通常の開始の `Superseded`：開始の待ちの間に停止を受け付けたら、確定せず清掃する | 今は、停止が開始の後ろに並び、開始が成功してから停止される | 受付順の記録とは別の差分。利用者から見た勝ち負けを変える（保存される設定が変わる） |
| D-10 | stdin の書き込みの5秒での隔離。基準では、書き込みと flush が同期で終わってから、10秒の応答の待ちに入る。**書き込みが詰まること自体には、今は上限がない** | 今は、詰まった書き込みを待ち続ける。隔離で、VST の状態を失う条件が新しく生じる | 隔離で VST の状態を失う条件。**決定（J-12・J-14）：F1b-0 まで延ばす。** F1a-1 は書き込みを今のまま同期で行う。過負荷のときの拒否（`busy_overloaded`）と、停止を優先する実行も、F1b でこの承認とともに有効にする（設計 18.3）。**F1b-0a-1 で書き込みの5秒の切り離し（C2）、F1b-0a-2 で応答の期限の切り離し（C3）と命令の種類ごとの期限を入れた** |
| D-11 | 旧の通知を間引く・Emitter を通す（F1b で新しい通知を足すとき） | 旧の通知の発行の順序・頻度が変わりうる | 旧の通知の発行の順序（F1a で固定したもの）を変える差分。変えるなら、購読側（15箇所）への影響を確かめてから |
| D-12 | メーターの任意の項目（`seq`）の追加 | 旧の購読側は無視 | 旧の形（`input`・`output`）は保つ |
| D-13 | F1a-1（設計 18.3 の第5版）：(a) 子を停止の状態で作り、Job に入れてから動かす。Job の作成・割り当て・再開の失敗は、その子を終わらせて起動を失敗にする。(b) 終了の待ちを、上限のない `wait()` から、最大2秒の確認に変える。終わらない子は主の `AudioHost` の役割ごとの記録（`retired`）に残し、同じ役割の子を作る要求は、最初の `kill()` から10秒の期限（要求ごとにやり直さない）で `engine_unconfirmed` で失敗する（3回続けたら J-13 の文言）。(c) `try_wait()` の失敗（`Err`）で作り直さない。(d) アプリの終了での子と孫の回収は Job の kill-on-close に任せる（保証は Job に入った子に限る。`Drop` が走ることは保証しない）。`Drop` が走った場合は、全部の子に共通の2秒で終える（今は上限なく待つ）。(e) `prepare_update` は、終わらない子が残ったら `engine_unconfirmed` を返し、更新・移行・一時利用へ進まない。(f) `kill_engine()` の後に結果を返す既存の入口（VST の復旧の途中の停止、書き込みの失敗など）は今の結果を返すが、旧の子がまだ生きている場合がある（作り直しは止める）。(g) 停止の状態で作ってから Job に入れるまでの窓で親が強制終了されると、停止したままの子が残る（J-15）。この窓は受け入れる。自動の回収は行わず、回復は Windows の再起動とする。更新・アンインストールが妨げられた場合は、再起動してから再試行する。Job の作成・割り当てに失敗し、終了を確かめられないまま親が終わった子も同じ扱い。**遅れて終了を確かめたときの表示と、EOF の後の自動の隔離は F1b-0（J-14）** | 今は割り当ての失敗を無視し、終わらない子をロックを持ったまま上限なく待つ。起動できない場合と、10秒で失敗を返す場合が新しく生じる（今は止まり続ける） | **決定：承認する。承認の条件は、18.3（第5版）の W 行の確認**：W1a・W1b・W1b'・W1c（Job の作成・割り当て・再開の失敗）、W2、W4a・W4b（アプリの通常の終了・強制の終了）。W1・W4 は実プロセス（一部は注入と併用）、W2 は失敗の注入で確かめる。**承認の範囲には、次の制約を含める：** 残った子が更新・アンインストールを妨げた場合は、Windows を再起動してから再試行する。MSIX でも、旧版のパスに子が残る場合がある。結果を見てから、F1a-1 のマージを承認する（16.1） |
| D-14 | 子の `Error` に世代と side を付ける。`apply_deadline` つきの適用 | 旧のペイロード（文字列）は保つ | 子の側の差分 |

## 9. 実測した範囲と、確かめていないこと

- 旧の通知とコマンドの応答が、WebView に届く順序：**実測した（2026-11-21、開発ビルドの実 WebView。2回目の測り直しの結果）。** 仕組みは、Rust の `AURALYN_EMIT_TRACE=1` と、WebView 側の `src/lib/w5Probe.ts`（`invoke` の呼び出し・応答（拒否）、購読の登録、通知の受信を `window.__auralynW5` に並べる）。手順は [TESTING](../TESTING.md) の W5。
  - **訂正（1回目の記録）：** 1回目は、B（開始の失敗）と C（停止）で `audio-stopped` が出なかった（各10回）と記録した。これは製品の挙動ではなく、**古い子（サイドカー）で測ったため**。`tauri dev` はサイドカーをビルドせず、Host は `src-tauri/target/debug/audio_engine.exe` を使う。そこに残っていた子は `Stopped` に `payload` を付けない旧い形で、今の Host が `Engine IPC parse error: missing field 'payload'` として捨てた（そのログが20件。B・C の各10回に対応）。5章の「停止：`audio-conditions-changed`、`audio-stopped`、（応答）」は、版をそろえた測定で成り立った（下）。1回目の遅れの数値も、この表で置き換える。
  - **子（今回）：** `D:\Programming\App\VSTHost\src-tauri\target\debug\audio_engine.exe`（実行中の子のパスを `Win32_Process` で確かめた）。SHA-256 は `13A29A40722B933A2F998CBE8E20187A31D2ACFC860921EB5AC1EBF499CBEBE0`。これは、今のソース（`df234df3` と同じ `audio_engine/` と `bin/`。F1a-0 はサイドカーのコードを変えていない）から `cargo build --release --locked --bin audio_engine` で作った `target/release/audio_engine.exe`（2026-11-21 12:59）と同じファイル。`Engine IPC parse error` は0件。同じファイルを単独で起動して読んだ生の IPC：`Stop`（接続あり）は `{"kind":"Event","data":{"type":"Stopped","payload":{"stream_generation":1,"ended_stream_generation":1}}}` の次に `{"kind":"Response","data":{"type":"Success"}}`。開始の失敗は `Stopped`（`payload`：`{"stream_generation":2}`）の次に `Response::Error("Input device not found: no-such")`。
  - **debug の子は使えなかった：** 今のソースから `npm run rebuild-engine` で作った debug の子（SHA-256 `87906AE1FA4E8E601A11DDBE41AC6B26EE0C518C3C3DB66E11EA08B373F7B6FC`）は、WASAPI の実機を開く `Start` で `thread 'main' has overflowed its stack`（終了コード 0xC00000FD）で落ちた（Host のログでは `audio-engine-exited`（`cause: device_open`）。単独起動でも再現）。サイドカーのコードは e3d37ead から変わっていないので、この差分のせいではない。原因は調べていない（#309 の記録にも、機器を開くときのスタックオーバーフローがある）。そのため、測定は release の子で行った。debug の子での挙動は未測定。
  - 条件：Windows 11、`npm run tauri -- dev --config src-tauri/tauri.debug-global.conf.json`（Host は debug）、WASAPI（入力：再生リダイレクト、出力：Voicemeeter In 2、512、48000、独立出力 1/2）。画面の操作ではなく、画面と同じ `audioApi.start`・`stop`・`restart` を WebView から呼んだ。応答の後 700ms 待った。各場面10回。
  - 結果（Rust が呼んだ順と、WebView が受け取った順は、50場面の全部で一致。食い違い0回）。`x` は `invoke-rejected`。
    - A 開始の成功：`conditions ×4`、`audio-started`、`conditions`、応答（`resolved`）。9回。1回は、その後に `conditions ×2` が続いた。
    - B 開始の失敗（存在しない機器）：`conditions ×4`、**`audio-stopped`**、`conditions`、応答（`x`、`rejected`）。10回。
    - C 停止（接続あり）：`conditions ×2`、**`audio-stopped`**、`conditions`、応答（`resolved`）。10回。
    - D 停止（接続なし）：開発セッションで子のプロセスを終了させ、reader が無効になったこと（`audio-engine-exited` と `audio-error` の受信）を確かめてから呼んだ。`conditions`、応答（`resolved`）。**`audio-stopped` は出ない**（子へ `Stop` を送らず、`kill_engine` の経路）。10回。
    - E 再起動：`live-modes-invalidated`、`conditions ×6`、`audio-started`、`conditions`、応答、`conditions ×2`。10回。`audio-stopped`・`audio-engine-exited`・`audio-error` は出ない。
  - 通知（A・B・C・E）は272件で、すべて届き、欠落は0。応答（A・B・C・E の40件）は、同じ場面の応答の前の `emit` がすべて届いた後に届いた。
  - 遅れ（A・B・C・E。Rust の `emit` から WebView の受信まで）：中央値 0.5ms、最大 45.3ms。（`return` から応答の受信まで）：中央値 27.1ms、最大 46.1ms。
  - この測定は、聴感・実音声の合格ではない。範囲外：子の異常終了（EOF）の通知の順（D の準備で起きたが、順は照合していない）、複数ウィンドウ、本番ビルド（計測点は開発ビルドだけ）、debug の子、`audio-level` などのメーター。
- 旧の通知とコマンドの応答の順序の測り直し（F1b-0a-1、2026-11-22、コミット `7bd67bc4`）：**実測した。** F1b-0a-1 は、子の stdin を接続ごとの writer へ集め、子の回収を通知より先にし、通知を `emitter` のロックの外で `emit_order` の列として出す。通知の順・欠落・応答との前後が F1a-0 から変わっていないかを、同じ手順（[TESTING](../TESTING.md) の W5）で確かめた。
  - **子：** `D:\Programming\App\VSTHost\src-tauri\target\debug\audio_engine.exe`（実行中の子のパスを `Win32_Process` で確かめた）。SHA-256 は `6721D9258947BAE10189E091C55A2B7088D9A8CDD180736CF861150EF678FA53`。`cargo build --release --locked --bin audio_engine` で作った `target/release/audio_engine.exe` と同じファイル（ハッシュ一致）。F1a-0 の記録のハッシュと違うのは、このバイナリが Host と同じライブラリを含み、F1b-0a-1 のコミットから作り直したため。サイドカーの IPC の形は変えていない。`Engine IPC parse error` は0件、`panicked` も0件。
  - **条件：** F1a-0 と同じ。Windows 11、`tauri dev --no-watch --config src-tauri/tauri.debug-global.conf.json`（Host は debug、`AURALYN_EMIT_TRACE=1`）、WASAPI（入力：再生リダイレクト、出力：Voicemeeter In 2、512、48000、独立出力 1/2）。画面と同じ `audioApi.start`・`stop`・`restart` を WebView から呼び、応答の後 700ms 待った。起動直後に保存した設定で音声が自動で始まっていたので、測定の前に停止した。A・B・C・E は1周で A→C→B→E の順に10周（各10回）、D は子を外から終了させて10回。
  - **結果（A・B・C・E・D の各10回、計50場面）：** Rust が `emit` を呼んだ順と、WebView が受け取った順は、聴取対象の通知465件の全部で一致（食い違い0）。欠落0。
    - A 開始の成功：`conditions ×4`、`audio-started`、`conditions`、応答。9回。1回は、その後に `conditions ×2` が続いた（F1a-0 と同じ形・同じ回数）。
    - B 開始の失敗：`conditions ×4`、`audio-stopped`、`conditions`、応答（`invoke-rejected`）。10回。
    - C 停止（接続あり）：`conditions ×2`、`audio-stopped`、`conditions`、応答。10回。
    - D 停止（接続なし）：`conditions`、応答。10回。`audio-stopped` は出ない。毎回、子の PID が OS 上で終わったことと、`audio-engine-exited`・`audio-error` の受信を確かめてから呼んだ。
    - E 再起動：`live-modes-invalidated`、`conditions ×6`、`audio-started`、`conditions`、応答、`conditions ×2`。10回。`audio-stopped`・`audio-engine-exited`・`audio-error` は出ない。
  - **F1a-0 では範囲外だった、子の異常終了（EOF）の順（D の準備で10回）：** 毎回 `audio-conditions-changed`、`audio-engine-exited`、`audio-error` の順に、間に別の通知を挟まずに届いた（Rust の呼び出し順とも一致）。その後ろに、画面の読み取りが接続の喪失を見て出す `live-modes-invalidated`、`conditions` が続く回があった。これは F1a-0 から変えていない経路の通知で、順は 2.4 の設計どおり（EOF の3つ → 待ち手の解放）。
  - **応答との前後：** 応答（71件。うち計測外の後始末の停止を含む）は、すべて、同じ場面の応答の前の `emit` が WebView に届いた後に届いた（逆転0）。
  - **遅れ：** Rust の `emit` から WebView の受信まで、中央値 2.0ms、最大 54.0ms（D と後始末の停止を含む）。`return` から応答の受信まで、中央値 37.4ms、最大 58.6ms。F1a-0（中央値 0.5ms・最大 45.3ms／中央値 27.1ms・最大 46.1ms）より、中央値が大きい。通知の列を `emit_order` で直列化したことの影響か、測定時の負荷の違いかは切り分けていない（通知の順・欠落には影響がなく、最大値も同程度）。
  - **F1a-0 との違い：** 通知の名前・順・件数・欠落・応答との前後は同じ。違いは、EOF の順を測れたことと、遅れの中央値の差だけ。
  - この測定は、聴感・実音声の合格ではない。範囲外：複数ウィンドウ、本番ビルド、debug の子、`audio-level` などのメーター、C2（書き込み5秒）・C5 の実機での再現（試験は Rust の試験で確かめた）。
- `get_audio_state` を、ロックを待たない形にしたときの、フロントの2秒ごとの照合への影響。
- 子の `Stop` が、ストリームを実際に止める時間（フェードの待ち）。
- `stop_audio` の `Pending` が落ちるタイミングで進む `revision` が、witness の照合に与える影響の細部。

# 音声セッションの正本を Rust の親に置く設計（第2版・F0）

状態：設計のみ。コードは変えていない。第1版への独立レビュー（GPT-6.2 Sol、BLOCK）の P1・P2 をすべて解く。
関連：#825、#806、#827。比較の基準は `origin/main`（`9567061a`）。
姉妹文書：[旧 API の互換の契約](audio-session-compat-contract.md)、[合格の条件の表](audio-session-acceptance.md)。

この文書では、事実と設計を分けて書く。

- **【事実】**：`9567061a` のコードで確かめたこと。位置を `ファイル:行` で示す。実機では確かめていない。
- **【設計】**：これから作ること。コードに現れるまで、動作の証拠にしない。

## 0. 用語

| 用語 | 意味 |
|---|---|
| 接続（`ConnId`） | 子プロセス（sidecar）1つと、その stdin・stdout の組。値は今の `engine_generation` を、起動時に採った値（`audio.rs:773`）。 |
| 試行（`AttemptId`） | 親が `Start` を1回送るごとに振る番号。接続の中で単調増加する。 |
| ストリーム（`StreamId`） | 実際に動いた音声。今のラベル `"{接続}:{子の stream_generation}"` を変えずに使う（`audio.rs:102`）。 |
| 要求（`RequestId`） | 外からの命令1つ。親が振る。再送の判定には、フロントが振る `clientRequestId` も受ける。 |
| 受付順（`seq`） | 命令を受け付けた順の通し番号。勝敗の判定は、この1つの順序だけで行う。 |
| 操作世代（`manual_epoch`） | 利用者の直接の操作（ホームの開始・停止、再起動など）を受け付けるたびに進む番号。 |
| 履歴（`occurrence`） | 取りこぼすと困る出来事。`occ_seq` で順に並べる。 |
| 状態の版（`revision`） | 状態が変わるたびに進む番号。履歴の `occ_seq` とは別に持つ。 |

## 1. 【事実】今のコードで確かめたこと

設計の前提になる事実だけを挙げる。互換に関わる細部は互換の契約に書く。

| # | 事実 | 位置 |
|---|---|---|
| F-1 | 音声の状態は `Arc<Mutex<AudioHost>>` が持つ。Tauri のコマンド、トレイ、ショートカット、更新、移行、OBS、warmup、10ms 周期のスケジューラが、同じロックで入る。 | `audio.rs:3041`、`lib.rs:309-312`、`lib.rs:350`、`lib.rs:382-392`、`audio/mode_vst.rs:526-535`、`shortcuts.rs:420`、`updates.rs:161`、`migration.rs:472`、`temporary_session.rs:280`、`obs.rs:46` |
| F-2 | 子との IPC は、要求 ID のない直列の1本。応答待ちは `ReplySlot`（1件）で、待ちは `recv_timeout(10秒)`。タイムアウトした後は、遅い応答を受けるまで次の要求を拒む。 | `audio/replies.rs:1-40`、`audio.rs:1161-1188` |
| F-3 | 子の stdout を読むスレッドが、通知を `emit` で直接出す。`emitter` の Mutex を持ったまま `emit` する。応答は `pending_reply_tx.deliver` で待ち手へ渡す。 | `audio.rs:788-1057` |
| F-4 | 子は stdin を専用スレッドで読み、制御ループへ積む。`Start` は制御ループを塞ぐので、後ろに積まれた `Stop` は `Start` が返るまで動かない。stdin の EOF は `Shutdown` になる。 | `audio_engine/core.rs:602-630` |
| F-5 | `Start` の中で、子は機器のフォールバックを何度か試す。試行ごとに `begin_stream_generation` で子の番号を振る。成功時は先に `EngineEvent::Started`、その後に `Response::Started`（機器 ID とルーティング入り）を送る。失敗時は `Stopped` イベント、その後に `Response::Error`。 | `audio_engine/core/startup.rs:361-373`、`:414`、`:2259-2265`、`audio_engine/core/commands.rs:547-625`、`audio_engine/core.rs:1323-1334` |
| F-6 | `Stop` コマンドは、動いていなくても `Stopped` イベントを出し、その後に `Response::Success` を返す。 | `audio_engine/core.rs:1421-1429`、`core/commands.rs:626-629` |
| F-7 | 子のエラー通知（`EngineEvent::Error`）には、音声の番号がない。出力・入力のコールバックが、`serde_json` と `println!` で直接書く。 | `ipc.rs:905`、`core/startup.rs:632-640`、`:2086-2093` |
| F-8 | メーターは、子の制御ループが約16ms ごとに最大値へまとめて送る。無音が続くと、ゼロは1回だけ送る。メーターの番号は、最後に始めた試行の番号。 | `core/meter.rs:1-60`、`core.rs:790-810` |
| F-9 | 親は `Start` の成功のたびに `last_audio_config.json` を書く。失敗はログだけで、開始は成功を返す。書き込みは一時ファイル→`rename`。 | `audio.rs:1686-1689`、`migration.rs:305-327` |
| F-10 | 親は終了を3通りで気づく。reader の EOF（`audio.rs:1042-1056`）、`try_wait`（`:610`、`:1727`）、`kill_engine`（`:2779`）。`reader_active` の `swap(false)` が、EOF での通知を1回に絞る。EOF では `child` を片付けないので、`is_running` は `true` のまま残る。 | `audio/engine_exit.rs:340-352`、`audio.rs:2916-2919` |
| F-11 | 停止の意図は、ロックを待つ前に `interrupt_restore()`（atomic）で登録される。 | `audio/conditions.rs:55-58`、`commands/audio.rs:489` |
| F-12 | 子の起動直後のピーク保護の引き継ぎは、同期で IPC を待つ。失敗すると `kill_engine` する。 | `audio.rs:1059-1082` |
| F-13 | 配信ミックス用に、もう1つの `AudioHost`（`--post-mix-worker`）が、主の `AudioHost` の中に入っている。 | `audio/post_mix.rs:276`、`:383-392`、`audio.rs:728` |
| F-14 | stdin を別スレッドで書く先例がある（`mode_vst` の `writer`）。 | `audio/mode_vst.rs:553-566` |
| F-15 | 子の停止中のストリームの有無は、`auto_gain` の `Status`（子への IPC）でしか分からない。`get_audio_state.is_running` は、子プロセスがあるという意味。 | `api/audio.ts:144`、`audio.rs:2128-2160`、`audio.rs:2916` |
| F-16 | フロントは `audio-started` などを十数か所で直接購読する。自動の再開は、`audio-stream-error` の文字列に `Stream Error` を含むものだけに反応する。 | `hooks/useAudioRecovery.ts:28-31`、`hooks/useAudioConfig.ts:181`、`:255`、`hooks/useMeterLevels.ts:48-58`、`hooks/usePreparation.ts:186` |
| F-17 | 保存は3か所にある。Rust の `last_audio_config.json`、WebView の `localStorage['vst_host_audio_config']`、ホームの `persist`（= `handleConfigUpdate(config,{audioStarted:true})`）。 | `audio.rs:1687`、`hooks/useAudioConfig.ts:58`、`App.tsx:231`、`components/layout/ModalLayer.tsx:309`、`api/presets.ts:255` |
| F-18 | #806 の「音が届いた」は、フロントの `soundArrival.ts` が、ゼロを挟まないレベルが250ms・5件続いたことで決める（`codex/music-setup-806-v2`）。 | 同ブランチの `soundArrival.ts` |

## 2. 場面と原則

場面 S1〜S6 は第1版を引き継ぐ。

- S1：ホームで開始・停止する。押したとおりに動く。
- S2：配信中に機器が抜けたら自動で再開する。利用者が止めたり、別の音声を始めたりしたら、手を出さない。
- S3：セットアップで音を確かめる（声も音楽も）。確かめるあいだは保存しない。保存すると確かめた音声が本番になる。やめたら元へ戻す。
- S4：別の用途の音声が動いているとき、利用者の同意なしに止めない。同意は同意した音声にだけ効く。
- S5：エンジンが異常に終わったら、1回だけ知らせる。新しいエンジンの状態は壊さない。
- S6：画面を開き直しても、今の状態に追いつく。過去の出来事を二重に知らせない。

原則 P1〜P7 も引き継ぐ。第2版で次を足す。

- **P8：勝敗は受付順だけで決める。** 複数のフラグや epoch を、別々に読み比べない。
- **P9：actor は待たない。** 子の応答を待つあいだも、入力の受付・EOF・期限・停止の受付は止めない。
- **P10：結果は1回だけ返す。** 同じ要求に2回以上の結果を返さない。
- **P11：終了は接続ごとに1回だけ確定する。** 履歴への記録と、今の状態への作用は別に扱う。

## 3. 全体の構成

【設計】

```text
Tauri コマンド / トレイ / ショートカット / warmup / スケジューラ / OBS / 更新 / 移行 / 一時利用 / 配信セット
        │ AudioControl（受付）
        ▼
  Admission（葉のロック）── seq・manual_epoch・latest_stop_seq を採番し、受信箱に積む
        │
        ▼                      ┌─ Reader 1本/接続（stdout を行ごとに解釈。ロックなし）
  Actor スレッド（1本）◀──受信箱─┤─ Writer 1本/接続（stdin の書き込み）
   ・SessionState                ├─ Reaper 1本/接続（child.wait）
   ・接続（主・配信ミックス）      ├─ Persist 1本（ファイルの置き換え）
   ・段階の状態機械               └─ Timer（期限。受信箱へ Deadline を積む）
        │ 結果・履歴・スナップショット
        ▼
  Emitter（1本。ロックの外で emit）／ SnapshotCell（読み取り専用の Arc）／ MeterCell（最新値）
```

### 3.1 入力の種類

actor の受信箱は1本で、次の入力だけを受け取る。

```text
Input =
    Command   { seq, ticket, kind, reply: oneshot }
  | Wire      { conn, line: Response | Event }      // reader から（到着順 = 子の出力順）
  | Eof       { conn }                              // reader から
  | Reaped    { conn, status }                      // reaper から
  | WriteDone { conn, token, result }               // writer から
  | PersistDone { token, result }                   // persist から
  | Deadline  { token }                             // timer から
  | MeterReady{ conn }                              // reader から（まとめて1件）
  | Shutdown
```

ロックの規則（レビュー N8、A1 の「ロックの順序」の解）。

- actor は、他のスレッドが持つロックを、待つ形では取らない。
- 葉のロックは3つだけ。`Admission`、`SnapshotCell`（`RwLock<Arc<Snapshot>>`）、`MeterCell`（`Mutex`）。いずれも、持っているあいだに別のロックも I/O も `emit` も行わない。
- reader は actor のロックを取らない。`emitter` の Mutex は廃止し、`emit` は Emitter スレッドだけが行う（F-3 の解消）。
- 受信箱は無制限のキューだが、reader は `LevelMeter` を積まない（10章）。積む量は、応答・通知の数に比例する。

### 3.2 読み取りは actor を通さない

`get_audio_state`、`get_audio_session`、`get_saved_audio_config` などの読み取りは、`SnapshotCell` から不変の `Arc<Snapshot>` を返す。actor が10秒待っていても、読み取りは待たない。

ただし `auto_gain` の `Status` のように、子へ問い合わせる読み取りは、今は IPC で待つ（F-15）。F1a では今のまま、actor の「1段の待ち」に入れる。F1b で、ストリームの状態（動作中・障害）をスナップショットの項目にして、問い合わせを減らす。

### 3.3 子プロセスの起動・再起動（接続の生成）

起動は `Spawn` の状態機械で行う。接続の世代の更新、起動時の IPC（ピーク保護・true-peak の引き継ぎ、F-12）、旧 reader の終了処理まで含める。

1. 旧接続があれば、`Teardown`（4.4）を先に終える。終わるまで、新しい接続は作らない。
2. `ConnId` を採り、子を起動し、Job Object に割り当てる。reader・writer・reaper を起動する。
3. 引き継ぎの IPC を、段として順に送る。1つ失敗したら、その接続を `Teardown` し、結果は「開始していません」の失敗にする。
4. 機器のスキャンは、今の `DeviceScanTicket` の方式（`audio.rs:38-48`）をそのまま、1段の待ちとして扱う。接続が変わったら、チケットは古いものとして捨てる。

## 4. actor の段階の状態機械

### 4.1 基本の考え方

actor は、受信箱から1件ずつ取り出す。1つの命令は、次の形で進む。

```text
受付 → [段 k：送る（write を writer へ）→ 応答・通知・期限を待つ] → 段 k+1 → … → 完了（結果を1回返す）
```

- 段を実行している間（= 「処理中」）に届く `Command` は、`held` の列（到着順）へ入れる。処理中でも、`Wire`・`Eof`・`Reaped`・`WriteDone`・`Deadline`・`MeterReady` は、すぐに処理する。
- 停止の受付は、`Admission` の時点で `latest_stop_seq` に反映されている（6章）。actor が `Command` を取り出す前から、段の境目で見える。
- 同期の `AudioHost` のメソッドは、actor スレッドの上で動く。子の応答を待つ箇所は、次の「ポンプ」を使う。

**ポンプ**：`await_response(owner, deadline)` は、受信箱を読み続ける関数。

- 現在の接続の `Response` が来たら、それを返す。
- `Event` は、段や命令の種類によらず、その場で処理する（状態の更新・履歴・`emit` の依頼）。
- `Eof`・`Reaped` が来たら、接続の終了を確定し（7章）、待ちを `Err(ConnectionEnded)` で返す。
- `Deadline` が来たら、`Err(Timeout)` で返し、接続を `Suspect`（応答の遅れを疑う）にする（5.3）。
- `Command` は `held` へ入れる。
- `WriteDone(Err)` が来たら、接続を隔離する（4.5）。

これで、同期のメソッド（`load_plugin` など）は、書き換えずに actor の上で動かせる。`Start`・`Stop`・再起動・`Spawn`・`Teardown`・終了の処理は、ポンプではなく、明示の段（`enum Stage`）にする。競合の試験が、段の組み合わせを列挙できるようにするため。

### 4.2 命令の分類

| 種類 | 例 | 実行 |
|---|---|---|
| 明示の段 | 開始、停止、再起動、再開、確認の開始・保存・取り消し、更新のための停止 | `Stage` の状態機械 |
| 1段の転送 | 読み込み、並べ替え、ゲイン、ボイスチェック、ミュート、`auto_gain` など | `Rpc`（送る→ポンプ→返す） |
| 複数の転送の列 | 配信セットの適用、プロファイルの適用、VST の一括復元 | 同期のメソッドを actor の上で実行する。長い間 `held` を溜めるので、各転送のあいだに、停止の受付（`latest_stop_seq`）を確認する |
| 読み取り | 状態、履歴、保存済みの設定 | `SnapshotCell` から返す（actor を通さない） |

「複数の転送の列」の途中で停止を受け付けたら、列は次の転送の前に中止する（今の `interrupt_restore` の確認、F-11 と同じ位置）。

### 4.3 `Start` の段

【設計】開始の1要求を、次の段で進める。各段の「待つ入力」と「期限」を明示する。

| 段 | 動作 | 待つ入力 | 期限 | 失敗時 |
|---|---|---|---|---|
| S0 受付確認 | 更新中・手動復旧中・ミキシングの選択・入力元・マイク許可を確かめる。`latest_stop_seq` が自分の `seq` より大きければ `Superseded` | なし（同期） | なし | `Rejected` |
| S1 接続 | 接続がなければ `Spawn`（3.3）。あれば `Suspect` でないことを確かめる | `Spawn` の段 | 段ごとの期限 | `Failed` |
| S2 前提 | 機器 ID・入力元の機能確認、二系統出力の復帰、自分用モニターの復帰、配信ミックスの準備。それぞれ `Rpc` 1段 | 応答 | 10秒/段 | `Failed` |
| S3 ミュート | `SetGlobalMute`（開始前のミュートの確認） | 応答 | 10秒 | `Failed` |
| S4 開く | `Start { attempt_id, … }` を送る | `Event::Started`、`Response::Started`（両方）、または `Response::Error`、`Stopped`、`Eof` | 10秒（互換のため据え置き。5.4） | 5.3 |
| S4' 清掃 | 確定しない成功の後始末として `Stop` を送る | `Response::Success`、`Eof` | 10秒 | 隔離（5.3） |
| S5 検証 | 機器 ID、ルーティング、アプリ入力の一致を確かめる | なし（同期） | なし | 不一致なら S4' へ |
| S6 確定 | 確定点（5.2）。保存（8章）。履歴を1件足す。結果を1回返す | 保存の完了（`PersistDone`） | 5秒 | 保存の失敗は 8.2 |

S0〜S3 の段の境目ごとに、`latest_stop_seq > seq`（停止が後から受け付けられた）を確認する。大きければ、子へ何も開かせずに `Superseded` で完了する。

### 4.4 `Teardown`（接続の終了処理）

意図した終了（再起動、更新のための停止、隔離、アプリの終了）は、次の段で行う。

1. 接続を `Closing{cause_request, intent}` にする。以降、その接続の通知は「履歴だけ」で、今の状態へは作用させない。
2. 待っている要求を、`ConnectionEnded` で完了する（1回だけ）。
3. Job Object を落とし、`child.kill()`（待たない `TerminateProcess`）を呼ぶ。
4. reaper が `wait()` を終えたら、`Reaped` で終了を確定する（7章）。

`child.wait()` を、actor では呼ばない。reaper スレッドが接続の生存中ずっと `wait()` で待ち、終了したら `Reaped` を積む。`try_wait` の呼び出しは不要になる。`kill` の後に `Reaped` が2秒来ないときは、`Unreaped` として記録し、先へ進む（Job Object の kill-on-drop が孫まで終わらせる。`audio.rs:760-765`）。アプリの終了時（`Drop`）だけは、actor の外で、上限2秒の `wait` を行う。

### 4.5 stdin の書き込みの上限

- 書き込みは writer スレッドが行う（F-14 の先例）。actor は `WriteLine{conn, token, json}` を送るだけ。writer への列は有界（8件）。溢れたら、その接続を隔離する。
- writer が `WriteDone{token}` を5秒以内に返さなければ（パイプが満杯 = 子が読んでいない）、接続を隔離する。隔離の手順は `Teardown`（意図 = `quarantine_write_stall`）。
- 書き込みの失敗（`BrokenPipe` など）は、今と同様に、接続を終了する。`audio-error` の通知（`audio.rs:1178`）は互換のため残す。

### 4.6 移す入口の一覧

「actor の上」は、`AudioControl::run(|host| …)` で actor スレッドの上で実行すること。「受付」は `Admission` を通ること。

| 入口 | 今 | 移し先 |
|---|---|---|
| `commands/audio.rs` の全コマンド | `state.lock()`（`run_blocking`） | 受付 → actor。`get_audio_state`、`get_saved_audio_config` は `SnapshotCell` |
| `start_audio`、`restart_audio_engine`、`stop_audio` | 同上。`stop_audio` は `interrupt_restore()` で先に登録（F-11） | 受付（`ManualStart`／`Restart`／`StopAll`）。`interrupt_restore` は `Admission` に統合 |
| `commands/voice_check.rs`、`commands/profiles.rs`、`commands/bundles.rs:2011` | `state.lock()` | `Rpc` または「複数の転送の列」 |
| warmup（`lib.rs:385-392`）、`audio_frontend_bootstrap` | スレッドで `lock` → `warmup()` | 受付（`WarmupStart`。`PersistPolicy::BestEffort`）。frontend の到着で取り消す規則は `frontend_bootstrap` をそのまま移す |
| モード VST のスケジューラ（`mode_vst.rs:526-535`） | 10ms ごとに `lock` → `poll_mode_vst` | actor の `Timer` 入力（10ms）。`weak` 参照は、actor の寿命に置き換える |
| トレイのミュート切替（`lib.rs:350`） | `lock` → `toggle_global_mute` | 受付（`Mute`）。停止・ミュートの意図を `Admission` に登録 |
| ショートカット（`shortcuts.rs:420`） | `lock` → 歌・雑談の切替、音量 | 受付（`Rpc`）。世代の検査は、受付順に置き換える |
| 更新（`updates.rs:161`）、移行（`migration.rs:472`）、一時利用（`temporary_session.rs:280`） | `lock` → `check_can_interrupt`／`prepare_update` | 受付（`StopForMaintenance`）。全体の停止（6.2）として扱う。`finish_update_attempt` も受付 |
| OBS の到達確認（`obs.rs:46`、`:673`） | `lock` → `begin_obs_reach_tone` | 受付（`Rpc`） |
| 配信ミックス（`post_mix`、F-13） | 主 `AudioHost` の中の別 `AudioHost` | 同じ actor の下の第2接続（`role = PostMix`）。reader・writer・reaper を持つ。終了は接続ごとに確定する |
| 配信セット（`live_bundle.rs`、`bundles`） | `lock` を長く持つ。`interrupt_restore` を別スレッドから | 「複数の転送の列」。途中の停止は `latest_stop_seq` で見る |
| アプリの終了（`quit_app`、`Drop`） | `Drop` で `kill`+`wait` | `Shutdown` 入力 → `Teardown` → 上限2秒 |
| 機器のスキャン | `DeviceScanTicket` | 1段の待ち。接続が変われば古いチケットを捨てる |
| フロント（`api/audio.ts`） | 個別の `invoke` | F1a は変えない。F3 以降で `audioSession` 経由 |

## 5. 開始

### 5.1 要求・試行・ストリームの対応

【設計】

```text
RequestId (外の命令 1)
   └─ AttemptId (親が Start を送る 1 回。接続の中で単調増加)   … 1要求につき 0 または 1（親は自分で再試行しない）
        └─ 子の stream_generation (子の内部の試行。フォールバックごとに増える)
             └─ StreamId = "{ConnId}:{stream_generation}"      … 成功した最後の1つだけが、ストリームになる
```

- 親は `Start` に `attempt_id` を付ける（F1b。子が通知と応答に付けて返す）。F1a は付けない。直列の接続で、送った `Start` は常に1つだけなので、段 S4 の間に届く `Started` は、その試行のものとみなせる。
- 子は、機器のフォールバックで内部の試行を何度か行う（F-5）。失敗した内部の試行は、`Stopped` を出さずに次へ進む。成功した最後の内部の試行だけが、`Started` に番号を付ける。親は、`Started` と `Response::Started` の `stream_generation` が一致することを確かめる。
- 結果として、1要求は高々1つの `StreamId` に対応する。`RequestLedger[request_id] = { attempt, stream?, outcome }` で持つ。

### 5.2 確定点

次の条件がすべて、actor の1つの手番の中で成り立つときだけ、`Running` にする。

1. **C1** `Event::Started` を、その接続の S4 の間に受けた。
2. **C2** `Response::Started` を受け、その `stream_generation` が C1 と一致する（旧子で番号がなければ、接続と直列の対応で代用。F1a のみ）。
3. **C3** 機器 ID・ルーティング・アプリ入力の検証に通る（今の `audio.rs:1647-1672`）。
4. **C4** `latest_stop_seq < 自分の seq`（停止が後から受け付けられていない）。取り消し対象に指定されていない。
5. **C5** 接続が `Live`。C1〜C3 より前に、その接続の `Error`・`Stopped`・`Eof` を処理していない。

受信箱は到着順なので、「`Started` の後に届いた `Error`」は、確定の後に処理される。この場合は「確定したストリームの障害」になる（先に届いたものだけが、確定を止める）。C1〜C5 の確認と、`Running` への遷移、履歴の追記、保存の依頼は、同じ手番で行う。間に入力は入らない。

条件が成り立たないとき。

- C4 の失敗：子のストリームは開いている。清掃の `Stop`（S4'）を送る。要求の結果は `Superseded`。
- C3 の失敗：同じく清掃の `Stop`。結果は `Failed`（今と同じ文言。互換の契約）。
- C5 の失敗：結果は `Failed`。ストリームは持たない。

### 5.3 タイムアウトと遅れた成功の後始末

【設計】S4 の期限（10秒）が切れたとき。

1. 要求を `Timeout` で、**1回だけ**完了する（今と同じ文言）。`RequestLedger` に記録する。
2. 試行を `Abandoned{attempt}` にし、接続を `Suspect` にする。
3. 親は、清掃の `Stop` を送る。子の stdin の順序に従い、子は遅れた `Start` を終えた後で `Stop` を処理する（F-4）。応答は、接続ごとの期待の列（FIFO）で受ける。`ReplySlot` の1件を、`ExpectedResponses: VecDeque<Owner>` に置き換える。
4. 遅れた `Response::Started` が来たら、期待の列の先頭（`Abandoned` の持ち主）に当てる。要求には作用せず、履歴に `start_late_success_discarded{attempt, stream}` を1件足す。次の `Response::Success`（清掃の `Stop`）で、接続を `Live` に戻す。
5. 猶予（20秒）の間に応答が来なければ、接続を隔離する。`Teardown`（意図 = `quarantine_start_timeout`、原因の要求 = その `request_id`）。この猶予は、ドライバが機器を開き続ける場合を考えた値（`audio/engine_exit.rs:333-340` のコメントと整合）。
6. 新しい `Start` は、`Suspect` が解けるまで（清掃の `Stop` の成功か、接続の終了の確定）、`held` に置く。

「終了の確認」の定義：清掃の `Stop` の `Response::Success`、または接続の `Ended`（`Reaped` または `Unreaped`）。どちらも観測していなければ、完了とはみなさない。

**残る窓**：タイムアウトの後、子が実際に音を出す時間（遅れた成功から、清掃の `Stop` の完了まで）が生じる。VST を失わずに消すには、この窓は避けられない。子の中で「準備」と「出力の有効化」を分ける案は、判断が要る点 J-4 にまとめる（F1 では行わない）。

### 5.4 期限の値

互換のため、F1a は今の10秒（`audio.rs:1184`）を据え置く。`Start` だけを延ばす変更（例 30秒）は、挙動の変更なので F1b の承認が要る差分として扱う。

## 6. 停止と勝敗の判定点

### 6.1 受付の順序

`Admission` は、葉のロックの中で、次を**この順で**行う。

1. `seq = next_seq++`。
2. 命令の種類に応じて `latest_stop_seq = seq`（全体の停止）、または `manual_epoch += 1`（手動の操作）を書く。
3. 受信箱へ積む。

1〜3 を同じロックの中で行うので、「受信箱の順序 = `seq` の順序」になり、`latest_stop_seq` は、受信箱で自分より後ろにある命令の分まで、先に見える。勝敗の判定点は、**確定の手番（5.2 C4）が `latest_stop_seq` と自分の `seq` を比べること**だけ。

レビュー指摘の2つの場合。

- **(a)** 開始が確定の直前に確認した後、停止が届く：`seq` で停止の方が後。開始は確定し、結果は `Confirmed`。直後に停止が処理され、ストリームは終わる（終了の理由は `user_stop`、原因の要求は停止の要求）。最終の状態は停止中。
- **(b)** 開始が列にあり、停止を受け付けた後に初めて確認する：開始が取り出されたとき、または次の段の境目で `latest_stop_seq > seq` なので、`Superseded`。子へは何も送らない（S0〜S3 の間）。S4 の後なら清掃の `Stop` を行う。

どちらも、最終の状態は「停止」で、判定は `seq` の1つの比較。

### 6.2 全体の停止と対象を指定した取り消し

| 種類 | 受付で書くもの | 効くもの |
|---|---|---|
| `StopAll{reason}`（ホームの停止、トレイ、更新・移行・一時利用のための停止、アプリの終了） | `latest_stop_seq`、`manual_epoch`（利用者の直接の停止のとき） | 自分より前に受け付けた、すべての開始・再開・確認の復元 |
| `CancelTarget{request_id \| session_id}` | 対象の `cancel_mark` | その要求・セッションだけ。`latest_stop_seq` も `manual_epoch` も動かさない |
| `ManualStart`（ホーム・設定・セットアップの確定の開始、再起動） | `manual_epoch` | 再開の権限、古い確認の復元の権利（6.3） |

### 6.3 手動の操作が権限を失効させる

- **再開の権限**（12章）：`RecoveryAuthority.manual_epoch_at_failure` が、実行時の `manual_epoch` と違えば失効。受付の時点で epoch が進むので、列に積まれた `recover` は取り出す前に失効する（レビューの順序「A が障害 → `recover(A,r)` が列に入る → 利用者が停止 → actor が取り出す」）。
- **古い確認の復元の権利**（11章）：確認のセッションは `restore_epoch` を持つ。手動の操作を受け付けると、`manual_epoch != restore_epoch` になり、取り消しは「何も再開しない」（結果 `restore_revoked`）。

### 6.4 停止の実行

`StopAll` を処理する手順（`Stop` の段）。

1. 保留中の `Start`・`recover` のうち、`seq` が小さいものを、`Superseded` で完了する。
2. 主の音声を `Stop`（`Rpc` 1段）。配信ミックスの停止、確認のセッションの片付けは別の段。
3. 子が遅れて応答しない場合は、10秒で `Suspect`。清掃の扱いは 5.3 と同じ。
4. 結果は、各段の結果の合成。主が止まって配信ミックスが失敗したら、部分の成功として結果に載せる。今の `result.and(post)` の挙動は保つ（互換の契約）。
5. 接続が既に終わっていれば（`reader_active` 偽、`child` なし）、新しい子は起動しない。今の `reap_confirmed_stopped_connection`（`audio.rs:1723-1735`）と同じ。

## 7. 終了の確定

### 7.1 接続の単位で1回だけ

```text
ConnectionRecord { id, role, state: Live | Suspect | Closing{intent, cause_request} | Ended{reason, at}, ended_final: bool }
finalize_connection(conn, reason) -> bool   // 2回目以降は false を返し、何もしない
```

終了に気づく入口は4つ（EOF、`Reaped`、書き込みの失敗、`Teardown`）。すべて、`finalize_connection` を通す。`reader_active` の `swap(false)` による絞り込み（F-10）は、`ended_final` に置き換える。

### 7.2 理由と原因の要求

| 理由（`reason`） | 条件 | `cause_request` |
|---|---|---|
| `crashed` | `Closing` ではないのに EOF・`Reaped` | なし。`during_request` に、そのとき待っていた要求を入れる（原因ではなく、立ち会った要求） |
| `restart` | 再起動の命令による | その要求 |
| `maintenance` | 更新・移行・一時利用のための停止 | その要求 |
| `quarantine_start_timeout`、`quarantine_write_stall`、`quarantine_protocol` | 5.3、4.5、番号のない開始など | その開始・書き込みの要求 |
| `spawn_handshake_failed` | 3.3 の引き継ぎが失敗 | その開始の要求 |
| `app_quit` | `Shutdown` | なし |

終了の詳細（今の `ExitPayload` の `cause`: `vst_operation`／`device_open`／`unknown`）は、`crashed` のときの `info` として残す（`audio-engine-exited` の互換）。

停止の意図を、**操作を出したときに記録する**（レビュー N4）。停止、開始による置き換え、再起動、確認への切り替え、放棄した試行の片付けは、`Closing` または `stream_end_intent{cause_request}` として、命令の処理の最初に書く。終了の確定のとき、記録された `cause_request` を付ける。ストリームの終了（`stream_ended`）も同じで、原因の要求 ID を必須にする（自発の障害は `None`）。

### 7.3 履歴と今の状態の分離

`Occurrence::EngineExited{conn, reason, cause_request, info, affects_current}`。`affects_current = (conn == state.current_conn)`。

- 履歴には、`conn` によらず、確定のたびに1件だけ追記する。
- 今の状態（稼働、`Conditions`、VST の一覧の状態、再開の予約、保存の権限）は、`affects_current` が真のときだけ変える。古い接続の終了では、変えない（試験：「古い終了では、今の状態は変わらない。ただし、履歴には終了を1回残す」）。
- `Conditions`（OBS の条件）の更新も、`finalize_connection` の中で、同じ条件を使う。今の `engine_event(epoch, …)`（`conditions.rs:106`）の epoch 照合を、`conn == current` に置き換える。

## 8. 保存の正本

### 8.1 3つの保存先の移し先

| 保存先 | 今 | 設計 |
|---|---|---|
| 次の起動用のファイル `last_audio_config.json` | 成功した `Start` のたびに、親が書く（F-9） | **Rust の親が唯一の書き手**。`PersistPolicy`（8.2）が `BestEffort` または `Required` の開始の確定の手番だけで書く |
| ホームの `persist` | `startHomeAudio` が、開始の後に `handleConfigUpdate` を呼ぶ（`lib/startHomeAudio.ts:33-37`） | 接続の項目（機器・レート・経路・入力元）は、Rust の確定が書いたファイルを正とする。フロントは UI の都合の項目だけを持つ。F3 で、`persist` を確定のスナップショットの反映に置き換える |
| `localStorage['vst_host_audio_config']` | フロントが読み書きする。起動時は、`localStorage` が先、ファイルは空のときだけ（`hooks/useAudioConfig.ts:110-125`） | 当面は両方書く。F3 の後、接続の項目は、スナップショットの `saved` を正とし、`localStorage` は UI 項目の保存に絞る。移行の間は、`saved_revision` が違えばファイルを優先する |

### 8.2 保存の方針と失敗

| 方針 | 使う場面 | 書き込みに失敗したとき |
|---|---|---|
| `None` | 確認の開始、取り消しの戻し、自動の再開 | 書かない |
| `BestEffort` | 今の開始・再起動・warmup（F1a は今の挙動のまま） | ログだけ。結果は `Confirmed`（F1b で `persist: failed` の注記を付ける。F1a は注記なし） |
| `Required` | セットアップの確定、配信セットの適用（F1b 以降） | 開始は成功のまま、結果を `ConfirmedNotSaved` にする。確認のセッションは残す（もう一度保存できる） |

### 8.3 確定点と競合

保存は、確定の手番（5.2）の最後の確認（C1〜C5）の**後**に依頼する。保存の依頼は、persist スレッドへ。`PersistDone` までは、要求の結果を返さない（期限5秒）。

- 最後の確認の前に、親が受け付けた停止・障害があれば、保存しない（C4・C5）。
- 確認の後に受け付けた停止は、受付順で開始の後。ストリームは確定し、ファイルは書かれ、その後に停止される。
- 確認の後、`PersistDone` までの間に、同じ接続の `Error` が届いたら、障害は確定したストリームのものとして処理する。ファイルの内容は、確認した時点の設定のまま。
- 書き込みは、今の `write_json`（一時ファイル→`rename`）を使う。`rename` の失敗では、元のファイルは変わらない。1バイトも変わらないことを試験する。

### 8.4 再送と、応答が消えたとき

- フロントは `clientRequestId`（文字列）を付ける。親は、最近の完了した要求（64件）を、`clientRequestId → outcome` で持つ。
- 同じ `clientRequestId` の再送は、再実行しない。完了していれば同じ結果、実行中であれば同じ結果に合流する（oneshot を複数へ配る）。
- 応答が消えた（WebView の再読み込みなど）後は、`get_request_outcome(clientRequestId)` で照会する。台帳に無ければ `unknown`。このとき、フロントは `get_audio_session` の状態から判断する。
- アプリの再起動をまたいだ冪等性は持たない。

## 9. 購読の復旧

### 9.1 版と `seq` を別に管理する

- `Snapshot.revision`：状態が変わるたびに進む（履歴を伴わない変化も数える。例：メーターの到達の更新）。
- `Occurrence.occ_seq`：履歴の通し番号。
- フロントは、`appliedRevision` と `deliveredSeq` を別に持つ。スナップショットは、`revision` が新しいときだけ置き換える。履歴は、`occ_seq > deliveredSeq` のものを順に、1回ずつ配る。

### 9.2 通知と回復

- 新しい通知 `audio-session { snapshot, occurrences }` を、Emitter が出す（F1b で追加。旧の通知は残す）。
- 最後の通知が落ちたときの回復：
  1. 再フォーカス・表示の復帰のたびに `get_audio_session(sinceSeq, clientId)` を呼ぶ。
  2. 表示中は、5秒ごとに同じ呼び出しで照合する（今の2秒ごとの `getAudioState` + `getAudioStreamState`、`hooks/useAudioConfig.ts:255-290` を置き換える。F3）。
  3. 各コマンドの結果に `sessionRevision` を載せる。`appliedRevision` より大きければ、すぐ取り直す。

### 9.3 上限と受け取りの確認

- 履歴の通常の枠：直近256件。
- **重要な履歴**（`Critical`：エンジンの終了、開始の結果、障害での終了、確認の結果）は、別の枠で、受け取りの確認まで持つ。上限64件。超えたら古いものから、数だけを `lost_critical` に集約する。
- 確認：`get_audio_session(sinceSeq, clientId)` の `sinceSeq` を、そのクライアントの確認済み位置とする。複数のウィンドウは `clientId` ごとに持つ。最終の確認から60秒呼び出しのないクライアントは、確認の対象から外す。
- 1回だけ知らせる通知（クラッシュの画面など）は、`deliveredSeq` がフロントのメモリにしかないと、再読み込みで二重になる。そこで、確認の位置を親が持ち、再読み込みの後は `deliveredSeq` が親から返る。複数のウィンドウは、`clientId` ごとに別に1回ずつ配る。「ウィンドウをまたいで1回だけ」は行わない（J-3）。
- 列からはみ出したら、`resync: true` と、スナップショットに含まれる要約（`last_engine_exit`、`lost_critical`）を返す。

## 10. メーター

### 10.1 世代とサンプルの順序

- reader は `LevelMeter` を、受信箱へ積まず、`MeterCell` に畳む（F-8 の約60Hz を、actor の列へ流さない）。`MeterCell` は、`{ stream_label, meter_seq, latest, received_zero, nonzero_run_count, run_started_at, arrived }`。`meter_seq` は reader が1行ごとに進める。
- Emitter が約60Hz で `MeterCell` を読み、`audio-level`（旧の形のまま。互換の契約）を出す。F1b 以降、任意の項目 `seq` を足す。
- フロントは、現在のストリームと違うラベルのサンプル、または `seq` が逆行するサンプルを捨てる。

### 10.2 確定の前に届いたサンプル

子は、同じ試行では `Started` を最初のレベルより先に送る（`ipc.rs:924` のコメント）。reader は `Started` を見るまで、`MeterCell` に畳まず、数だけ数えて捨てる。`Started` の後のサンプルは、確定前でも `MeterCell` に畳む。確定したら、スナップショットの `meter` にそのまま載る。確定に失敗したら、`MeterCell` を破棄する。

### 10.3 ゼロとまだ受けていないことの区別

スナップショットの `meter.state`：`Waiting`（まだ1件も受けていない）、`Silent`（ゼロを受けた。子は連続するゼロを省くので、ゼロ後に通知がなくても `Silent` を保つ）、`Live`、`Stale`（`Live` の後、一定時間の無通知）。「ゼロが来た」と「何も来ていない」を、`received_zero` で区別する。遅れて届いた古いサンプル（別のラベル、または `seq` の逆行）は、`MeterCell` を上書きしない。

### 10.4 #806 の「到達」の判定の場所

**Rust の `MeterCell`（reader が1行ずつ畳む）で行う。** 理由：判定は、間引き前の全サンプルの順序に依存し、フロントでは60Hz の間引きの後の観測になる。また、確認の保存の命令（`commit_trial`）が、その場で `arrived` を照合できる。

- 規則（今のフロントと同じ値）：ゼロでない入力レベルが、ゼロを挟まずに250ms 以上、5件以上続いたら、そのストリームについて `arrived = true`（ラッチ）。ゼロを受けたら連続は途切れる。
- `arrived` は、ストリームごと。次のストリームへ持ち越さない。
- フロントは、スナップショットの `meter.arrived` を表示するだけにする。

## 11. 確認のセッション（声と音楽）

### 11.1 基準は「最初の `begin_trial` の時点」

**決定：** 戻す対象は、「最初の `begin_trial` が、動いている音声を置き換える時点」の状態とする。セットアップを開いた時点とはしない。

理由。

1. 利用者が同意して止めるのは、その時点で見ている音声。開いた時点の音声を戻すと、その後に利用者が止めた音声を勝手に開き直しうる。
2. 同意は、音声の番号に結び付く（S4）。戻す対象も、同じ時点の記録にそろえると、同意と復元が食い違わない。
3. 親が観測して順序を保証できるのは、受付以降の状態だけ。開いた時点の状態を保証するには、「開く」を命令にして状態を取らなければならず、範囲が広がる。
4. 開いたあとに B が始まり、B を止めることに同意したら、戻す対象は B（同意した音声）。B を始めた手動の操作は受け付けられているので、そのままでは復元の権利が失効する（6.3）。**同意つきの `begin_trial` が、その時点の状態で新しい復元点を取り直す**。復元点の取り直しは、同意の対象の音声ごとに1回。

画面の初期の取得（`initialStateRef`）は、表示のためだけに残す。J-1 にも書く。

### 11.2 状態

```text
Trial {
  session_id, purpose: Voice | Music,
  restore_point { seq, restore_epoch(=manual_epoch), original: Option<{config, resolved_source, owner, stream}>,
                  previous_active_config, previous_input_source,
                  app_identity: Option<{app_key, raw_endpoint_id, purpose}> },   // PID ではなく識別子
  handles: { primary, post_mix },          // それぞれ Idle | Running(stream) | Failed
  progress: RestoreProgress,               // 11.4
  processing: ProcessingLedger,            // 11.5
  stream: Option<StreamId>, arrived: bool
}
```

### 11.3 命令

- `begin_trial { session_id?, purpose, connection, consent? }`
  - `session_id` なし = 新しいセッション。復元点を取る。あり = 現在のセッションと一致しなければ `rejected_session`（再試行、声→音楽の切り替えは `session_id` が必須）。
  - 別の持ち主の音声が動いていて、`consent.stream` が一致しなければ `needs_consent{stream}`。何も変えない。
  - 一致すれば、その音声を止め、`PersistPolicy::None` で確認の音声を開始する（owner = Trial）。
  - 開始前に、子の能力（`StreamAttemptCapability`）を確かめる。ない、または開始の応答に番号がなければ、その接続を隔離する（11.7）。
- `commit_trial { session_id, stream, processing }`：11.5。
- `cancel_trial { session_id }`：11.4。

### 11.4 部分的な停止と取り消し

取り消しは、`RestoreProgress` の各ステップを順に、冪等に行う。「今 Idle だから戻す」という分岐は使わない。

```text
RestoreProgress { primary_stopped, post_mix_stopped, input_source_reset, config_restored, reopen: NotNeeded|Pending|Done|Failed(err) }
```

1. 停止に手を付ける**前**に、`restore_point` を保存する（11.2。済み）。
2. `manual_epoch != restore_epoch` なら、`restore_revoked`。何も再開しない（自分の確認の音声がまだ動いていて、番号が一致するときだけ、それを止める）。
3. 各ハンドルについて、残っているか・持ち主・停止の結果を `handles` に持つ。主が止まり、配信ミックスの停止が失敗したら、`primary_stopped = true`、`post_mix_stopped = false` で結果 `partial{targets}`。もう一度取り消すと、続きから行う。
4. 元が停止中だったら、`active_config` と入力元を戻し、子に `ResetInputSource` を送る。**その応答を受けたことを、復元の完了**とする。
5. 元が動いていたら、識別子で候補を引き直す（11.6）。`PersistPolicy::None` で開き直す。
6. 結果：`restored_running`、`restored_stopped`、`kept_other`（別の持ち主の音声が動いている）、`restore_revoked`、`nothing_to_restore`、`partial{targets}`、`failed{targets}`。状態を取得できないときは、何も変えず `failed`（セッションを残す）。
7. 取り消しの後、ホームの開始と声の確認の開始が通ることを、試験で確かめる（合格の条件の表）。

### 11.5 処理設定

`ProcessingLedger` の1項目：`{ kind: NoiseControl | BuiltinEffects | Reverb, before, target, apply_revision, conn, stream, status }`。`status = Pending | Applied | Confirmed | RolledBack | RollbackFailed | Diverged`。

保存の命令の1つの手番の中の順序。

1. 照合：自分の確認の音声（番号）、障害なし、`arrived = true`。
2. 処理設定を適用する。反映の完了を、上限付きで待つ。
3. **反映が期限に間に合わなくても、失敗と決めない。** 子の状態を取り直し、`observed` を得る。
4. 再照合。
5. 保存（`Required`）。確定点は8.3。
6. owner を `User` にする。

途中で失敗したら、巻き戻す。巻き戻しは「Undo の履歴」に頼らない（履歴は `StreamChanged` などで失効する。`audio_engine/core/commands.rs:174-190` 付近）。

- `observed == before`：何もしない。
- `observed == target`：条件付きで `before` を適用し直す（期待のリビジョンを `observed` のリビジョンにする）。適用後に、取り直して反映を確かめる。
- それ以外（並行の編集）：触らず、`Diverged` として結果に載せる。
- 遅れて適用された場合（OFF を送る→期限切れ→巻き戻す→遅れて OFF が反映）：巻き戻しの前に、`apply_revision` の決着を待つ。決着後に取り直して判断する。決着しなければ `RollbackFailed{pending}` を返し、セッションを残す。
- 項目は独立。内蔵処理の巻き戻しが失敗しても、ノイズ低減の復元は続ける。

### 11.6 アプリの入力の特定し直し

アプリ入力は、PID ではなく `app_key`（64桁）・`raw_endpoint_id`・用途で記録する。復元のとき、候補の一覧を取り直し、この3つが一致する候補がちょうど1つのときだけ採用する。0 件・複数は `restore_failed{app_not_found | ambiguous}`。新しい PID の対象で開始し、`process_inputs.selected` に登録する（`audio/process_inputs.rs:133`）。その後、ホームの開始まで通ることを試験する。

### 11.7 番号のない開始

確認の開始では、番号のない `Response::Started` を成功とみなさない。開始の前に能力を確かめる。応答の番号が欠けた、または不一致なら、その接続を隔離し（`quarantine_protocol`）、終了を確かめるまで、確認のセッションを `failed` にする。互換のための番号のない応答は、通常の開始（ホーム）にだけ許す。

### 11.8 Auralyn を再起動したとき

確認のセッションは、メモリだけに持つ。ディスクには書かない。再起動すると、確認は消え、**最後に確定した設定**（`last_audio_config.json`）で起動する。確認のあいだは書かないので、中断した確認の跡は残らない。子も一緒に終わるので、処理設定の変更は、子の再起動で消える。中断した復元を引き継ぐ案は、利用者の体験に影響するので、J-2 に置く。

## 12. 自動の再開

### 12.1 権限

```text
RecoveryAuthority { id, failed_stream, conn, manual_epoch_at_failure, stop_floor = latest_stop_seq at failure, attempts: 0..3 }
```

- 親が、現在の確定したストリームの障害（`failed_stream`）を確定したときに作る。owner が `Trial` のときは作らない（確認の障害は、確認の結果として扱う）。
- `recover { authority_id }` を受けたときの確認：`manual_epoch == manual_epoch_at_failure`、`latest_stop_seq == stop_floor`、現在のストリームが障害の同じもの（または停止）、接続が生存。満たさなければ `rejected_precondition`。
- 受付の時点で手動の操作が `manual_epoch` を進めるので、列にある `recover` は取り出す前に失効する。

### 12.2 失敗しても続ける

- 権限は `failed_stream` と `manual_epoch` に結び付く。`revision` には結び付けない。1回目の失敗で状態の版が進んでも、2回目は拒まれない（レビュー E2）。
- 失敗した試みは `attempts += 1` で、権限は残す。3回で終わり（今の `attempt < 3` と同じ。`hooks/useAudioRecovery.ts:75`）。成功、または手動の操作で、権限は消える。
- 再開は `PersistPolicy::None`。再開に使う設定は、親が持つ最後に確定した `active_config`。フロントの `localStorage` の読み戻しは不要になる。保護中（armed）は今と同様に、経路を指定せずに再開する。

### 12.3 確認のセッションとの関係

- 確認の音声が動いているあいだは、権限を作らない。
- 確認の前に、**旧フロントの自動の再開を、親で制限する**（フェーズ R1）。旧の再開は `start_audio` を直接呼ぶ。`start_audio` に任意の項目 `origin: "recovery"` を足し、親は `origin = recovery` の開始に、権限と同じ確認を行う。確認のセッションの間は拒否する。`origin` を付けない開始は、手動の開始として扱う（従来どおり）。
- 手動の開始・停止が受け付けられたら、権限は失効する。

## 13. フェーズの計画

レビューの見直し案に沿う。1つの PR は1フェーズ。各フェーズは `origin/main` から作る。

| フェーズ | 範囲 | 試験 | 既存の動作への影響 |
|---|---|---|---|
| **F0**（この PR） | 3文書。コードは変えない | `npm run verify -- --changed` | なし |
| **F1a** 所有と輸送 | actor・受信箱・reader/writer/reaper・`AudioControl`・`Admission`。`AudioHost` を actor の下へ。入口（4.6）の移行。`ReplySlot` を期待の列へ。`SnapshotCell`。旧の通知・応答は、今の順序・形で出す（Emitter を通すが、reader と同じ順序） | 互換の契約の試験（`9567061a` の挙動を固定）、模擬の sidecar（14章）での段階の試験、既存の Rust 試験 | **変えない**。安全のための変更は含めない。互換試験が通ることが条件 |
| **F1b** 新しい契約 | `RequestId`・`AttemptId`・確定点（5.2）、タイムアウトの後始末（5.3）、終了の確定（7章）、`audio-session`・`get_audio_session`、履歴、`clientRequestId`、`PersistPolicy`、`MeterCell`、子の `attempt_id` の echo と能力の確認 | 合格の条件の表の F1b の行 | 安全のための変更を**個別に承認**して入れる：タイムアウト後の隔離、保存の失敗の注記、開始の `Superseded`、`Start` の期限の値（任意）。互換の契約の「F1b で変える」の表が、承認の単位 |
| **R1** 自動の再開の制限 | 12.1〜12.3 の `RecoveryAuthority`、`origin` | 再開の順序の行 | 旧の再開が、手動の操作と競合したとき、拒否される。通常の再開は同じに動く |
| **F2** 確認のセッション（声と音楽） | 11章。セットアップを移す。#806 の完成。到達の判定を Rust へ | 確認の順序の行、フロントの試験、ブラウザ試験 | セットアップだけが変わる |
| **F3** 購読の段階的な移行 | `src/lib/audioSession.ts`・`src/api/audioSession.ts`。購読側を1機能ずつ移す（稼働表示、クラッシュ画面、VST の一覧、メーター、準備の画面、接続の設定、ボイスチェック、OBS、セットアップ）。購読の Lint 規則 | 購読の行、`--feature` ごと | 内部のみ。旧の通知は残す |
| **F4** 旧の通知の廃止 | 最後の旧の購読側を移した後に、旧6通知と、フロントの重複した状態の組み立てを廃止 | 全 Vitest、ブラウザ試験 | 内部のみ |

F2 を F3 より先に入れる場合、セットアップの中にも、9章の購読の規則（版と `seq`、回復）が要る。F2 に最小の `audioSession` の購読を含める（レビューの指摘）。

F1a が大きすぎる場合は、`Admission`（受付順）と `AudioControl`（入口の一本化）だけを先に入れる小さな PR（F1a-0）に分ける（J-5）。

## 14. 試験の基盤の計画

実装はしない。形だけを決める。

### 14.1 制御できる模擬の sidecar

`audio_engine` の代わりに、試験の中で動く `ScriptedEngine`。実バイナリではなく、読み書きの対（パイプの代わり）を、接続の部分に差し込める形にする（`Transport` のトレイト）。実プロセスの境界は、別途の実 sidecar 試験（`TESTING.md` の「実sidecarのプロセス境界と実機試験」）で行う。

```text
ScriptedEngine::new()
  .on(Start{..})   .then(emit(Started{g}), sleep(ms), respond(Started{g,..}))
  .on(Start{..})   .then(emit(Started{g}), die())                          // 応答の前の EOF
  .on(Stop)        .then(refuse(Error("…")))                               // 停止の拒否
  .on(Start{..})   .then(silence())                                        // 無応答（期限）
  .on(Start{..})   .then(late(30s, respond(Started{g})))                   // 遅れた成功
  .on(Start{..})   .then(fallback(attempts=3, succeed_at=3))               // 機器のフォールバック
  .inject(old_reader_line(conn=1, Event::Error(..)))                       // 古い reader の行
  .burst(LevelMeter × 10_000, at=ms)                                       // メーターの集中
  .race(Stop @ t1, Start @ t2, Eof @ t3)                                   // 更新・終了との競合
```

- 時間は、仮想の時計（`Clock` のトレイト）で進める。`Deadline` を、実時間待ちなしで出す。
- 入力の順序は、`ScriptedEngine` が明示の列で決める。受信箱へ積む順序を試験が決め、結果の列（履歴・スナップショット・保存のファイル・子へ送った行）を比べる。
- 保存のファイルは、一時ディレクトリで、前後のバイト列を比べる（「1バイトも変わらない」）。
- `persist` の失敗（`rename` の失敗）、`writer` の詰まり、`reaper` の遅れも、同じ形で注入する。

### 14.2 RT の試験

エラーのコールバック（`audio_engine/core/startup.rs:632-640`、`:2086-2093`）は、今 `serde_json`・`println!` を使う（F-7）。設計では、コールバックは atomic の印と番号を立てるだけにする（P7）。既存の無割当の試験に、エラーのコールバックの経路を足す（F1b で子を変えるときに行う）。この変更は、子の側の差分なので、F1b の承認が要る差分に含める。

### 14.3 フロントの試験

- `audioSession` の正本に、Tauri のイベントの順序を入れ替えて注入する。購読の登録の失敗、再登録、取得の失敗、外した後に遅れて届いた応答を入れる。
- 既存の `fakeEngine`（`codex/music-setup-806-v2` の `SetupWizard/__tests__/fakeEngine.ts`）は、参考にする。

## 15. レビューの指摘への対応表

ID は、レビュー文書の見出しの順に付けた。

- **A**：actor（P1）の項目。A1 待ちの方式、A2 確定の条件、A3 待ちの上限、A4 メーター、A5 移す対象、A6 読み取り、A7 機器スキャン、A8 子の起動・再起動
- **N**：#825 の未決の9項目（N1〜N9）
- **E**：epoch・revision・同意・owner（E1 手動と再開の順序、E2 2回目の拒否、E3 古い同意と復元）
- **T**：#806 の順序（T1 方向は妥当、T2 開始の応答より先の B・A の終了、T3 同意と復元の基準、T4 一部の停止、T5 処理設定、T6 アプリの再起動、T7 Auralyn の再起動、T8 番号のない開始）
- **C**：F1 の互換。**M**：フェーズの見直し。**X**：足すべきもの（X1 タイムアウト後の出力、X2 保存の確定点、X3 購読の復旧、X4 試験の基盤、X5 文書の差）。**G**：5つの期待値

| ID | 指摘 | 解いた場所 | 解き方の要約 |
|---|---|---|---|
| A1 | actor が待つ間、reader の入力を読めない | 4.1、4.3、4.5 | 段の状態機械とポンプ。待つ間も `Wire`・`Eof`・`Deadline` を処理し、`Command` は保留 |
| A2 | 確定の条件（`Started` と `Response::Started`） | 5.2 | C1〜C5 の両方を要件にし、1つの手番で確定 |
| A3 | stdin・`child.wait` の上限 | 4.4、4.5 | writer・reaper を別スレッドにして、5秒・2秒の期限と隔離 |
| A4 | メーターが応答・終了の経路を塞ぐ | 3.1、10.1 | reader が `MeterCell` に畳み、受信箱へ積まない |
| A5 | 移す対象（warmup、スケジューラ、トレイ、OBS、更新、配信セット、post-mix） | 4.6 | 入口の一覧表（今・移し先） |
| A6 | 読み取りは不変のスナップショット | 3.2 | `SnapshotCell` |
| A7 | 機器のスキャンはチケットで待つ | 3.3 | 1段の待ち。接続が変われば捨てる |
| A8 | 子の起動・再起動 | 3.3、4.4 | `Spawn`・`Teardown` の段 |
| N1 | 開始の結果を1回だけ確定。要求・試行・ストリームの対応 | 5.1、5.2、5.3 | `RequestLedger`、`Abandoned`、期待の列、結果は1回だけ取り出す |
| N2 | 停止の意図を待つ前に登録 | 6.1 | `Admission` が受付順で `latest_stop_seq` を書き、確定が1回比べる |
| N3 | 古い終了：履歴は1回、今の状態には作用させない | 7.1、7.3 | `finalize_connection`、`affects_current` |
| N4 | 操作による終了の原因の `requestId` | 7.2 | 操作の最初に意図を記録し、終了に付ける |
| N5 | 保存の正本 | 8章 | 親が唯一の書き手。`PersistPolicy`。失敗の扱い |
| N6 | 上限を超えたとき、最後の通知が落ちたとき | 9.2、9.3 | 重要な履歴の別枠、受け取りの確認、再フォーカス・定期の照合 |
| N7 | メーターの初回の値 | 10章 | 世代とサンプルの順序、`Waiting`/`Silent`、到達を Rust で判定 |
| N8 | ロックの順序（循環待ち） | 3.1 | 葉のロック3つ。actor は待つ形でロックを取らない |
| N9 | 古いフロントとの互換 | 互換の契約、13章 | F1a で固定。安全のための変更は F1b で個別に承認 |
| E1 | 手動の操作と自動の再開の順序 | 6.3、12.1 | 受付で `manual_epoch` を進め、権限を失効 |
| E2 | 1回目の失敗で2回目が拒まれる | 12.2 | 権限は障害の世代と `manual_epoch` に結び付ける。`revision` には結び付けない |
| E3 | 古い同意・古い復元 | 6.3、11.1、11.3、12.3 | `restore_epoch`、`session_id` 必須、同意は番号に結び付ける。再開の前のガードは R1 |
| T1 | 番号の照合、保存しない開始、バイト比較 | 8.2、11.3、14.1 | `PersistPolicy::None`、バイトの比較の試験 |
| T2 | 開始の応答より先の B・A の終了 | 5.1、9.1 | 結果は操作の結果、表示はスナップショットから |
| T3 | 開いた時点か、最初の `begin_trial` か | 11.1 | 最初の `begin_trial` と決める。理由を書く（J-1） |
| T4 | 一部の停止 | 11.4 | 先に復元点を保存し、ハンドルごとの進み具合で冪等に進める |
| T5 | 処理設定の反映待ち・Undo の失効 | 11.5 | 台帳、取り直し、条件付きで旧値の再適用、`Diverged` |
| T6 | アプリを起動し直す | 11.6 | 識別子で特定。新しい PID を登録 |
| T7 | Auralyn の再起動 | 11.8 | 最後に確定した設定で起動（J-2） |
| T8 | 番号のない開始 | 11.7 | 能力の確認、隔離、確認では使わない |
| C | F1 の互換 | 互換の契約、13章 | 旧の通知の段階と新しい確定の段階を分け、差分を F1b で承認 |
| M | フェーズの見直し | 13章 | F0→F1a→F1b→R1→F2→F3→F4 |
| X1 | タイムアウト後の実際の出力 | 5.3 | 隔離と終了の確認。窓は J-4 |
| X2 | 保存の確定点 | 8.3 | 最後の確認の手番の中で依頼。確認の前に見た停止・障害なら拒否 |
| X3 | 購読の復旧 | 9章 | 版と `seq` を別に。再フォーカス・定期の照合、確認 |
| X4 | 試験の基盤 | 14章 | `ScriptedEngine` |
| X5 | 文書の差 | 16章（J-6） | #827 などは別の課題。この設計では扱わない |
| G | 5つの期待値 | 合格の条件の表 | 全行に書いた |

## 16. 判断が要る点

利用者の体験に関わるものは、推奨と理由を書く。決めるのは利用者。

- **J-1：確認の復元の基準。** 推奨は「最初の `begin_trial` の時点」。理由は 11.1。「開いた時点」を選ぶなら、セットアップを開く命令（`open_trial`）が要り、開いた後に利用者が止めた音声を、取り消しで開き直す可能性が残る。
- **J-2：Auralyn を再起動したときの確認。** 推奨は、確認を消して最後に確定した設定で起動すること。理由は、確認のあいだは何も保存しないので、中断した跡を残す根拠がなく、利用者の想定（「やめたら開いたときに戻る」）にも合うから。
- **J-3：1回だけ知らせる通知の範囲。** 推奨は、ウィンドウごとに1回（`clientId` ごと）。理由は、ウィンドウをまたぐと、片方が閉じたときの受け取りの扱いが決まらないから。複数のウィンドウで `audio-*` を購読する画面が今あるかは、確かめていない。
- **J-4：タイムアウト後の出力の窓。** 推奨は、F1 では何もしない（子を変えない）。5.3 の隔離が最終の安全網。窓を無くすには、子の中で「準備」と「出力の有効化」を分ける必要があり、VST の遅延や機器の挙動に影響しうるので、別の課題にする。`Start` の期限（10秒）を延ばすかも、利用者の体験（失敗の表示の遅れ）に関わる。
- **J-5：F1a の分割。** 推奨は、F1a が大きければ `Admission` だけを先に入れ、競合の試験（停止が勝つ）を固定すること。
- **J-6：文書の差。** `docs/SPECIFICATION.md` の子のメーターの記述（#827）は、この F0 では直さない。F1b の子の変更と同時に直す。確認の文書の「どの場合も書かない」と、現行の実装との差も同じ。

## 17. 確かめていないこと

- 実機・実音声・長時間運転での動作。
- `emit` の呼び出しの順序が、WebView での到着順に一致するか（コードの順序だけを確かめた）。互換の試験で実測する。
- 処理設定（ノイズ低減・内蔵エフェクト）が、適用時に別のファイルへ保存されるか。確認の保存の範囲を決めるために、F2 の前に確かめる。
- Windows の Job Object の kill-on-drop が、孫のプロセスまで確実に終わらせるか（コードは割り当てている）。
- 複数のウィンドウ（メイン以外で `audio-*` を購読するもの）の有無。

# 音声セッションの正本を Rust の親に置く設計（第3版・F0）

状態：設計のみ。コードは変えていない。第1版への独立レビュー（GPT-6.2 Sol、BLOCK）と、第2版（`8b87f2e2`）への第2回のレビュー（BLOCK）の P1・P2・P3 を解く。第3版（`21968a8b`）への第3回のレビューは「F1a-0 は着手してよい、全体の承認は保留」で、A 節（F1a-0 の前）をこの版で直し、B 節（F1a-1 の前）・C 節（F1b の前）は、18章の「段階の前に解く項目」に ID つきで記録した。第2回の指摘は、15章の表で ID（Q-…）を付けて対応を示す。
関連：#825、#806、#827。比較の基準は `origin/main`（`9567061a`）。
姉妹文書：[旧 API の互換の契約](audio-session-compat-contract.md)、[合格の条件の表](audio-session-acceptance.md)。

この文書では、事実と設計を分けて書く。

- **【事実】**：`9567061a` のコードで確かめたこと。位置を `ファイル:行` で示す。実機では確かめていない。
- **【設計】**：これから作ること。コードに現れるまで、動作の証拠にしない。

## 0. 用語

| 用語 | 意味 |
|---|---|
| 接続（`ConnId`） | 子プロセス（sidecar）1つと、その stdin・stdout の組。**値は、actor が採る全役割（主・配信ミックス）で一意の通番**（役割ごとの `engine_generation` は同じ値になりうるので、照合には使わない）。ストリームのラベル `"{接続}:{子の番号}"` の接続の部分（今の `engine_generation`、`audio.rs:773`）は、`label_gen` として別に持つ。 |
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
| F-1 | 音声の状態は `Arc<Mutex<AudioHost>>` が持つ。`get_audio_state`・`get_saved_audio_config` も、このロックを取ってから読む（`commands/audio.rs:270-295`）。Tauri のコマンド、トレイ、ショートカット、更新、移行、OBS、warmup、10ms 周期のスケジューラが、同じロックで入る。 | `audio.rs:3041`、`lib.rs:309-312`、`lib.rs:350`、`lib.rs:382-392`、`audio/mode_vst.rs:526-535`、`shortcuts.rs:420`、`updates.rs:161`、`migration.rs:472`、`temporary_session.rs:280`、`obs.rs:46` |
| F-2 | 子との IPC は、要求 ID のない直列の1本。応答待ちは `ReplySlot`（1件）で、待ちは `recv_timeout(10秒)`。タイムアウトした後は、遅い応答を受けるまで次の要求を拒む。 | `audio/replies.rs:1-40`、`audio.rs:1161-1188` |
| F-3 | 子の stdout を読むスレッドが、通知を `emit` で直接出す。`emitter` の Mutex を持ったまま `emit` する。応答は `pending_reply_tx.deliver` で待ち手へ渡す。 | `audio.rs:788-1057` |
| F-4 | 子は stdin を専用スレッドで読み、制御ループへ積む。`Start` は制御ループを塞ぐので、後ろに積まれた `Stop` は `Start` が返るまで動かない。stdin の EOF は `Shutdown` になる。 | `audio_engine/core.rs:602-630` |
| F-5 | `Start` の中で、子は機器のフォールバックを何度か試す。試行ごとに `begin_stream_generation` で子の番号を振る。成功時は先に `EngineEvent::Started`、その後に `Response::Started`（機器 ID とルーティング入り）を送る。失敗時は `Stopped` イベント、その後に `Response::Error`。**ただし、`Start` の事前の検証（`initial_controls` の検証など）による `Error` には `Stopped` が付かない。** | `audio_engine/core/startup.rs:361-373`、`:414`、`:2259-2265`、`audio_engine/core/commands.rs:547-625`、`audio_engine/core.rs:1323-1334` |
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

原則 P1〜P7 は第1版から引き継ぐ。意味は次のとおり（第2回のレビュー P3）。

- **P1 唯一の正本：** 音声のセッションの状態は、Rust の親の `AudioSessionController` だけが持つ。
- **P2 一連の操作は1つの命令：** 開始・停止・確認・保存・取り消し・自動の再開は、controller の1つの命令。命令は直列に実行し、判定から実行までのあいだに他の命令は入らない（第2版では「段の境目ごとに権限を照合し直す」ことで実現する。6.4）。
- **P3 前提条件が違えば何もしない：** 命令は前提条件（期待する版・番号・セッション・同意）を持てる。合わなければ何も変えず `rejected_precondition` を返す。
- **P4 持ち主のある音声：** 動いている音声は `owner`（`User`／`Recovery`／`Trial`／`Bootstrap`）を持つ。持ち主でない命令が止めるには、利用者の同意か直接の操作が要る。
- **P5 保存は利用者が確定したときだけ：** ホームの開始、セットアップの確定、配信セットの適用。確認の開始・取り消しの戻し・自動の再開は書かない。
- **P6 フロントは写すだけ：** 版が新しいときだけ状態を置き換え、履歴は順に1回ずつ配る。手順を組まない。
- **P7 音声のコールバックは atomic だけ：** 新しく足す処理は、固定サイズの atomic を立てるだけ。文字列・JSON・I/O は制御の側で行う。

第2版で次を足す。

- **P8：勝敗は受付順だけで決める。** 複数のフラグや epoch を、別々に読み比べない。
- **P9：actor は待たない。** 子の応答を待つあいだも、入力の受付・EOF・期限・停止の受付は止めない。
- **P10：結果は1回だけ返す。** 同じ要求に2回以上の結果を返さない。
- **P11：終了は接続ごとに1回だけ確定する。** 履歴への記録と、今の状態への作用は別に扱う。
- **P12：プロセスの終了を確かめるまで、次の子を作らない。** 通信の切断と、プロセスの終了は別の状態として扱う（4.4）。
- **P13：権限は、取り消せない操作の直前と確定のときに、受付の境界で照合し直す。** 受け付けたときの権限を、各段が持つ（6.4）。

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

actor の受信箱は、**制御用と通常用の2本**（下の規則）で、次の入力だけを受け取る。入力は、すべて `(role, conn)` で識別する（`ConnId` は全役割で一意）。

```text
Input =
    Command   { seq, ticket, kind, reply: oneshot }
  | Wire      { conn, line: Response | Event }      // reader から（到着順 = 子の出力順）
  | Eof       { conn }                              // reader から
  | Reaped    { conn, status }                      // reaper から
  | WriteDone { conn, stage_token, result }         // writer から（段のトークンでも照合）
  | ReaderDone{ conn }                              // reader から（EOF を積んだ後）。2秒の打ち切りも、この型の入力として積む
  | ReaderAbandoned{ conn }                         // 打ち切り。以降、その reader の入力は無効（reader_epoch で捨てる）
  | PersistDone { token, result }                   // persist から
  | Deadline  { token }                             // timer から
  | MeterReady{ conn }                              // reader から（まとめて1件）
  | Shutdown
```

ロックの規則（レビュー N8、A1 の「ロックの順序」の解）。

- actor は、他のスレッドが持つロックを、待つ形では取らない。
- 葉のロックは3つだけ。`Admission`、`SnapshotCell`（`RwLock<Arc<Snapshot>>`）、`MeterCell`（`Mutex`）。いずれも、持っているあいだに別のロックも I/O も `emit` も行わない。
- reader は actor のロックを取らない。`emitter` の Mutex は廃止し、`emit` は Emitter スレッドだけが行う（F-3 の解消）。
- 受信箱は、**制御用**（`Wire`・`Eof`・`Reaped`・`WriteDone`・`PersistDone`・`Deadline`・`Shutdown`・停止系の `Command`）と、**通常用**（その他の `Command`）の2本に分ける。actor は制御用を先に読む。制御用は予約した枠で、通常用の溢れに巻き込まれない（4.7）。
- reader は `LevelMeter` を積まない（10章）。積む量は、応答・通知の数に比例する。
- writer への送信は、ブロックしない `try_send`。満杯なら、その接続を隔離する（4.5）。actor は、どの送信でもブロックしない。

### 3.2 読み取りは actor を通さない

**F1b 以降：** `get_audio_state`、`get_audio_session` などの読み取りは、`SnapshotCell` から不変の `Arc<Snapshot>` を返す。actor が10秒待っていても、読み取りは待たない。この変更は、`get_audio_state` を待ちのあとの値で返す旧の境界（直後の `expectedState` の照合に影響する）を変えるので、F1b の承認の差分（互換の契約 D-8）。

**F1a では、旧の境界を保つ：** `get_audio_state` は、受付順の読み取りの命令として actor の列を通り、先行する命令の完了後の値を返す。`get_saved_audio_config` は、今と同じく、ファイルを直接読む（欠損・破損・移行の後の結果を変えない）。

ただし `auto_gain` の `Status` のように、子へ問い合わせる読み取りは、今は IPC で待つ（F-15）。F1a では今のまま、actor の「1段の待ち」に入れる。F1b で、ストリームの状態（動作中・障害）をスナップショットの項目にして、問い合わせを減らす。

### 3.3 子プロセスの起動・再起動（接続の生成）

起動は `Spawn` の状態機械で行う。接続の世代の更新、起動時の IPC（ピーク保護・true-peak の引き継ぎ、F-12）、旧 reader の終了処理まで含める。

1. 旧接続があれば、`Teardown`（4.4）を先に終える。終わるまで、新しい接続は作らない。
2. `ConnId` を採り、子を起動し、Job Object に割り当てる。**割り当ての成功が、その接続を使い始める条件**。失敗したら、ただちにその子を `kill` し、reaper で終了を確かめるまで、新しい子を起動せず、結果を失敗にする（今は割り当てを `let _ =` で捨てている：`audio.rs:754-765`）。成功したら、reader・writer・reaper を起動する。
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

**ポンプ**：`await_response(wait)` は、受信箱を読み続ける関数。待ちは `wait = { conn, role, stage_token, deadline_token }` で識別する。

- 入力は、次の照合を通ったものだけを、この待ちに作用させる。
  - `Response`：`wait.conn`・`wait.role` が一致し、期待の列（4.3）の先頭が `wait.stage_token` の持ち主であるとき。
  - `Eof`／`Reaped`／`ReaderDone`：`(wait.role, wait.conn)` が一致するとき。`WriteDone`：さらに `stage_token` が一致するとき（遅い `WriteDone` は、次の段の待ちを解かない）。**他の接続（旧接続、配信ミックスなど）の入力は、その接続の終了処理（7章）を進めるだけで、今の待ちは解かない。**
  - `Deadline`：`deadline_token` が一致するとき。前の段の `Deadline`（トークン不一致）は、捨てる。
- `Event` は、段や命令の種類によらず、その場で処理する（状態の更新・履歴・旧の通知の発行）。
- 順序の固定：
  1. reader は、stdout の行を読んだ順に `Wire` を積み、EOF は**最後に**積む。したがって EOF までに読めた応答は、EOF より先に処理される。
  2. `Reaped` は、reader が EOF を積み終えるまで、その接続については処理を保留する（生の `Reaped` が最終の応答を追い越さない）。reader の終了を `ReaderDone{conn}` として積み、`Reaped` と `ReaderDone` の両方を受けてから、その接続を `Ended` にする。reader が詰まって来ない場合は、`Reaped` の後2秒で `ReaderDone` なしに進む（履歴に `reader_abandoned` を残す）。
  3. 1つの待ちに対して、`Response` と `WriteDone` のどちらが先に届いてもよい。`Response` が先なら応答を採り、後から来た `WriteDone(Ok)` は捨てる。`WriteDone(Err)` が先なら、待ちを `Err(WriteFailed)` で解き、その後の `Response` は、期待の列の持ち主へ当てて捨てる（接続は隔離される）。
  4. `Shutdown` は、待ちを `Err(Shutdown)` で中断し、`held` の命令を `Shutdown` で完了して、`Teardown` へ進む。
- `Command` は `held` へ入れる（4.7）。
- 待ちの解除は、その待ちの接続・役割・段が原因のときだけ。

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
| S3 ミュート | `SetGlobalMute`（開始前のミュートの確認）。**`initial_controls` つきの開始は、`SetGlobalMute` を送らず、S4 の `Start` に初期の制御を載せる**（`audio.rs:1618-1626`）。S3 を飛ばす | 応答 | 10秒 | `Failed` |
| S4 開く | `Start { attempt_id, … }` を送る | `Event::Started`、`Response::Started`（両方）、または `Response::Error`、`Stopped`、`Eof` | 10秒（互換のため据え置き。5.4） | 5.3 |
| S4' 清掃 | 確定しない成功の後始末として `Stop` を送る | `Response::Success`、`Eof` | 10秒 | 隔離（5.3） |
| S5 検証 | 機器 ID、ルーティング、アプリ入力の一致を確かめる | なし（同期） | なし | 不一致なら S4' へ |
| S6 確定 | 確定点（5.2）。保存（8章）。履歴を1件足す。結果を1回返す | 保存の完了（`PersistDone`） | 5秒 | 保存の失敗は 8.2 |

S0〜S3 の段の境目ごとに、**権限の照合（6.4）**を行う。失効していれば、子へ何も開かせずに `Superseded` で完了する。S3 から S4 に進む直前（取り消せない送信の直前）にも、同じ照合を行う。

**音声が開いた可能性のある失敗は、すべて清掃（S4'）へ合流する**：S4 の期限切れ、`Started` の後の `Error`、C3〜C5 の失敗、権限の失効、`Response` の不一致。S4' の `Stop` が、拒否（`Error`）された・応答が欠けた・予期しない応答だったときは、その接続を隔離する（`quarantine_cleanup_failed`）。清掃の後は、主のハンドルと配信ミックスのハンドルを別々に確かめる（それぞれの `Stopped`／終了の確認を待つ）。どちらかが確かめられなければ、その接続を隔離する。

### 4.4 `Teardown`（接続の終了処理）と、プロセスの終了の確認

**通信の切断**と**プロセスの終了**は、別の状態にする。

```text
ConnectionRecord.comm:    Open | Detached           // stdin を閉じた・EOF を見た・隔離した
ConnectionRecord.process: Running | Terminated(status) | Unconfirmed
```

持ち主：

- `Child`（`wait()` 用）は reaper スレッドが持つ。
- 強制終了の手段は、親の `ConnectionRecord` が持つ：Job Object のハンドル、および `Child` から複製したプロセスのハンドル。actor は `TerminateProcess`（待たない）と Job の破棄だけを行う。`child.wait()` は呼ばない。

意図した終了（再起動、更新のための停止、隔離、アプリの終了）は、次の段で行う。

1. 接続を `Closing{cause_request, intent}`、`comm = Detached` にする。以降、その接続の通知は「履歴だけ」で、今の状態へは作用させない。
2. 待っている要求を、`ConnectionEnded` で完了する（1回だけ）。
3. Job を落とし、`TerminateProcess` を呼ぶ。
4. reaper が `Reaped` を返したら、`process = Terminated` にして、終了を確定する（7章）。

**`Reaped` が来ないとき（`process = Unconfirmed`）：**

- 2秒で `Unconfirmed` にする。**これは終了の確認ではない。** 履歴に `process_unconfirmed` を残す。
- `Unconfirmed` の間は、**新しい子の起動も、その接続の再利用もしない**（P12）。旧の子が機器を持ったままの可能性があるため。
- 要求は、期限付きで失敗にする：`Spawn` を要する命令は、`Unconfirmed` が解けるまで最大10秒保留し、解けなければ `engine_unconfirmed`（`音声エンジンの終了を確認できません。しばらくしてからもう一度お試しください`）で失敗する。
- 解消を試み続ける：2秒ごとに `TerminateProcess` を再実行し、reaper の `Reaped` を待つ。Job の割り当てに成功していれば、Job の破棄が孫まで終わらせる。
- アプリの終了時（`Drop`）だけは、actor の外で、上限2秒の `wait` を行い、終了しなければそのままアプリを終える（Job が回収する）。

### 4.5 stdin の書き込みの上限

- 書き込みは writer スレッドが行う（F-14 の先例）。actor は `WriteLine{conn, token, json}` を送るだけ。writer への列は有界（8件）。溢れたら、その接続を隔離する。
- writer が `WriteDone{token}` を5秒以内に返さなければ（パイプが満杯 = 子が読んでいない）、接続を隔離する。隔離の手順は `Teardown`（意図 = `quarantine_write_stall`）。writer への送信が `try_send` で満杯のときも同じ。
- 書き込みの失敗（`BrokenPipe` など）は、今と同様に、接続を終了する。`audio-error` の通知（`audio.rs:1178`）は互換のため残す。

### 4.6 移す入口の一覧

「actor の上」は、`AudioControl::run(|host| …)` で actor スレッドの上で実行すること。「受付」は `Admission` を通ること。

| 入口 | 今 | 移し先 |
|---|---|---|
| `commands/audio.rs` の全コマンド | `state.lock()`（`run_blocking`） | 受付 → actor。`get_audio_state` は、F1a は列を通る読み取り、F1b から `SnapshotCell`。`get_saved_audio_config` はファイルを直接読むまま |
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
| 起動時の設定（`lib.rs:300-312`） | `AudioHost::new`、レビューのみの一時利用なら `require_explicit_start`、`ConditionState` と `AudioState` の登録、スケジューラの開始、`set_event_emitter`、warmup スレッド | F1a-0：同じ場所で同じ手順。actor へは F1a-2 で移す（起動の順序を試験で固定） |
| 配信セット（`commands/bundles.rs:2011`） | 同じ `Arc<Mutex<AudioHost>>`（`AudioState`）を渡している | F1a-0：`AudioControl` の入口を通す。長い保持は F1a-2 の「複数の転送の列」 |
| アプリの終了（`quit_app`、`Drop`） | `Drop` で `kill`+`wait` | `Shutdown` 入力 → `Teardown` → 上限2秒 |
| 機器のスキャン | `DeviceScanTicket` | 1段の待ち。接続が変われば古いチケットを捨てる |
| フロント（`api/audio.ts`） | 個別の `invoke` | F1a は変えない。F3 以降で `audioSession` 経由 |

### 4.7 受付の容量・保留・期限・過負荷（第2回のレビュー P1）

| 項目 | 値 | 動作 |
|---|---|---|
| 終わっていない要求の全体の上限 | 256件（通常用の受付、`held`、実行中の合計。ポンプが通常の命令を `held` へ移しても、この合計は減らない） | 超えたら、受付は `busy_overloaded`（`音声の操作が混み合っています。しばらくしてからもう一度お試しください`）を返す。`seq` は採らない |
| 制御用の受付 | 予約（上限は接続数×64+64）。**停止・終了・完了を伝える入力は、通常用の溢れに巻き込まれない専用の経路を持つ**（レーンの分割は PRE-F1a1-2 で決める） | 停止系の命令と、子からの入力・期限は、通常用の溢れの影響を受けない。停止系は受付の時点で `latest_stop_seq` に反映済みで、**実際の停止の実行も制御用の列を優先**する |
| 保留（`held`）の最大の待ち時間 | **通常の命令：60秒**（起点は受付の時刻）。**停止系は、期限で捨てない**（受付で記録した停止を `HeldTimeout` で捨てると、古い開始を失効させた停止そのものが実行されなくなるため。J-8：30秒で停止を捨てる仕様はやめる）。停止系は、必ず実行して結果を返す | 通常の命令は、超えたら `HeldTimeout` で完了する（実行しない）。結果は1回だけ。`Shutdown` のときは、2つの受信箱と `held` の要求を、すべて1回ずつ `Shutdown` で完了する |
| 命令全体の期限 | 命令ごとに受付から90秒（開始・再起動は 120秒） | 段の期限とは別。超えたら、次の境目で中止し、清掃が要れば清掃へ進む |
| 期限の確認 | `Deadline` の入力に加えて、**段の境目・複数の転送の列の転送ごと**に、単調時計で確認する | 列の末尾の通知が遅れても、期限を過ぎた命令は境目で止まる |
| 定期の更新 | モード VST のスケジューラ（10ms）など | `Timer` 入力は**畳む**：同じ種類が受信箱にあれば、新しく積まない |
| 過負荷のときの結果 | `busy_overloaded`、`HeldTimeout`（通常の命令のみ）、`Superseded`、`Shutdown` | 結果は常に1回。呼び出し側の旧の形（`Err(String)`）への写し方は、互換の契約に追記する |
| 機器のスキャン（最長35秒） | `Begin`・`Poll`・`Cancel` の短い段に分ける | actor は、スキャンの全体を占有しない。1回の `Poll` は短い1段の待ちで、間に他の命令が入れる（今も、チケットと照会が分かれている：`audio.rs:1226`） |

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
4. **C4** 権限の照合に通る（6.4）：`latest_stop_seq` が自分の `seq` より小さく、`manual_epoch` が受け付けたときの値と同じで、取り消しの印がなく、対象のストリームが一致する。再開・復元の開始なら、その権限（12.1、11.4）も有効。
5. **C5** 接続が `Live`。C1〜C3 より前に、その接続の `Error`・`Stopped`・`Eof` を処理していない。

受信箱は到着順で、確定の前後は、**`Response::Started` の処理の手番**で決まる。

- `Started(B)` → `Error(B)` → `Response::Started(B)`（`Response` の**前**に、B 自身の `Error` が届いた）：C5 で確定を拒む。清掃へ進む。
- `Started(B)` → `Response::Started(B)` の**後**に届いた `Error(B)`：確定したストリームの障害として処理する。
- `Started(B)` → `Error(A)`（別のストリーム A の古い障害）→ `Response::Started(B)`：**C5 は、対象の試行とストリームの単位で判定する**ので、A の `Error` は B の確定を止めない（F1b。子が世代を付ける、7.2b）。F1a・番号のない `Error`（旧形式）は、接続の単位で判定する（現行と同じ。B を落としうることは、互換の契約で固定する）。
- C1〜C5 の確認と、`Running` への遷移、履歴の追記、保存の依頼は、同じ手番で行う。間に入力は入らない。
- S4 の期限切れですぐ応答する場合（5.3）と、通常の失敗で主と配信ミックスの清掃を待ってから応答する場合は、分けて扱う（PRE-F1b-2）。

条件が成り立たないとき。

- C4 の失敗：子のストリームは開いている。清掃の `Stop`（S4'）を送る。要求の結果は `Superseded`。応答のときに権限が失効していた場合も同じ。
- C3 の失敗：同じく清掃の `Stop`。結果は `Failed`（今と同じ文言。互換の契約）。
- C5 の失敗：**これも清掃の `Stop` へ合流する**（現行のコールバックの障害は、ハンドルの解放を意味しない：F-7）。結果は `Failed`。ストリームは持たない。清掃が確認できるまで、新しい開始は保留する。
- どの失敗でも、清掃を完了してから結果を返す。物理的な停止が確かめられない場合は、隔離（4.3）。

### 5.3 タイムアウトと遅れた成功の後始末

【設計】S4 の期限（10秒）が切れたとき。

1. 要求を `Timeout` で、**1回だけ**完了する（今と同じ文言）。`RequestLedger` に記録する。
2. 試行を `Abandoned{attempt}` にし、接続を `Suspect` にする。
3. 親は、清掃の `Stop` を送る。子の stdin の順序に従い、子は遅れた `Start` を終えた後で `Stop` を処理する（F-4）。応答は、接続ごとの期待の列（FIFO）で受ける。`ReplySlot` の1件を、`ExpectedResponses: VecDeque<Owner>` に置き換える。
4. 遅れた `Response::Started` が来たら、期待の列の先頭（`Abandoned` の持ち主）に当てる。要求には作用せず、履歴に `start_late_success_discarded{attempt, stream}` を1件足す。次の `Response::Success`（清掃の `Stop`）で、接続を `Live` に戻す。
5. 猶予（20秒）の間に応答が来なければ、接続を隔離する。`Teardown`（意図 = `quarantine_start_timeout`、原因の要求 = その `request_id`）。この猶予は、ドライバが機器を開き続ける場合を考えた値（`audio/engine_exit.rs:333-340` のコメントと整合）。
6. 新しい `Start` は、`Suspect` が解けるまで（清掃の `Stop` の成功か、接続の終了の確定）、`held` に置く。

「終了の確認」の定義：清掃の `Stop` の `Response::Success`、または接続の `process = Terminated`（`Reaped` を観測した）。**`Unconfirmed`（`Reaped` が来ない）は、終了の確認ではない。** どちらも観測していなければ、完了とはみなさず、新しい子の起動も開始も許さない（4.4）。10秒で失敗にした要求は、遅れて届いた `Reaped` で復活させない（失敗のまま。保留の別の要求だけが、`Terminated` で進む）。

**残る窓（J-4：今回は扱わない。別の Issue で扱う）**

- **経路**：子の制御ループが `Start` を実行している間に、機器の出力が開いて音が出る（`audio_engine/core/startup.rs:2240-2265`）。親は10秒で失敗を返すが、子の `Start` は止められない（子は `Start` の間、制御ループを塞ぐ：F-4）。
- **時間**：親が `Timeout` を返した時点（開始から10秒）から、(a) 子が `Start` を返し、清掃の `Stop` を処理して出力を止めるまで、または (b) 猶予（20秒）と強制終了（約2秒）による隔離で終わるまで。**最大でおよそ開始から32秒まで、音が出うる。** 隔離しない場合（今の `9567061a`）は、子の `Start` が返るまで、上限がない。
- **今回は**：開始の10秒を保ち（J-4）、窓を無くす変更（子の中での「準備」と「出力の有効化」の分離）は行わない。窓の時間と経路は上のとおり記録し、別の Issue（未起票。この F0 では起票しない）で扱う。D-1（隔離）は、窓の上限を決める変更として、F1b の承認の対象にする。

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

### 6.4 権限の照合（各段が受け付けたときの権限を持つ）

第2回のレビュー（実行中に権限が失効しても確定してしまう）への解。各命令は、受付のときに**権限**を持つ。

```text
Authority { seq, manual_epoch, stop_floor(= latest_stop_seq at accept), cancel_mark_ref, target_stream?: StreamId, session?: SessionId, restore_right? }
```

照合 `authority_valid(a)` は、次の4つを、**1つの受付の境界（`Admission` の葉のロックの中で読む `{latest_stop_seq, manual_epoch, cancel_marks}`）**に対して行う。

1. `latest_stop_seq <= a.stop_floor`（受付のあとに、停止が受け付けられていない）。ただし、自分自身が `StopAll` のときは除く。
2. `manual_epoch == a.manual_epoch`（自分が手動の操作でないとき）。手動の操作は、自分の受付で進めた値を持つので、それより後の手動の操作が失効させる。
3. 自分、またはセッションの `cancel_mark` がない。
4. `target_stream` があるなら、現在のストリームと一致する。

照合する場所：

- 各段の境目。
- **取り消せない送信の直前**：`Start`（S4）、`Stop` の送信、`ResetInputSource`、処理設定の適用、保存の依頼。
- **確定のとき**（C4）と、**応答を受けたとき**。応答の時点で失効していれば、確定せず清掃へ進む。

これで、「`recover`（または取り消しの『元を再開する』）が照合を通った後、S4 の待ちの間に手動の Start B を受け付けた」場合は、応答のときに失効が見つかり、A は確定せず清掃される。B が後で失敗しても、A は残らない。

### 6.5 停止の実行

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

**ストリームごとの原因（第2回のレビュー）：** 終わらせるストリームごとに、`stream_end_intent: Map<StreamId, Intent>` を持つ。1つのストリームに対する記録は**最初に受け付けたものだけ**を残す（単一代入）。利用者の停止、開始による置き換え、内部の清掃が同じ対象に重なっても、残る要求 ID は1つ（受付順が最も早いもの）。後から重なった意図は、履歴に `also_intended` として要求 ID を添えるだけで、`cause_request` にはならない。

停止の意図を、**操作を出したときに記録する**（レビュー N4）。停止、開始による置き換え、再起動、確認への切り替え、放棄した試行の片付けは、`Closing` または `stream_end_intent{cause_request}` として、命令の処理の最初に書く。終了の確定のとき、記録された `cause_request` を付ける。ストリームの終了（`stream_ended`）も同じで、原因の要求 ID を必須にする（自発の障害は `None`）。

### 7.2b 障害と停止に、発生元のストリームを付ける（同じ接続の中の古い障害）

`conn == current_conn` の照合だけでは、同じ接続の中で A → B と切り替わった後の、A の遅れた `Error` を区別できない（F-7：`Error` に番号がない）。

- **F1b（D-5）：** 子の `Error` に、`stream_generation`（発生元）と `side`（`input`／`output`）を付ける。コールバックは、atomic に世代と side の印を立てるだけで、制御ループが文字列を作って送る。文字列に `Stream Error` を含める規則は、旧の復旧のフィルター（`hooks/useAudioRecovery.ts:28-31`）のために保つ（契約）。
- 停止（`Stopped`）は、今も持つ `ended_stream_generation` で照合する（F-5）。親は、`ended_stream_generation` が現在のストリームと一致するときだけ、今の状態へ作用させる。
- **番号のない旧形式の `Error`：** F1b 以降、子が能力（`StreamAttemptCapability`）を持つ接続では、番号のない `Error` は、今の状態へは作用させず、履歴に `unattributed_error` として1回だけ残す。能力のない接続（互換のためだけ）では、現行どおり接続の現在のストリームに作用させる。
- F1a は、旧の挙動のまま（番号のない `Error` は、接続の現在のストリームに作用する）。A1 の保証は F1b から。

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

### 8.3 確定点と競合（保存の2段）

保存は、確定の手番（5.2）の最後の確認（C1〜C5）の**後**に、persist スレッドへ依頼する。persist スレッドは、**2段**で書く。

```text
段 A（中止できる）：一時ファイルへ書く → sync_all
段 B（中止できない）：rename
状態：Pending → (actor が期限で) Abandoned   または  Pending → Renaming → Done|Failed
```

- 段 B に入る前に、worker は `Pending → Renaming` を CAS で試みる。actor が期限（5秒）で `Pending → Abandoned` に成功したら、worker は一時ファイルを消し、**`rename` を行わない**。この場合だけ、「保存しなかった」と確定できる（`ConfirmedNotSaved`）。
- `Renaming` に入っていたら、actor は「保存しなかった」とは返さない。**結果は `PersistPending`（確認中）**で、`rename` の完了（`PersistDone`）を待つ。完了したら `Confirmed` または `ConfirmedNotSaved`（失敗のとき）に確定する。`PersistDone` がさらに5秒来なければ、`get_request_outcome` は `pending` を返し続け、worker の完了で確定する。
- つまり「`ConfirmedNotSaved` を返した後に、ファイルが更新される」経路はない。
- 最後の確認の前に、親が受け付けた停止・障害があれば、保存しない（C4・C5）。
- 確認の後に受け付けた停止は、受付順で開始の後。ストリームは確定し、ファイルは書かれ、その後に停止される。
- **障害を、子が先に知っている場合：** 保存の依頼の直前に、親は子へ**ストリームの状態の照会**（`StreamState{stream_generation, running, failed}`）を送り、その応答（`stream_generation` が一致し、`running`・`failed = false`）を**保存の境界**にする。この応答の後に立った障害の印は、受付順で保存の後（8.3 の他の項と同じ）。F1b で子に `StreamState` を足す（今の `auto_gain` の `Status` で代用できるか、F1b で確かめる：F-15）。
- 確認の後、`PersistDone` までの間に、同じ接続の `Error` が届いたら、障害は確定したストリームのものとして処理する。ファイルの内容は、確認した時点の設定のまま。
- 書き込みは、今の `write_json`（一時ファイル→`rename`）を使う。`rename` の失敗では、元のファイルは変わらない。1バイトも変わらないことを試験する。
- **B の保存と、古い A の遅い完了：** 保存の依頼は `request_id`・世代を持つ。worker は、段 B の直前に、「この依頼がまだ最新の確定か」を `latest_persist_token` で確かめ、古ければ（B の依頼が後に出ている）`rename` を行わない。B のファイルを、A の遅い完了が上書きしない。
- **移行との排他：** 移行は、`last_audio_config.json` を含む設定のファイルを書く（`migration.rs:688` 付近）。移行の適用は `StopForMaintenance` を通り、その間は persist worker の依頼を受け付けない（`ConfigIoLease` を actor が1つだけ持つ）。「書き手は1つ」の保証は、この排他による。移行が書く範囲の全体は、F1b の前に確かめる（17章）。

### 8.4 再送と、応答が消えたとき

- フロントは `clientRequestId`（文字列）を付ける。親は、最近の完了した要求（64件）を、`clientRequestId → {payload_hash, outcome}` で持つ。
- **合流は、`seq` や `manual_epoch` を更新する前に行う。** `Admission` の葉のロックの中で、`clientRequestId` を台帳で調べ、既に実行中か完了していれば、新しい `seq` を採らず、同じ結果に合流する（oneshot を複数へ配る）。
- 同じ ID を**別の内容で使い直した**ら、`rejected_id_reuse`（`payload_hash` が違う）。何も変えない。
- 台帳（64件）から追い出された後の再送は、新しい要求として扱う。**この保証は、直近64件の範囲、かつアプリの実行中に限る**（追い出された後は、`get_request_outcome` は `unknown`）。
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
- **確認の位置は、続けて適用・確認できた位置だけを進める。** フロントは、`occ_seq` が `deliveredSeq + 1` のものだけを順に適用し、欠番があれば、その位置から `get_audio_session` で取り直す（11番が落ちたまま12番を適用して `deliveredSeq = 12` にしない）。取り直しで届いた11番は、続けて適用する。
- **確認の更新の場所：** 確認（`sinceSeq`）は、フロントが**状態に適用した直後**に、メモリの `deliveredSeq` を進め、親へは次の `get_audio_session` の呼び出しで送る。1回だけ知らせる通知（クラッシュの画面）は、履歴ではなく**スナップショットの `pending_notices`（通知の ID つき）**で持ち、利用者が閉じた時点で `dismiss_notice(id)` を親へ送る。リロードで再表示されるのは、未解決の通知を1つ表示することで、二重ではない（同じ ID は1ウィンドウで1つだけ表示する）。
- 複数のウィンドウは、`clientId` ごとに確認の位置を持つ。最終の確認から60秒呼び出しのないクライアントは、確認の対象から外す。戻ってきたときは、`resync = true` とスナップショット（`pending_notices`、`lost_critical`）を返す。保証するのは「スナップショットで今に追いつく」こと。外した間の個々の履歴は、枠に残っていれば返し、なければ `resync`。
- **64件を超えたとき：** 保証するのは、`lost_critical` の件数と、`pending_notices`（未解決の通知）が残ること。個々の履歴の全件は保証しない。
- **アプリの再起動：** スナップショットに `session_epoch`（起動ごとの乱数）を持つ。フロントは、`session_epoch` が変わったら `deliveredSeq` と `appliedRevision` を捨てて取り直す。履歴は再起動をまたがない。
- **クラッシュの通知を出すウィンドウ（J-3）：** メインウィンドウ（ラベル `main`）だけが、クラッシュの画面を出す。他のウィンドウがあれば、状態の反映だけを行う。他のウィンドウの有無は、17章で未確認として挙げる。
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

### 11.1 基準は「最初に実際の置き換えへ進んだ時点」（J-1：利用者の決定）

**決定（利用者）：** 戻す対象は、「確かめ始めた時点」、すなわち、**確認の開始が、動いている音声を実際に置き換える（元を止める）ところへ進んだ時点**の状態とする。セットアップを開いた時点とはしない。

- 動いている音声がない場合は、「元は停止中」の状態を、確認の最初の開始（同意の要らない開始）の時点で記録する。
- **同意を取り直したとき**：別の音声 B が動いていて、利用者が B を止めることを新たに承認したら、**新たに停止を承認された対象（B）の状態から、復元点を作り直す**。復元点の作り直しは、同意の対象の音声ごとに1回。作り直した復元点は、その同意の `ConsentToken`（11.3）に結び付く。
- 復元点は、元の音声を止める**前**に保存する。一部の停止が成功した後に失敗しても、記録は残る（11.4）。

理由（第2版から引き継ぐ）：

1. 利用者が同意して止めるのは、その時点で見ている音声。開いた時点の音声を戻すと、その後に利用者が止めた音声を勝手に開き直しうる。
2. 同意は、音声の番号に結び付く（S4）。戻す対象も同じ時点の記録にそろえると、同意と復元が食い違わない。
3. 親が観測して順序を保証できるのは、受付以降の状態だけ。

画面の初期の取得（`initialStateRef`）は、表示のためだけに残す。

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

- `begin_trial { session_id?, purpose, connection, consent_token? }`
  - **セッションの扱い：** `session_id` を渡す = 同じセッションの再試行（復元点を保つ。声→音楽の切り替えも同じセッション）。渡さない = 新しいセッション。新しいセッションを作れるのは、開いているセッションがないとき、またはそのセッションが閉じた後だけ。開いているセッションがあるのに `session_id` がなければ `rejected_session_open`（取り消すか、`session_id` を渡す）。渡した `session_id` が現在のものと違えば `rejected_session`。
  - **同意は親が発行する：** 別の持ち主の音声が動いていると、親は `needs_consent{ consent_token }` を返す。`ConsentToken = { token, session_id, stream_id, conditions_version, expires_at }`。`conditions_version` は、本番の保護（armed）の状態、経路の条件、`active_config` の版をまとめた値。
  - 利用者が同意すると、フロントは `consent_token` を付けて `begin_trial` を呼ぶ。親は、**元を止める直前に**、トークンを照合する：セッション、`stream_id`（現在の音声と一致）、`conditions_version`（変わっていない）、期限、**未使用**。通れば**使用済み**にして、1回だけ使う。条件が変わっていれば、`needs_consent` を新しいトークンで返し直す。古いトークン（セッションを閉じて作り直した場合を含む）は拒否する。
  - **元を止める前に、子の能力（`StreamAttemptCapability`）を確かめる。** ない場合は、元の音声に触れず `unsupported_engine`（事前の拒否。開始後の番号の欠落は 11.7 の隔離で、別）。
  - 照合に通れば、復元点を保存し（11.1）、元を止め、`PersistPolicy::None` で確認の音声を開始する（owner = Trial）。
- `commit_trial { session_id, stream, answer: Heard | Later, processing }`：11.5。
- `cancel_trial { session_id }`：11.4。

**`CancelTarget` と `cancel_trial` の対応（P3）：** `CancelTarget{session_id}` は、そのセッションの実行中の命令（途中の `begin_trial` の開始など）に `cancel_mark` を付けるだけの、受付の種類（6.2）。`cancel_trial` は、(1) `CancelTarget{session_id}` を受け付け、(2) 実行中の段が境目で止まったことを確かめてから、(3) 復元の手順（11.4）を実行する、という2つの命令の組。復元の手順は、`CancelTarget` では行わない。

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
8. **「元を再開する」（手順5）も、権限を持つ。** 再開の `Start` は、`Authority{ manual_epoch = restore_epoch, stop_floor, cancel_mark, target = 元の stream }` を持ち、S4 の直前と確定のときに 6.4 の照合を通す。応答のときに権限が失効していれば（取り消しの途中に手動の Start B を受け付けた場合）、確定せず清掃する。B に何もしない。
9. 「別の持ち主の音声」と判断した後に、**元を開き直してよい境界**は、手順2（`restore_epoch` の照合）と、手順5の権限の照合の2か所。どちらかが失効なら、再開しない。
10. 復元の失敗で、取り消しの結果に「誤った開始の失敗」を重ねない：復元の失敗は `failed{targets}` として1つだけ返し、元の開始が成功していたとしても、その開始の結果は書き換えない。

### 11.5 処理設定と保存の命令

**保存の確認（`answer`）：** セットアップの「聞こえた」「あとで確かめる」を、`commit_trial` に渡す。

| `answer` | 照合 |
|---|---|
| `Heard`（聞こえた） | 自分の確認の音声（番号）、障害なし、`arrived = true` |
| `Later`（あとで確かめる） | 自分の確認の音声（番号）、稼働中、障害なし。`arrived` は要求しない（無音でも保存できる。現行の挙動を保つ：統括の決定） |

どちらも、保存の直前に、子への `StreamState` の照会（8.3）で、世代・稼働・障害なしを確かめる。これが保存の境界。

**`ProcessingLedger`** の1項目：`{ kind: NoiseControl | BuiltinEffects | Reverb, before, target, apply_revision, conn, stream, status, deadline }`。`status = Pending | Applied | Confirmed | RolledBack | RollbackFailed | Diverged | Tracking`。

保存の命令の、1つの手番の中の順序。

1. 照合（上の表）と権限の照合（6.4）。
2. 処理設定を適用する。反映の完了を、上限付きで待つ。
3. **反映が期限に間に合わなくても、失敗と決めない。** 子の状態を取り直し、`observed` を得る。
4. 再照合（`StreamState`）。
5. 保存（`Required`。確定点は8.3）。
6. owner を `User` にする。

途中で失敗したら、巻き戻す。巻き戻しは「Undo の履歴」に頼らない（履歴は `StreamChanged` などで失効する。`audio_engine/core/commands.rs:174-190` 付近）。

- `observed == before`：何もしない。
- `observed == target`：条件付きで `before` を適用し直す。**期待のリビジョンを、`observed` のリビジョンにする。** 同じ値への別の操作は、版（リビジョン）で区別する。適用後に、取り直して反映を確かめる。
- それ以外（並行の編集）：触らず、`Diverged` として結果に載せる。
- 項目は独立。内蔵処理の巻き戻しが失敗しても、ノイズ低減の復元は続ける。

**遅れて反映される適用の責任（第2回のレビュー）：** 適用の決着を待つ間に期限を超えたら、項目を `Tracking` にして、**親が最後まで追う**。画面を閉じても、確認のセッションが終わっても、追跡は残る（`orphan_ledger`）。

- 追跡の範囲：適用した**接続とストリーム**、`apply_revision` に限る。接続が終われば、追跡は終わる（子の状態も消える）。
- 決着（`pending == false`）が観測されたら、上の `observed` の規則で巻き戻す。**巻き戻しは、適用した `conn`・`apply_revision` に限って**行い、別の接続・別の版の状態には触れない。
- 追跡の上限は5分。超えたら `RollbackFailed{pending}` を履歴に残し、スナップショットの `pending_notices` に載せる（利用者に知らせる）。
- 子の契約（F1b の候補、D-14）：期限の後の適用を拒む（`apply_deadline` つきの適用）。これがない間は、親の追跡で補う。

**`commit_trial` の失敗：** 保存の前の失敗は、保存せず処理設定を戻し、セッションを残す。保存の確定点より**後**に届いた障害は、確定したストリームの障害（保存は書かれている）。確定点より**前**なら、保存しない（H24 の2行）。

### 11.6 アプリの入力の特定し直し

アプリ入力は、PID ではなく `app_key`（64桁）・`raw_endpoint_id`・用途で記録する。復元のとき、候補の一覧を取り直し、この3つが一致する候補がちょうど1つのときだけ採用する。0 件・複数は `restore_failed{app_not_found | ambiguous}`。新しい PID の対象で開始し、`process_inputs.selected` に登録する（`audio/process_inputs.rs:133`）。その後、ホームの開始まで通ることを試験する。

### 11.7 番号のない開始

確認の開始では、番号のない `Response::Started` を成功とみなさない。開始の前に能力を確かめる。応答の番号が欠けた、または不一致なら、その接続を隔離し（`quarantine_protocol`）、終了を確かめるまで、確認のセッションを `failed` にする。互換のための番号のない応答は、通常の開始（ホーム）にだけ許す。

### 11.8 Auralyn を再起動したとき

確認のセッションは、メモリだけに持つ。ディスクには書かない。再起動すると、確認は消え、**最後に確定した設定**（`last_audio_config.json`）で起動する。確認のあいだは書かないので、中断した確認の跡は残らない。子も一緒に終わるので、処理設定の変更は、子の再起動で消える。中断した復元を引き継ぐ案は、利用者の体験に影響するので、J-2 に置く。

## 12. 自動の再開

### 12.1 権限

```text
RecoveryAuthority { id, failed_stream, conn, commit_manual_epoch, commit_stop_floor, attempts: 0..3 }
```

- **権限は、障害を処理するときではなく、障害を起こしたストリームの確定のときの境界に結び付ける。** `Running` にしたとき（5.2）に、その時点の `manual_epoch`（`commit_manual_epoch`）と `latest_stop_seq`（`commit_stop_floor`）を、ストリームの記録に持つ。障害の通知が遅れて、actor が後から障害を処理しても、権限の基準は確定時の値のまま。したがって、**障害の通知が遅れている間に受け付けた手動の Start B は、権限を失効させる。** 障害の処理の時点の新しい `manual_epoch` で権限を発行する経路はない（レビューの順序：A の障害の通知が遅れる → 手動の Start B → B が失敗して Idle → 古いタイマーが再開、は拒否される）。
- 親が、現在の確定したストリームの障害（`failed_stream`）を確定したときに作る。owner が `Trial` のときは作らない。
- `recover { authority_id }`：R1 の呼び出しは、**権限の ID を必ず渡す**。確認：6.4 の照合（受付の境界）、`manual_epoch == commit_manual_epoch`、`latest_stop_seq == commit_stop_floor`、現在のストリームが障害の同じもの（または停止）、接続が生存。満たさなければ `rejected_precondition`。**実行の途中（S4 の待ち）でも、6.4 の照合を通し直し、応答のときに失効していたら、確定せず清掃する。**
- 番号のない旧の呼び出し：R1 の前は、旧フロントの再開は通常の `start_audio`（手動の開始として扱われる）。R1 のフェーズで、フロントは `recover` に切り替える。フロントと Rust は同じアプリに同梱されるので、混在は想定しない。R1 の後は、`origin` も権限の ID もない `start_audio` は手動の開始（`manual_epoch` を進め、権限を失効させる）として扱う。旧の呼び出しを受け付ける期間は、R1 の PR で、フロントの切り替えと同時に終わる。

### 12.2 失敗しても続ける

- 権限は `failed_stream` と `manual_epoch` に結び付く。`revision` には結び付けない。1回目の失敗で状態の版が進んでも、2回目は拒まれない（レビュー E2）。
- 失敗した試みは `attempts += 1` で、権限は残す（失敗の応答は `manual_epoch` を進めない。再開は手動の操作ではない）。3回で終わり（今の `attempt < 3` と同じ。`hooks/useAudioRecovery.ts:75`）。成功、または手動の操作で、権限は消える。
- 再開は `PersistPolicy::None`。再開に使う設定は、親が持つ最後に確定した `active_config`。フロントの `localStorage` の読み戻しは不要になる。保護中（armed）は今と同様に、経路を指定せずに再開する。

### 12.3 確認のセッションとの関係

- 確認の音声が動いているあいだは、権限を作らない。
- 確認の前に、**旧フロントの自動の再開を、親で制限する**（フェーズ R1）。R1 の契約は **`recover { authority_id }`** に一本化する（J-7：再開の予約はフロントに残し、権限と実行を親が持つ）。`start_audio` に `origin` を足す経路は作らない。R1 の後、権限の ID のない `start_audio` は、すべて手動の開始として扱う（`manual_epoch` を進める）。確認のセッションの間は、`recover` を拒否する（権限を作らないため）。
- 手動の開始・停止が受け付けられたら、権限は失効する。

## 13. フェーズの計画

レビューの見直し案と、統括の決定（F1a-0 から始める）に沿う。1つの PR は1フェーズ。各フェーズは `origin/main` から作る。

| フェーズ | 範囲 | 試験 | 既存の動作への影響 |
|---|---|---|---|
| **F0**（この PR） | 3文書。コードは変えない | `npm run verify -- --changed` | なし |
| **F1a-0** | 互換の試験（`9567061a` の挙動の固定）。`AudioControl` の入口の一本化。`Admission` での**受付順の記録**まで。`Mutex` は残し、勝敗は今の順序のまま | 互換の契約の試験（旧の通知の順序、`get_audio_state` の待ちの境界、`expectedState`、エラーの文字列） | **変えない**。受付順は記録するだけで、利用者から見た勝ち負けは変えない |
| **F1a-1** 通信とプロセスの寿命 | actor・受信箱（制御用・通常用）・reader / writer / reaper、接続の状態（通信とプロセスを分ける、4.4）、Job の割り当ての成功の確認、`Unconfirmed` の扱い。既存の実行の経路は保つ（旧の通知は reader から直接 `emit`。`get_audio_state` は actor の列を通る読み取りのまま） | 模擬 sidecar での段階の試験、実プロセスの境界の試験（14.4） | 変えない。`Unconfirmed` のときの要求の失敗（`engine_unconfirmed`）と Job の割り当ての失敗の扱いは、**F1a-1 でも安全のための変更なので、個別の承認が要る**（互換の契約 D-13） |
| **F1a-2** 持ち主の移行 | 入口の一覧（4.6）を、確かめられる単位で順に移す：(1) 主のコマンド (2) 配信ミックス（第2接続）(3) 機器のスキャン (4) warmup・frontend_bootstrap (5) 更新・移行・一時利用 (6) スケジューラ・トレイ・ショートカット・OBS・配信セット。各単位ごとに互換の試験を通す | 各単位の互換試験、既存の Rust 試験 | 変えない |
| **F1b** 新しい契約 | `RequestId`・`AttemptId`・確定点（5.2）、タイムアウトの後始末（5.3）、終了の確定（7章）、`audio-session`・`get_audio_session`、履歴、`clientRequestId`、`PersistPolicy`、`MeterCell`、子の `attempt_id` の echo・`Error` の世代・`StreamState`・能力の確認。`SnapshotCell` による読み取り | 合格の条件の表の F1b の行 | **安全のための変更を、互換の契約の 8.2 の表（D-1〜D-14）の単位で、個別に承認して入れる。** 「受付順を記録すること」（F1a-0 で済み）と「その順序で利用者から見た勝ち負けを変えること（`Superseded` など）」は、別の差分として扱う |
| **R1** 自動の再開の制限 | 12章の `RecoveryAuthority`、`recover`、フロントの再開の切り替え。再開の待ち時間の予約（2秒・4秒・6秒）は、フロントに残す。親へ移すのは、権限と実行 | 再開の順序の行 | 旧の再開が、手動の操作と競合したとき、拒否される。通常の再開は同じに動く |
| **F2** 確認のセッション（声と音楽） | 11章。セットアップを移す。#806 の完成。到達の判定を Rust へ。**最小の `audioSession` の購読（9章の版・`seq`・回復）をここで入れ、F3 でそのまま使い回す** | 確認の順序の行、フロントの試験、ブラウザ試験、画面の合格の条件（合格の条件の表の U 群） | セットアップだけが変わる |
| **F3-min** 購読の最小の移行（J-11） | F2 の購読を土台に、**競合の害が利用者に見えるものだけ**を移す：稼働表示、クラッシュ画面と VST の一覧、メーター（自動の再開は R1 で済み）。購読の Lint 規則は、移した機能の範囲だけに効かせる。残りの購読側（準備の画面、接続の設定、ボイスチェック、OBS など）は旧の購読のまま残す | 購読の行のうち移した機能のもの、`--feature` ごと | 内部のみ。旧の通知は残す |
| **分岐点**（13.2） | F3-min の後で、UI の構成（Tauri のまま／GPUI へ移る）を決める。GPUI は別のブランチで試作する | — | — |
| **F3-rest** 残りの購読の移行（Tauri に残る場合だけ） | F3-min で残した購読側を1機能ずつ移す。最後に、旧の購読（`listen('audio-…')` の直接の購読）が残っていないことを、機械検査と grep で確かめる | 購読の行、`--feature` ごと | 内部のみ |
| **F4** 旧の通知の廃止（Tauri に残る場合だけ） | F3-rest の確認が済んだ後にだけ着手。旧6通知と、フロントの重複した状態の組み立てを廃止。**自動の再開は、権限と実行は R1 で親にある。F4 でフロントの再開の予約・状態の重複を整理する。予約（待ち時間）まで親へ移すかは、J-7**。GPUI へ移る場合は、F3-rest と F4 は行わず、GPUI の画面が正本を直接購読する | 全 Vitest、ブラウザ試験 | 内部のみ |
| **D（文書、独立）** | #827：`docs/SPECIFICATION.md` の子の IPC を、今のワイヤ形式に合わせる（J-6）。この PR ではしない。F1b を待たない独立の文書の PR | 文書の検査 | なし |

分割の理由：F1a は、通信・プロセスの寿命・入口の移行・読み取りの境界など、互いに独立に確かめられる単位を含む。まとめて入れると、互換の試験の失敗の原因が特定できない。F1a-0 だけなら、`Mutex` を残したまま、受付順の記録と互換の試験の基準を先に固定できる。

### 13.1 F1a-0 の実装の指針（この節と互換の契約だけで、実装と試験に進める）

**目的：** `9567061a` の互換を試験で固定し、入口を1か所にまとめ、受付の順序を記録する。**製品の挙動は変えない。**

1. **`AudioControl`（入口）：** 今と同じ場所（各コマンド、トレイ、ショートカット、更新・移行・一時利用、OBS、warmup、スケジューラ、配信セットなど）で、**同じ `Arc<Mutex<AudioHost>>` の `Mutex` を取る**入口にする。`run_blocking` との組み合わせも今のまま。`AudioControl` は、ロックを取る前後の記録と、入口の種類の名前を足すだけで、ロックの順序・保持の長さ・実行するスレッドを変えない。
2. **`Admission`（受付の記録）：** 受付の通し番号 `seq` と入口の種類を、**記録するだけ**。記録は、ロックを取ることとは**別**（記録の順序と、実際にロックを取る順序は、一致しなくてよい）。**受付の記録の順序で、操作を並べ替えない。勝ち負けにも使わない。** 10ms のスケジューラも `AudioControl` を通るが、連番を振ることと、種類ごとの件数を数えることだけを行い、個々の連番と入口の組は履歴（`records()`）に残さない（直近の操作の記録を押し出さないため。`audio/control.rs` の `Admission::accept`）。 試験 K11 で、「受付の記録は A→B だが、実際にロックを取る順は B→A」の場合を固定し、記録を勝敗に使っていないことを確かめる。
3. **`stop_audio`：** `interrupt_restore()` が返す `Pending` を、**ロックを待つ前に作り、ハンドラが終わるまで持つ**（`commands/audio.rs:484-496`、`audio/conditions.rs:55-58`）。今と同じ。
4. **読み取り：** `get_audio_state`・`get_saved_audio_config` は、**`state.lock()` を取ってから読む**（同じ `Mutex` の経路。`SnapshotCell` にしない）。試験 K2・K10 は、`Start` がロックを取ったことを確かめてから読み取りを出し、開始が保存と状態の更新を終えた後の値を返すことを確かめる。
5. **通知：** 今の経路のまま（reader の `emit`、`AudioHost` の `emit`、`Conditions::dispatch` の前後の通知、`emitter` の Mutex）。`expectedState` は、既存の完全一致のまま（旧の形に写す処理は入れない）。
6. **入口の照合：** 4.6 の一覧に加えて、次を確かめる。(a) 同じ `Arc<Mutex<AudioHost>>` を渡している配信セット（`commands/bundles.rs:2011`）、(b) 10ms のスケジューラ（`audio/mode_vst.rs:526-535`。`weak` で `lock` する）、(c) 起動時の設定（`lib.rs:300-312`）、(d) 終了の経路（`quit_app`、`Drop for AudioHost`、`audio.rs:2945`）、(e) 配信ミックスの第2の `AudioHost`（`AudioState` を通らない。`audio/post_mix.rs:383-392`）。一覧にない入口がないことを、`state.lock()` と `AudioState` の全使用箇所の検索で確かめる。
7. **試験：** 互換の契約の表を試験にする（合格の条件の表の K 群、W5）。試験の継ぎ目は、既存の試験が使うもの（`AudioHost::new` と、`execute_running_command` へ差し込む応答の模擬、`conditions`）を使う。足りない継ぎ目があれば、**製品の挙動を変えない最小の差し込み**だけを足す。`ScriptedEngine`（14章）は F1a-1 から。W5（WebView への到着の順序）は、実際の WebView で測り、**Rust が `emit` を呼ぶ順序と、WebView に届く順序を、分けて記録する**。
8. **完了の条件：** K 群の全行が通る。既存の Rust 試験が通る。`npm run verify -- --static --rust` が通る。互換の契約の「F1a で変えない」の各項を、試験が1つ以上カバーする。W5 の測定結果を互換の契約に追記する。

**F1a-0 に含めないもの：** actor、受信箱、reader/writer/reaper、`SnapshotCell`、F1b のキュー付きの Emitter、保存の変更、`Superseded`、新しい通知、子の変更。**含めるもの：** 旧の `emit` を呼ぶ順序を変えない同期の薄い包み（`AudioEmitter`。`AURALYN_EMIT_TRACE` による W5 の追跡と、試験の `Recorder` のためのもの）。キューも別スレッドも持たない。

### 13.2 UI の構成の分岐点（J-11）

利用者は、Rust + Tauri から Rust + GPUI（GPUI Kit）への移行を検討している。F2 までは、どちらの UI でも必要なので必ず行う。F3 は、利用者に見える害を除く最小（F3-min）だけを行い、そこで分岐する。

- **正本の API は UI に縛らない。** F1b で作る状態・出来事の列・命令は、Rust の型と、同じプロセスの中の購読（チャネルなど）で使えるようにする。Tauri のコマンドと `audio-session` の通知は、その上の薄い写しにする。GPUI の画面は、同じ API を直接購読する。
- **GPUI は別のブランチで試作する。** main は Tauri の構成のまま保つ。試作で確かめることは、Windows での安定性と配布、読み上げ、IME での日本語入力、日英の切り替え、VST のエディタの窓との共存、試験の手段（今のブラウザ試験の代わり）。
- **戻る道を残す。** GPUI で問題が出たら、試作のブランチを閉じ、main の Tauri の構成で F3-rest と F4 を続ける。F3-min までに入れたものは、どちらの道でもそのまま使える。
- **移る場合。** F3-rest と F4 は行わない。旧の通知と TypeScript の画面は、GPUI の画面に置き換わった時点で、まとめて片付ける。

## F2 の前に確かめること

- どの設定で起動するか（J-2）：`localStorage` を優先する bootstrap が F2 の時点で残る（`hooks/useAudioConfig.ts:76` 付近）。「最後に確定した設定（`last_audio_config.json`）で起動する」を保証するには、処理設定も含めて、起動時にどの値が使われるかを確かめてから保証する（17章）。

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

### 14.4 実プロセスの境界（Windows）

模擬の sidecar では確かめられない境界を、実際の Windows のプロセスで試す（`TESTING.md` の「実sidecarのプロセス境界と実機試験」の枠）。

- Job への割り当ての失敗（権限・既に別の Job に属する子など）。失敗時に子を kill し、新しい子を起動しない。
- stdout だけが閉じる子（stdin は開いたまま）。EOF の処理と `Reaped` の順序。
- パイプの詰まり（子が stdin を読まない）。writer の `try_send` と5秒の隔離。
- 親が終わったときの子孫の回収（Job の kill-on-drop）。
- 実際の WebView で、旧の `emit` と `invoke` の応答のどちらが先に届くかを測る（F1a-0 の互換試験の一部）。

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

### 15.2 第2回のレビュー（`8b87f2e2` への BLOCK）の指摘への対応

| ID | 指摘 | 解いた場所 | 解き方の要約 |
|---|---|---|---|
| Q-A1 | `Unreaped` から次の子を起動できる | 3.3、4.4、P12 | 通信の切断とプロセスの終了を別の状態に。Job の割り当ての成功を使い始める条件に。`Unconfirmed` の間は再利用も再生成も止め、要求は期限付き（10秒）で `engine_unconfirmed`。reaper が `Child`、親が Job とプロセスのハンドルを持つ |
| Q-A2 | ポンプの入力と終了条件が足りない | 4.1 | 接続・役割・段・トークンで照合。旧接続の入力は待ちを解かない。`Response`・`WriteDone`・EOF・`Reaped`・`Shutdown` の順序を固定 |
| Q-A3 | 保留に上限も期限もない | 4.2、4.5、4.7 | 受付の容量、保留の最大の待ち、命令全体の期限、過負荷の結果、制御用の予約枠、`try_send`、境目での期限確認、スキャンの分割 |
| Q-A4 | 開始の失敗と物理的な停止が結び付いていない | 4.3、5.2 | 音声が開いた可能性のある失敗はすべて清掃へ。拒否・欠落・予期しない応答は隔離。主と配信ミックスを別々に確認。B2 の期待値を一致させた |
| Q-S1 | 実行中に権限が失効しても確定する | 6.4、5.2 C4、11.4(8)、12.1 | 各命令が受付時の権限を持ち、取り消せない送信の直前・確定・応答のときに、同じ受付の境界で照合し直す。失効なら清掃 |
| Q-S2 | 回復の権限があとから発行される | 12.1 | 権限の基準を、障害の処理時ではなく、ストリームの確定時の `manual_epoch`・`latest_stop_seq` にする。R1 は権限の ID を必ず渡す。旧の呼び出しの扱いを決めた |
| Q-S3 | 古い同意 | 11.3 | 同意は親が発行するトークン（セッション・`StreamId`・条件の版・期限・1回だけ）。停止の直前に照合。元を止める前に能力を確認 |
| Q-S4 | 同じ接続の中の古い障害 | 7.2b | 障害に世代と side を付ける（D-5）。停止は `ended_stream_generation` で照合。番号のない `Error` は履歴のみ。`cause_request` はストリームごとに単一代入 |
| Q-C1 | F1a の互換を破る例（旧の通知の順序、`get_audio_state` の待ち） | 13章、互換の契約 8.1・8.2 | F1a では旧の通知を reader から直接 `emit`（結果の前）、`get_audio_state` は actor の列を通る読み取りのまま。Emitter と `SnapshotCell` は F1b の承認の差分（D-8、D-11）。`expectedState` の比較は旧の形に固定 |
| Q-C2 | 互換表の誤り・不足 | 互換の契約（改訂） | `lifecycle` と `engine_epoch` の説明を訂正。直接返るエラー、`access denied` の分岐、`Stopped` なしの `Error`、`Stop` の結果の無視、bootstrap の最初のフォールバック、`SetGlobalMute` を通らない開始、`prepare_update` の停止、`get_saved_audio_config` の直接の読み取りを追記 |
| Q-C3 | D-1〜D-7 の判断、追加の4つ | 互換の契約 8.2、13章 | D-1・D-7・D-2・D-3・D-4・D-5・D-6 に条件を追記。D-8〜D-14 を追加。受付順の記録（F1a-0）と勝敗の変更（F1b）を別の差分にした |
| Q-T1 | 合格表の第1〜5回の不足 | 合格の条件の表 H 群・U 群 | 不足の行を足した。「再現した順序をすべて入れた」を、照合した範囲に直した |
| Q-T2 | H25 が「あとで確かめる」を壊す | 11.5 | `answer: Heard|Later`。`Heard` は到達済み、`Later` は稼働中・障害なし（現行の挙動を保つ） |
| Q-T3 | 期待値の食い違い（B6、D7、B9、H1、H16、H22、H24、A6） | 合格の条件の表 | それぞれ直した |
| Q-F1 | F1a の分け方 | 13章 | F1a-0、F1a-1、F1a-2。`Superseded` は F1b の承認 |
| Q-F2 | F2 の購読を F3 で使い回す。F3 の最後の確認。F4 の範囲 | 13章 | 表に明記。再開の権限・実行は R1、予約は J-7 |
| Q-J1〜J6 | J の判断の反映 | 11.1、9.3、5.3、13章、16章 | J-1（確かめ始めた時点）、J-2（起動の設定の確認）、J-3（ウィンドウごと、クラッシュはメイン）、J-4（窓の時間と経路を記載）、J-5（F1a-0）、J-6（独立した文書の PR） |
| Q-P1 | 保存の確定と再送 | 8.3、8.4 | 保存を2段（中止できる段・できない段）に分け、`rename` に入った後は「確認中」を返す。B の保存と A の遅い完了、ID の再利用、64件の範囲、移行との排他を決めた |
| Q-P2 | 障害と処理設定の巻き戻し | 8.3、11.5 | 保存の直前に子へ `StreamState` を照会し、その応答を保存の境界に。遅れた適用は親が `Tracking` で最後まで追い、適用した接続・版に限って戻す |
| Q-P3 | 履歴と受け取りの確認 | 9.3 | 続けて適用できた位置だけを進める。確認の更新の場所、通知は `pending_notices`、64件・60秒・再起動の保証を決めた |
| Q-P4 | メーターと終了の原因 | 7.2、10章、合格の条件の表 | 組み合わせの行を追加。F7 は「測る遅れと上限」に直した。原因は単一代入 |
| Q-P5 | 実行の境界と #806 の画面の合格 | 14.4、合格の条件の表 U 群 | 実プロセスの試験と、F2 の画面の合格の条件を足した |
| Q-P6 | P3：定義 | 2章、11.3 | P1〜P7 を書いた。`CancelTarget` と `cancel_trial` の対応、再試行と新規の違いを定義した |

### 15.3 第3回のレビュー（`21968a8b`。F1a-0 は着手してよい、全体の承認は保留）への対応

| ID | 指摘 | 解いた場所 | 解き方の要約 |
|---|---|---|---|
| R3-A1 | 読み取りは今のロックの取り方のまま（`get_audio_state`・`get_saved_audio_config`） | 互換の契約 1章・3.4・8.1、13.1(4) | F1a-0 は同じ `Mutex` の経路。actor 後も同じ待ちの境界。K2・K10 は `Start` がロックを取ってから読む |
| R3-A2 | reader の `emit` だけでは順序の契約全体は保てない | 互換の契約 5章・8.1(3)、13.1(5) | `Conditions::dispatch` の前後と `emitter` の Mutex を含めて、今の経路のまま。F1a-1 で場所を変えるなら2つの順序を固定。W5 は Rust の順序と WebView の順序を分けて記録。`expectedState` は F1a-0 で完全一致 |
| R3-A3 | `audio_frontend_bootstrap` の記述の誤り | 互換の契約 3.4、K8a〜K8d | 4つの場合に分けた |
| R3-A4 | `prepare_update` | 互換の契約 3.4・5章、K9a〜K9e | 場合ごとに分けた（主が止まって配信ミックスだけ失敗する場合を含む） |
| R3-A5 | `Start` の事前の検証の `Error` に `Stopped` が付かない／`initial_controls` つきの開始 | 設計 F-5、S3、互換の契約 3.1 | 本文・表・S3 に明記 |
| R3-A6 | `localize_audio_error` の範囲、`streamFailed`、メーターのワイヤ | 互換の契約 3.1・3.4・6章 | 親の側のエラーを含める、camelCase、`IPC:`・`kind/data`・世代の省略 |
| R3-A7 | K 群 | 合格の条件の表 K 群 | K3 を F1b へ、K2・K7・K8・K9・K10・K11 を直し、K12〜K16 を足した |
| R3-A8 | F1a-0 の実装の指針 | 設計 13.1 | `AudioControl`・`Admission`・`Pending`・入口の照合・試験・完了の条件 |
| R3-A9 | P3 | 設計の表題、3.1、互換の契約の章の参照 | 表題を第3版に、受信箱の記述を2本に、参照を 8.2 に |
| R3-B | F1a-1 の前に解くもの | 設計 18.1、合格の表 | PRE-F1a1-1〜8。D7・B6・B18・D8 は今直した |
| R3-C | F1b の前に解くもの | 設計 18.2 | PRE-F1b-1〜11 |
| R3-J | J-7〜J-10、D-13、J-2 | 設計 16.1 | Sol の推奨どおりに決定。J-8 の「30秒で停止を捨てる」はやめた |

## 16. 判断が要る点

### 16.1 決定済み（利用者・統括）

- **J-1（利用者の決定）：** 戻す基準は、最初に実際の置き換えへ進んだ時点（「確かめ始めた時点」）。同意を取り直したら、新たに停止を承認された対象から復元点を作る。11.1。
- **J-2（利用者の決定）：** 確認は捨てて、最後に保存した設定で起動する。F2 を終える前に、次を確かめる（PRE-F1b-10）。現行は、Rust の warmup が保存のファイルを読み、フロントは `localStorage` を先に読む（`hooks/useAudioConfig.ts:76` 付近）。保存された既定以外の入力には、明示の開始を求める経路がある（`audio.rs:2849-2859`）。保存のファイルと画面の設定が違う場合、既定以外の入力の場合、処理設定の保存先も含めて、再起動の後にどの値を使うかを H20 で固定してから保証する。
- **J-3（利用者の決定）：** ウィンドウごとに1回。状態はウィンドウごとに配り、クラッシュの画面を出すのは `main` のウィンドウだけ。9.3。
- **J-4（利用者の決定）：** 開始の10秒を保つ。遅れて音が出る窓は、今回は扱わない。時間と経路は 5.3 に記載し、別の Issue（未起票）で扱う。
- **J-5（統括の決定）：** F1a を F1a-0 から始める。13章、13.1。
- **J-6（統括の決定）：** #827 は、今のワイヤ形式に合わせる独立した文書の修正にする。F1b を待たない。この PR では、13章の計画への記載だけ。メーターのほかに、`Started`、`Stopped`、`ended_stream_generation`、仕様書の JSON-RPC の形式と実際の行のプロトコルの範囲も、その PR で照らし合わせる。
- **J-7（決定）：** 自動の再開の予約（待ち時間。2秒・4秒・6秒）は、**WebView に残す**。親へ移すのは、権限と実行（`recover { authority_id }`）。R1 の契約は `recover { authority_id }` に一本化し、12.3 の `origin` だけの経路は作らない。合格の表の G4・G5 も合わせた。F4 で再検討する。
- **J-8（決定）：** 4.7 の値（終わっていない要求の全体 256件、保留 60秒、命令全体 90秒／120秒、`Unconfirmed` の失敗まで10秒）は、仮の値として妥当。**「30秒で停止を捨てる」仕様はやめる。停止は捨てずに実行する。** 満杯のときの停止と完了の配送、終わっていない要求の全体の上限、期限の起点（受付の時刻）は 4.7 で決めた。レーンの分割は PRE-F1a1-2 の宿題。値は F1a-1 で測って見直す。
- **J-9（決定）：** `Unconfirmed` の間、**10秒で `engine_unconfirmed`** を返す。**遅れて終了を確かめられたら、「操作できる状態に戻りました」を表示する**（履歴 `process_confirmed`）。再試行を繰り返しても確かめられないときの案内（推奨：3回続けたら「Auralyn を再起動してください」）の文言と回数は、F1a-1 の前に決める（PRE-F1a1-8）。
- **J-10（決定）：** `PersistPending`（確認中）の表示は「**保存を確認しています**」。再送は照会に合流させる。画面を閉じて開き直した場合と、ワーカーの決着を確かめられない場合は PRE-F1b-4 で扱う。
- **J-11（利用者の決定）：** F2 までは必ず行う。F3 は、競合の害が利用者に見えるもの（稼働表示、クラッシュ画面と VST の一覧、メーター）だけを移す F3-min に縮める。そこで UI の構成を分岐させ、GPUI を別のブランチで試す。問題がなければ移り、問題が出たら Tauri の構成に戻って F3-rest と F4 を続ける。13章、13.2。
- **J-12（利用者の決定、2026-11-21）：** PRE-F1a1-4（D-10）。writer のスレッドの分離は F1a-1 に入れ、**5秒での隔離は F1b まで延ばす**。あわせて、`busy_overloaded` の拒否と、停止を受付の順を越えて先に実行することも、F1b で D-9・D-10 の承認とともに有効にする。18.3。
- **J-13（利用者の決定、2026-11-21）：** PRE-F1a1-8。`engine_unconfirmed` を3回続けて返したら、「音声エンジンを終了できません。Auralyn を終了して、起動し直してください」を返す。18.3。
- **D-13（決定）：** 承認する。**承認の条件は、Windows の実プロセスでの確認**（Job の作成・割り当て・待ちの失敗、EOF だけが来る場合、遅れた終了の確認。W1〜W4、14.4）。確認の結果を見てから、F1a-1 のマージを承認する。

### 16.2 新しく出た、利用者の判断が要る点

この版では、新しく利用者の判断が要る点はない。J-7〜J-10 と D-13 は、独立レビュー（Sol）の推奨どおりに決定した。決めきれない設計の項目は、18章の宿題に記録した。

## 17. 確かめていないこと

- 実機・実音声・長時間運転での動作。
- `emit` の呼び出しの順序が、WebView での到着順に一致するか（コードの順序だけを確かめた）。F1a-0 の互換試験で実測する（14.4）。
- 処理設定（ノイズ低減・内蔵エフェクト）が、適用時に別のファイルへ保存されるか。J-2 の保証の前に確かめる。
- 移行が書く設定のファイルの範囲の全体（`migration.rs:688` 付近に `last_audio_config.json` が含まれることだけを確かめた）。
- Windows の Job Object の kill-on-drop が、孫のプロセスまで確実に終わらせるか。Job の割り当てに失敗する条件。
- 複数のウィンドウ（メイン以外で `audio-*` を購読するもの）の有無。
- 子の `auto_gain` の `Status` が、`StreamState`（世代・稼働・障害）の代用になるか。
- 4.7 の値（容量・期限）の妥当性。
- reader が `LevelMeter` を畳む処理で、10,000行/秒の集中時に、応答・EOF の処理が遅れる時間（上限の目標は、14章の模擬で測って決める）。
- F1a-0 の試験の継ぎ目（既存の `AudioHost` の試験が使う差し込み）で、K 群のすべての行（特に、`Start` がロックを持っている間の読み取り）を出せるか。足りない場合の最小の差し込みの形は、F1a-0 の着手時に確かめる。
- `audio_frontend_bootstrap` の4つの場合を、実際の起動順序で再現できるか（K8a〜K8d の手順）。

## 18. 段階の前に解く項目（第3回のレビューの B 節・C 節）

各段階の設計の宿題。**この PR（F0）で解いたもの**と、**その段階の前に解くもの（宿題）**を分けて記録する。宿題は、その段階の PR で解き、その段階の合格の条件にする。

### 18.1 F1a-1 の前に解く（PRE-F1a1-n）

| ID | 項目 | この PR で解いたこと | 宿題（F1a-1 の前に決める） |
|---|---|---|---|
| PRE-F1a1-1 | 終了を確かめていない子から次へ進めない | 5.3 の「終了の確認」を `Reaped` のみにした。`Unconfirmed` は確認ではない。遅れた `Reaped` で失敗の要求を復活させない。合格の表の D7・B9・B18 を直した | (1) 生成したすべてのプロセスに、待つ役（reaper）を決める。Job の作成・割り当てに失敗した分岐でも reaper を起動する。(2) 終了の証拠が得られたときだけ、同じ役割の子を生成し直す。(3) EOF だけが来て子が生きている場合は隔離する。(4) 待つのに失敗したら、もう一度確かめる。(5) 子を実行させる前に Job へ割り当てる方式の選定（停止状態での作成と再開、など）。W1・W4 で確かめる |
| PRE-F1a1-2 | 制御の受信箱が満杯のとき、終了の確認や停止を取り残す | 終わっていない要求の全体の上限（256件）、停止を期限で捨てない、`Shutdown` で2つの受信箱と `held` をすべて完了する（4.7） | (1) レーンの分割：`Response`・`Eof`・`ReaderDone`・`Reaped`・`Shutdown`・`Deadline` は専用の経路。`Wire(Event)` は、有界で、重要でないものは畳む。(2) ポンプが通常の命令を `held` へ移し続けても、通常の命令にも処理の機会を割り当てる（公平性）。(3) 満杯のときの配送の保証を、模擬の試験で固定 |
| PRE-F1a1-3 | ポンプの照合のキー | `ConnId` を全役割で一意に（0章）、入力を `(role, conn)` で識別、`WriteDone`・`Deadline` を段のトークンでも照合、`ReaderDone`・`ReaderAbandoned` を入力の型に（3.1、4.1） | 型の定義と、打ち切り後の旧 reader の入力の無効化（`reader_epoch`）の実装。`label_gen`（旧 `engine_generation`）との対応の試験 |
| PRE-F1a1-4 | D-10：書き込みの5秒での隔離 | 基準では書き込みの詰まりに上限がないことを、互換の契約に記載。D-10 の承認の範囲に、過負荷の拒否と停止を優先する実行を含めた | 推奨：writer スレッドの分離は F1a-1 に入れ、**5秒での隔離（挙動の変更）は F1b まで延ばす**。決定は F1a-1 の前に。W3・B27 の期待値を、決定に合わせる |
| PRE-F1a1-5 | W 群の分割と、足りない行 | W2 を3つに分割、W4 を正常な終了と強制の終了に分割、制御の枠が満杯の場合・保存のワーカーが止まる場合を足した | 実プロセスの試験の手順書（`TESTING.md` への追記は F1a-1 の PR） |
| PRE-F1a1-6 | 合格の表の期待値の食い違い | D7、B6（`Failed` と `Timeout` の食い違い）、B18（再開の対象）、D8（F1a での `Superseded`）を直した | — |
| PRE-F1a1-7 | J-8 の値と起点 | 全体の上限、停止を捨てない、起点は受付の時刻（4.7） | 値は F1a-1 で測って見直す |
| PRE-F1a1-8 | J-9 の文言と回数 | 10秒で `engine_unconfirmed`、遅れて確認できたら復帰を表示（J-9） | 繰り返し失敗したときの案内の文言と回数（推奨：3回）。`COPY_GUIDELINES` に従う |

**解いた内容は 18.3。** F1a-1 の PR は、18.3 を前提に実装する。

### 18.3 PRE-F1a1 の解（F1a-1 の実装の前提）

F1a-0 のマージ（`f2ae2c9d`）の後に決めた。【事実】はコードで確かめたこと、【設計】は F1a-1 で作るもの。

#### PRE-F1a1-1 子の寿命：reaper・作り直しの条件・Job の割り当て

【事実】
- 音声の接続の子は2種類。主（`spawn_engine_process`、`audio.rs:700-724`）と、配信ミックス（同じ関数で `--post-mix-worker`）。
- Job の割り当ては、子を作った後に行い、結果を `let _ =` で捨てている（`audio.rs:776-780`）。作り直しの判断は `try_wait()` で、`Ok(Some)` と `Err` のどちらでも作り直す（`audio.rs:735-763`）。
- 子は、起動してから最初の命令を読むまで、`Engine::new()` と `run_loop()` に入るだけで、機器を開く処理や子プロセスの生成は、命令を受けてから行う（`bin/audio_engine.rs:252-265`。`--scan` の孫は `devices.rs:128` で、命令を受けてから作る）。**F1a-1 の最初の試験で、この前提を固定する**（最初の命令までに子プロセスを作らないこと）。
- 音声の接続以外にも、子を作って Job の割り当ての結果を捨てる箇所がある（`child_process.rs:56-64` のスキャナー、`temporary_session.rs`、エディタの環境の確認）。**F1a-1 の範囲外**。同じ穴なので、別の Issue に記録する。

【設計】
1. **reaper はすべての分岐で起動する。** `Spawn` は、子を作った直後に、**ほかの何よりも先に** reaper を起動し、`Child` を渡す。Job の作成の失敗、割り当ての失敗、stdin・stdout の取り出しの失敗、reader・writer の起動の失敗の、どの分岐でも、reaper が先に動いている。reaper のスレッドを作れなかった場合だけは、その場で `kill` と上限2秒の `wait` を同期で行い、確かめられなければ `Unconfirmed` にする。
2. **作り直しの条件は、終了の証拠があることだけ。** 証拠は、reaper が同じ `Child` から得た終了の状態（`Reaped`）だけ。`Unconfirmed`、`wait()` の失敗、EOF は、証拠ではない。今の `try_wait()` の `Err` での作り直しは、F1a-1 でやめる（D-13 の範囲）。
3. **EOF だけが来て、子が生きている場合は隔離する。** `comm = Detached` にし、`Teardown`（意図 = `quarantine_eof_alive`）へ進む。`Reaped` を観測するまで、同じ役割の子を作らない（W2a〜W2c）。今は、`try_wait()` が `Ok(None)` を返すので、閉じた stdout の子へ命令を送り続け、応答の期限で失敗する。
4. **待つのに失敗したら、もう一度確かめる。** reaper は、`wait()` が失敗したら `ReapFailed{conn}` を積み（`Unconfirmed` のまま。履歴は1回だけ）、2秒後に `wait()` をやり直す。actor は、2秒ごとの `TerminateProcess` の再実行（4.4）を続ける。
5. **Job の割り当ての方式：作った直後、最初の命令の前に割り当てる。** 割り当てに成功するまで、その接続の stdin へ何も書かない（writer を起動しない）。失敗したら、その子を `kill` し、reaper の `Reaped` を待って、`Spawn` を失敗にする（「開始していません」。D-13）。Job の作成に失敗した場合も同じ。
   - 停止の状態で作って再開する方式と、作成と同時に Job へ入れる方式（`PROC_THREAD_ATTRIBUTE_JOB_LIST`）は、どちらも、std の `Command` ではなく、自前の `CreateProcessW` が要る。子が最初の命令まで孫を作らないので、作った直後の割り当てで、孫まで Job に入る。この前提が崩れたら（子が起動時に孫を作るように変わったら）、方式を見直す。
   - 残る窓：作ってから割り当てるまでの間に、親が強制終了された場合、子は Job に入らず残る。子は stdin の EOF で終わる（`run_loop` が stdin を読めなくなる）ので、残り続けはしない。W4b で確かめる。

#### PRE-F1a1-2 受信箱のレーンと、満杯のときの配送

順序の制約：reader が読んだ `Response`・`Event`・`Eof`・`ReaderDone` は、**同じ接続の中で、子の出力の順を保つ**（4.1 の順序の固定 1）。したがって、`Response` と `Event` を別のレーンに分けない。

【設計】レーンは4つ。

| レーン | 入力 | 上限と満杯のとき |
|---|---|---|
| **接続ごとの wire**（接続ごとに1本） | `Response`、`Event`、`Eof`、`ReaderDone` | 有界（接続ごとに 1024 件）。**重要でない `Event`**（`audio-loudness`、`voice-check-envelope`、`audio-processing-health`、`audio-channel-scan` の途中経過）は、reader の側で種類ごとに最新の1件だけを持ち、レーンに空きがあるときに積む（畳む）。**それ以外**（`Response`、`Started`、`Stopped`、`Error`、障害、mixing の失敗、エディタの開閉、`Eof`、`ReaderDone`）は、空きを待って積む（reader が待つ。actor は wire を常に読むので、待ちは解ける）。`LevelMeter` は積まない（10章） |
| **寿命**（1本） | `Reaped`、`ReapFailed`、`WriteDone`、`PersistDone`、`Deadline`、`ReaderAbandoned`、`Shutdown` | 上限を設けない。**生産者の側で数が有界であることを、型と試験で保証する**：`Reaped`・`ReaderAbandoned` は接続ごとに1件、`WriteDone` は writer の列（8件）以下、`Deadline` は生きている段のトークンの数以下、`PersistDone` は保存のワーカーの列以下、`Shutdown` は1件 |
| **停止**（1枠） | 停止系の `Command`（`StopAll`、`StopForMaintenance`、アプリの終了） | 列ではなく、1つの枠。続けて来た停止は、`latest_stop_seq` を進め、返信先を枠の中のリストに足す（畳む）。1回の停止の実行の結果を、枠の中のすべての返信先へ1回ずつ返す。溢れない |
| **通常**（1本） | その他の `Command` | 4.7 の全体の上限（256件）に数える |

actor が読む順：`Shutdown` → 寿命 → wire（接続の間は順番に回す）→ 停止の枠 → `held` → 通常。

**公平性：** 停止を1回実行した後、`held` か通常に命令があれば、次の停止を実行する前に、その1件を実行する。停止は畳まれるので、停止の連打で通常の命令が止まり続けることはない。停止より古い開始は、S0 の照合で `Superseded` になるので、この1件はすぐ終わる（F1b から。F1a は下の注を参照）。

**満杯のときの保証（模擬の試験で固定する）：** 通常のレーンが上限まで埋まり、wire に重要でない `Event` が集中している状態で、(a) 停止が実行されて結果を返す、(b) `Eof`・`Reaped` が届いて接続の終了が確定する、(c) `Shutdown` で2つの受信箱と `held` と停止の枠の要求が、すべて1回ずつ完了する。

**F1a での適用の範囲（D-10 の決定に合わせる。J-12）：** レーンの型と配送は F1a-1 で作り、試験で固定する。ただし、利用者から見た結果を変える次の2つは、**F1b で D-9・D-10 の承認とともに有効にする**：通常のレーンの上限を超えたときの `busy_overloaded` の拒否、停止を先に実行すること（受付の順を越えて停止を勝たせること）。F1a の間は、上限は数えて記録するだけで拒否せず、命令は受付の順に実行する。

#### PRE-F1a1-3 照合のキーの型

【設計】
```rust
struct ConnId(u64);           // AudioControl が採る。役割をまたいで一意で、使い回さない
enum Role { Main, PostMix }
struct ConnKey { role: Role, conn: ConnId }
struct ReaderEpoch(u32);      // 接続ごと。ReaderAbandoned で1つ進める
struct StageToken(u64);       // 段ごとに採る。actor の中で一意
struct DeadlineToken { stage: StageToken, kind: DeadlineKind }
```
- reader が積む入力は、すべて `(ConnKey, ReaderEpoch)` を持つ。actor は、接続の今の `ReaderEpoch` と違う入力を、状態に作用させずに捨てる（履歴に1回だけ残す）。打ち切りの後に、詰まっていた旧 reader が遅れて積んだ行は、これで無効になる。
- `WriteDone` は `(ConnKey, StageToken)`、`Deadline` は `DeadlineToken` で照合する（4.1）。
- **`label_gen` との対応：** 今の `engine_generation`（`audio.rs:789`）は、`stream_generation` の表示の `"{engine}:{child}"` の前半として、旧の通知に出ている（F1a-0 で固定済み）。F1a-1 では、名前を `label_gen` に変え、**主の接続を作るたびに1つ進める**（今と同じ）。`ConnId` は配信ミックスでも進むので、`label_gen` とは別の数にする。試験：主→配信ミックス→主の順に作ったとき、`ConnId` は 1・2・3、`label_gen` は 1・1・2 で、旧の通知の `stream_generation` の形が変わらない。

#### PRE-F1a1-4 書き込みの詰まり（D-10。J-12 で決定）

【設計】F1a-1 では、writer のスレッドを分けるが、**挙動は今と同じ（書き込みの詰まりに上限を設けず、接続を隔離しない）**。
- actor は writer へ `try_send` する。writer の列（8件）が満杯なら、その行を actor の側の接続ごとの待ちの列に置き、`WriteDone` を受けるたびに1件ずつ writer へ送る。actor はブロックしない。この待ちの列は、4.7 の全体の上限（数えるだけ）に含まれる。
- 応答の期限（今の10秒など）は、**`WriteDone(Ok)` を受けてから**数える。今も、書き込みと flush が終わってから期限の待ちに入る（互換の契約 D-10 の「基準」）。したがって、詰まった子に対する命令は、今と同じく終わらない。actor 自体は止まらないので、他の接続（配信ミックス）と、寿命の入力の処理は続く。
- 5秒での隔離（`quarantine_write_stall`）は、F1b で D-10 の承認とともに入れる。
- 合格の表：W3 は「F1a-1：actor がブロックしない。他の接続と `Shutdown` が処理される。隔離はしない」、B27 は「F1a-1：`try_send` の失敗で actor の側の列に置く。隔離はしない」に合わせる。

#### PRE-F1a1-5 実プロセスの試験の手順書

F1a-1 の PR で `TESTING.md` の「実sidecarのプロセス境界と実機試験」に、W1・W2a・W2b・W2c・W3・W4a・W4b の手順を足す。それぞれ、(1) 子の状態の作り方（Job への割り当ての失敗は、子を先に別の Job へ入れて作る、など）、(2) 観測する値（`Reaped` の有無、子と孫の PID の生死、履歴）、(3) 合否、を書く。D-13 の承認の条件なので、F1a-1 のマージの前に、結果を PR に記録する。

#### PRE-F1a1-6

済み（18.1）。

#### PRE-F1a1-7 値の測り方

F1a-1 の模擬の試験と、W 群の実測で、次を記録する。終わっていない要求の数の最大、`held` の待ち時間の最大、wire のレーンの深さの最大（接続ごと）、寿命のレーンの深さの最大、`Unconfirmed` が解けるまでの時間。値の見直しは F1b の前に行う（F1a の間は、上限で拒否しないため）。

#### PRE-F1a1-8 繰り返しの案内（J-9 の補足。J-13 で決定）

- `engine_unconfirmed` を**3回続けて**返したら、3回目の文言を次にする。日本語：「音声エンジンを終了できません。Auralyn を終了して、起動し直してください」。英語：「The audio engine could not be stopped. Quit Auralyn and open it again.」
- 回数は、プロセスごとに数える。終了を確かめられたら（`process_confirmed`）、0 に戻す。4回目以降も、同じ文言を返す。
- 1・2回目は今の文言（「音声エンジンの終了を確認できません。しばらくしてからもう一度お試しください」）のまま。
- 文言は `COPY_GUIDELINES` に従い、日英の両方を F1a-1 の PR で足す。

### 18.2 F1b の前に解く（PRE-F1b-n）

| ID | 項目 | この PR で解いたこと | 宿題（F1b の前に決める。導入する段階の合格の条件にする） |
|---|---|---|---|
| PRE-F1b-1 | 権限の読み取りと、操作の確定が別々に起きる | 6.4 の照合の場所の列挙 | (1) 送ってよいと決めた時点と、状態の確定の順序を、受付と共通の境界で決め、I/O はその外で進める。(2) 次の3つを別々に照合する：置き換える前の対象、止めた後の復元点、新しく開いた清掃の対象（復元の `target` を「今のストリーム」と一致させると、正常な復元まで拒む）。(3) 権限が失効した後も、自分で開いた音声を片付ける権限を持たせる。(4) 回復の権限は、確定を許した操作の世代を引き継ぐ |
| PRE-F1b-2 | 開始の失敗の清掃と、古い障害の扱い | 5.2 の矛盾（`Started` の後の `Error`）を直し、`Response` の前後と、対象の試行・ストリームの単位の判定を明記した | (1) S4 のタイムアウトですぐ応答する場合と、通常の失敗で主と配信ミックスの清掃を待つ場合の区別を、手順に落とす。(2) F1b から R1 までは、旧の `audio-stream-error` が旧のフロントの再開を引き起こす。古い障害を旧の通知へ流す条件を、D-5・D-11 と合わせて決める |
| PRE-F1b-3 | 同意と取り消し（F2） | `CancelTarget` と `cancel_trial` の対応（11.3） | (1) 最初の `needs_consent` が結び付ける `session_id` の作成・返却・破棄。確認を待つセッションの、期限切れと閉じる操作での解放。(2) 同意を使うこと、復元点を記録すること、停止の送信を許すことの境界。(3) 取り消しの印は、対象として実行中の要求だけに付ける（同じセッションの復元を拒まない）。(4) 復元は、1つの取り消しの要求から進め、二重・一部だけ止まった場合も、同じ記録で続きから行う |
| PRE-F1b-4 | 保存の「確認中」と、移行の排他 | 保存の2段、`ConfigIoLease`（8.3） | (1) すべての書き手に同じ排他をかける（`migration.rs:475`、`:512` の別の書き込みの経路を含む）。(2) 先に始まった保存の決着がつくまで、移行へ進まない。(3) 決着していない要求は、64件の完了の履歴とは別に持つ。(4) ワーカー・通知の経路を失ったときの、期限の後も照会できる状態と、利用者の復旧の動線。(5) ファイルの結果を確かめるまで、書き直しを許さない。(6) 再送は、元の処理へ合流 |
| PRE-F1b-5 | `StreamState` と処理設定の確定の条件 | 保存の直前の照会（8.3）、追跡（11.5） | (1) 基準の `auto_gain::Snapshot` には世代がないので、子が対象の稼働の世代と障害を採った時点を境界にする。(2) 応答を受けた親で、停止・取り消しと対象を照合し直す。配信ミックスの状態も決める。(3) `pending` の間の旧値を、終わったことの証拠にしない。受付の側の改訂の番号と、実際の適用の完了を区別する。(4) 同じ子でのストリームの切り替え、5分後に反映される場合を、試験する。(5) 子が期限の後の適用を拒むか、決着するまで追跡を引き継ぐことの保証。(6) 保存の結果が未決のあいだに障害が起きた場合の owner と回復の権限（`PersistDone` の成功・失敗の両方） |
| PRE-F1b-6 | 履歴の欠番を回収できないと、連続の位置が止まる | 連続して適用した位置だけ進める（9.3） | (1) 再同期の後の開始位置を、サーバーが返す。クライアントは状態と位置を一緒に更新する。(2) リロードのときの `clientId` の扱い。(3) 通知を閉じる要求が失敗したときの再試行。(4) 通知の保持の上限とまとめ方 |
| PRE-F1b-7 | H・U・E 群の行の分割 | — | H3（新しい ID の省略と、不一致を分ける）、H24b（保存の成功・失敗・未決を分ける）、H31・H33a・H39（結果の違う入力を独立した行に）、U1（標準のケーブル、A/B 系、対が分からない機器）、U2（既定に追従する経路と、音楽鑑賞で明示的に選んだ聴く機器。既定の変更と、選んだ機器が消える場合）、U3・U4（機器の欄のアクセシブル名、音楽・声ごとの切り替え）、U5（再試行と、「確認中」からの復帰）、E6・E10（未解決の通知の再表示と、閉じた通知の抑止） |
| PRE-F1b-8 | メーターと終了の原因 | — | F14（少しの非ゼロの間に長い無通知をはさんだ場合、連続を切る間隔を決めるか、期待値を明示して承認）、F7（100ms は測定の目標か合格の上限かを統一）、D10（最初に受け付けた要求が拒まれ、後の操作だけが実際に音声を止める場合。原因の ID は、終わらせる操作を許した時点で記録） |
| PRE-F1b-9 | D-1〜D-14 の判断 | D-1（約32秒は `Reaped` を確かめられた場合）、D-2・D-8（既存の待ちを外す変更と、新しい `get_audio_session` を区別）、D-10・D-13 を互換の契約に反映 | D-3・D-4（タイマーの起点、`BestEffort`／`Required` の結果の固定）。D-5・D-6・D-11・D-12（atomic の印だけで元の可変長のエラーの詳細をログに残す方法。旧の通知からの再開と、複数の障害が重なるときの保持）。D-9（通常の Start A → 手動の Start B でも A を失効させるなら、停止との競合とは別の挙動として明記）。D-14（D-5 と重なる世代・side と、処理設定の適用の期限を分ける。適用の期限は、子が実際に値を反映する時点で効いてはじめて、遅れた適用を防げる） |
| PRE-F1b-10 | J-2：起動の設定 | 決定を 16.1 に記載 | F2 を終える前に、H20 で、再起動の後にどの値を使うかを固定する（保存のファイルと画面の設定が違う場合、既定以外の入力の場合、処理設定の保存先を含む） |
| PRE-F1b-11 | R1 の契約の一本化 | `recover { authority_id }` に一本化、12.3 を直し、G4・G5 を合わせた | — |

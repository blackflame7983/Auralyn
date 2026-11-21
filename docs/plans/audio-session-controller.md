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

**この章から 4.7 までの構成（actor・受信箱・reader／writer／reaper・Emitter・`SnapshotCell`）は、F1b-0 以降の設計である（J-14）。F1a-1 は、今の `Mutex<AudioHost>` と実行の経路を保ち、子のプロセスの寿命だけを直す（18.3）。段階の表記がない記述は、F1b-0 で入れるものを述べる。**

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

**F1a（F1a-0・F1a-1）では、旧の境界を保つ：** `get_audio_state` と `get_saved_audio_config` は、今の `state.lock()` を取ってから読む（`Start` がロックを持っていれば、その完了後の値を返す。13.1 の4）。**F1b-0 で actor へ移した後も、同じ待ちの境界を保つ：** `get_audio_state` は、受付順の読み取りの命令として actor の列を通り、先行する命令の完了後の値を返す。`get_saved_audio_config` は、今と同じく、ファイルを直接読む（欠損・破損・移行の後の結果を変えない）。

ただし `auto_gain` の `Status` のように、子へ問い合わせる読み取りは、今は IPC で待つ（F-15）。F1a は今のまま（ロックを取って IPC で待つ）。F1b-0 で actor へ移すときに、actor の「1段の待ち」に入れる。F1b で、ストリームの状態（動作中・障害）をスナップショットの項目にして、問い合わせを減らす。

### 3.3 子プロセスの起動・再起動（接続の生成）

起動は `Spawn` の状態機械で行う。接続の世代の更新、起動時の IPC（ピーク保護・true-peak の引き継ぎ、F-12）、旧 reader の終了処理まで含める。

1. 旧接続があれば、`Teardown`（4.4）を先に終える。終わるまで、新しい接続は作らない。F1a-1 は、`Teardown` の代わりに、主の `AudioHost` の役割ごとの記録 `retired` の確認（18.3 の作り直しの条件）を行う。
2. 子を**停止の状態で**作り（`CREATE_SUSPENDED`）、Job Object に割り当ててから再開する。**割り当ての成功が、その接続を使い始める条件**。Job の作成・割り当て・再開のどれかが失敗したら、ただちにその子を `kill` し、終了を確かめるまで、新しい子を起動せず、結果を失敗にする（今は子を作った後に割り当て、結果を `let _ =` で捨てている：`audio.rs:776-780`）。**F1a-1** は、ここまでを今の `Mutex` の下で、同期の上限つきの待ち（最大2秒。18.3）で行い、reader は今のまま。**F1b-0** で、`ConnId` を採り、終了の確認を reaper に任せ、成功したら reader・writer・reaper を起動する。
3. 引き継ぎの IPC を、段として順に送る。1つ失敗したら、その接続を `Teardown` し、結果は「開始していません」の失敗にする。
4. 機器のスキャンは、今の `DeviceScanTicket` の方式（`audio.rs:38-48`）をそのまま、1段の待ちとして扱う。接続が変わったら、チケットは古いものとして捨てる。

## 4. actor の段階の状態機械

**この章（4.1〜4.7）は F1b-0 以降の設計である（J-14）。F1a-1 は、actor・受信箱・writer・reaper を入れず、今の `Mutex` の下で 18.3 の範囲だけを行う。F1b-0 の宿題は PRE-F1b-12。**

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

**F1a-1 と F1b-0 の分担：** この節の `ConnectionRecord`・reaper・`Reaped`・`Teardown` は F1b-0 の設計。F1a-1 は reaper を作らず、`kill()` の後の `try_wait()`（50ms 間隔、最大2秒）で終了を確かめる。終わらない子と Job は、主の `AudioHost` の役割ごとの記録 `retired` に残し、同じ役割の作り直しは、最初の `kill()` から10秒の期限で `engine_unconfirmed` にする。アプリの終了の回収は Job に任せ（`Drop` が走ることは保証しない。走れば共通の2秒）、`prepare_update` は終わらない子が残れば `engine_unconfirmed`（18.3）。停止のまま残る子（J-15）と、Job に入らず終わらなかった子は、自動では回収せず、回復は Windows の再起動とする（回収の保証は Job に入った子に限る）。`try_wait()` の `Err` は終了の証拠ではない。EOF の後の自動の隔離（W2a）、`process_unconfirmed`・`process_confirmed` の履歴、復帰の表示は F1b-0・F1b。

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
- アプリの終了の回収は、Job の kill-on-close に任せる（F1a-1。`Drop` が走ることは保証しない）。`Drop` が走った場合だけ、actor の外で、共通の期限2秒で `kill()` と確認を行い、終了しなければそのままアプリを終える。この上限は F1a-1 で入れる（今は上限なし）。F1b-0 では `Shutdown` 入力を `Teardown` が受ける。

### 4.5 stdin の書き込みの上限

**F1b-0 の設計（D-10。J-12・J-14）。** F1a-1 は、書き込みを今のまま同期で行う。writer のスレッドの分離と、5秒での隔離は、F1b-0 で D-10 の承認とともに入れる。

- 書き込みは writer スレッドが行う（F-14 の先例）。actor は `WriteLine{conn, token, json}` を送るだけ。writer への列は有界（8件）。溢れたら、その接続を隔離する。
- writer が `WriteDone{token}` を5秒以内に返さなければ（パイプが満杯 = 子が読んでいない）、接続を隔離する。隔離の手順は `Teardown`（意図 = `quarantine_write_stall`）。writer への送信が `try_send` で満杯のときも同じ。
- 書き込みの失敗（`BrokenPipe` など）は、今と同様に、接続を終了する。`audio-error` の通知（`audio.rs:1178`）は互換のため残す。

### 4.6 移す入口の一覧

「actor の上」は、`AudioControl::run(|host| …)` で actor スレッドの上で実行すること。「受付」は `Admission` を通ること。この表の「移し先」は **F1b-0** で移す先である（F1a-0 は入口を `AudioControl` に一本化して受付を記録するだけ、F1a-1 は入口を変えない。13章）。

| 入口 | 今 | 移し先 |
|---|---|---|
| `commands/audio.rs` の全コマンド | `state.lock()`（`run_blocking`） | F1a は今の `state.lock()` のまま。F1b-0 で、受付 → actor。`get_audio_state` は、F1b-0 は列を通る読み取り、F1b から `SnapshotCell`。`get_saved_audio_config` はファイルを直接読むまま |
| `start_audio`、`restart_audio_engine`、`stop_audio` | 同上。`stop_audio` は `interrupt_restore()` で先に登録（F-11） | 受付（`ManualStart`／`Restart`／`StopAll`）。`interrupt_restore` は `Admission` に統合 |
| `commands/voice_check.rs`、`commands/profiles.rs`、`commands/bundles.rs:2011` | `state.lock()` | `Rpc` または「複数の転送の列」 |
| warmup（`lib.rs:385-392`）、`audio_frontend_bootstrap` | スレッドで `lock` → `warmup()` | 受付（`WarmupStart`。`PersistPolicy::BestEffort`）。frontend の到着で取り消す規則は `frontend_bootstrap` をそのまま移す |
| モード VST のスケジューラ（`mode_vst.rs:526-535`） | 10ms ごとに `lock` → `poll_mode_vst` | actor の `Timer` 入力（10ms）。`weak` 参照は、actor の寿命に置き換える |
| トレイのミュート切替（`lib.rs:350`） | `lock` → `toggle_global_mute` | 受付（`Mute`）。停止・ミュートの意図を `Admission` に登録 |
| ショートカット（`shortcuts.rs:420`） | `lock` → 歌・雑談の切替、音量 | 受付（`Rpc`）。世代の検査は、受付順に置き換える |
| 更新（`updates.rs:161`）、移行（`migration.rs:472`）、一時利用（`temporary_session.rs:280`） | `lock` → `check_can_interrupt`／`prepare_update` | 受付（`StopForMaintenance`）。全体の停止（6.2）として扱う。`finish_update_attempt` も受付 |
| OBS の到達確認（`obs.rs:46`、`:673`） | `lock` → `begin_obs_reach_tone` | 受付（`Rpc`） |
| 配信ミックス（`post_mix`、F-13） | 主 `AudioHost` の中の別 `AudioHost` | F1a-1：終わらない配信ミックスの子は、主の `AudioHost` の記録 `retired` に残す（配信ミックスの `State` が置き換わっても残る。18.3）。F1b-0：同じ actor の下の第2接続（`role = PostMix`）。reader・writer・reaper を持つ。終了は接続ごとに確定する |
| 配信セット（`live_bundle.rs`、`bundles`） | `lock` を長く持つ。`interrupt_restore` を別スレッドから | 「複数の転送の列」。途中の停止は `latest_stop_seq` で見る |
| 起動時の設定（`lib.rs:300-312`） | `AudioHost::new`、レビューのみの一時利用なら `require_explicit_start`、`ConditionState` と `AudioState` の登録、スケジューラの開始、`set_event_emitter`、warmup スレッド | F1a-0：同じ場所で同じ手順。actor へは F1b-0 で移す（起動の順序を試験で固定） |
| 配信セット（`commands/bundles.rs:2011`） | 同じ `Arc<Mutex<AudioHost>>`（`AudioState`）を渡している | F1a-0：`AudioControl` の入口を通す。長い保持は F1b-0 の「複数の転送の列」 |
| アプリの終了（`quit_app`、`Drop`） | `Drop` で `kill`+`wait` | F1a-1：`quit_app` → `app.exit(0)`。回収は Job の kill-on-close。`Drop` が走れば共通の2秒で `kill()` と確認（今は上限なし）。F1b-0：`Shutdown` 入力 → `Teardown` → 上限2秒 |
| 機器のスキャン | `DeviceScanTicket` | 1段の待ち。接続が変われば古いチケットを捨てる |
| フロント（`api/audio.ts`） | 個別の `invoke` | F1a は変えない。F3 以降で `audioSession` 経由 |

### 4.7 受付の容量・保留・期限・過負荷（第2回のレビュー P1）

**この節の値と動作（`busy_overloaded`、制御用の枠、停止の優先、`held`、`HeldTimeout`）は、すべて F1b-0 で、D-9・D-10 の承認とともに有効にする（J-8・J-12・J-14）。F1a-1 は、今の `Mutex` と実行の経路のまま、新しい拒否・期限・優先を入れない。**

| 項目 | 値 | 動作 |
|---|---|---|
| 終わっていない要求の全体の上限 | 256件（通常用の受付、`held`、実行中の合計。ポンプが通常の命令を `held` へ移しても、この合計は減らない） | 超えたら、受付は `busy_overloaded`（`音声の操作が混み合っています。しばらくしてからもう一度お試しください`）を返す。`seq` は採らない |
| 制御用の受付 | 予約（上限は接続数×64+64）。**停止・終了・完了を伝える入力は、通常用の溢れに巻き込まれない専用の経路を持つ**（レーンの分割は PRE-F1b-12 で決める。J-14 で F1b-0 へ移した） | 停止系の命令と、子からの入力・期限は、通常用の溢れの影響を受けない。停止系は受付の時点で `latest_stop_seq` に反映済みで、**実際の停止の実行も制御用の列を優先**する |
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
| **F1a-1** プロセスの寿命（J-14 で範囲を絞った。18.3） | 停止の状態での作成と Job への割り当て、上限つきの終了の確認（2秒・10秒）、主の `AudioHost` の役割ごとの記録 `retired`、作り直しの条件、`engine_unconfirmed` と J-13 の案内。`Mutex` と実行の経路は保つ。actor・受信箱・writer・reaper・EOF の後の自動の隔離は F1b-0 | 試験の継ぎ目での失敗の注入、実プロセスの境界の試験（14.4、W1a・W1b・W1b'・W1c・W2・W4a・W4b） | 変えない。`Unconfirmed` のときの要求の失敗（`engine_unconfirmed`）と Job の割り当ての失敗の扱いは、**F1a-1 でも安全のための変更なので、個別の承認が要る**（互換の契約 D-13） |
| **F1b-0**（旧 F1a-2。J-14）actor と持ち主の移行 | actor・受信箱・reader / writer のスレッド（3.1、4.1、4.5、4.7。宿題は PRE-F1b-12）。入口の一覧（4.6）を、確かめられる単位で順に移す：(1) 主のコマンド (2) 配信ミックス（第2接続）(3) 機器のスキャン (4) warmup・frontend_bootstrap (5) 更新・移行・一時利用 (6) スケジューラ・トレイ・ショートカット・OBS・配信セット。各単位ごとに互換の試験を通す | 各単位の互換試験、既存の Rust 試験、W3、B25〜B28、B36〜B42 | **受付と実行の順（K11）、停止の優先、`busy_overloaded`、書き込みの5秒での隔離を変える。D-9・D-10 の承認とともに入れる**（J-12・J-14） |
| **F1b** 新しい契約 | `RequestId`・`AttemptId`・確定点（5.2）、タイムアウトの後始末（5.3）、終了の確定（7章）、`audio-session`・`get_audio_session`、履歴、`clientRequestId`、`PersistPolicy`、`MeterCell`、子の `attempt_id` の echo・`Error` の世代・`StreamState`・能力の確認。`SnapshotCell` による読み取り | 合格の条件の表の F1b の行 | **安全のための変更を、互換の契約の 8.2 の表（D-1〜D-14）の単位で、個別に承認して入れる。** 「受付順を記録すること」（F1a-0 で済み）と「その順序で利用者から見た勝ち負けを変えること（`Superseded` など）」は、別の差分として扱う |
| **R1** 自動の再開の制限 | 12章の `RecoveryAuthority`、`recover`、フロントの再開の切り替え。再開の待ち時間の予約（2秒・4秒・6秒）は、フロントに残す。親へ移すのは、権限と実行 | 再開の順序の行 | 旧の再開が、手動の操作と競合したとき、拒否される。通常の再開は同じに動く |
| **F2** 確認のセッション（声と音楽） | 11章。セットアップを移す。#806 の完成。到達の判定を Rust へ。**最小の `audioSession` の購読（9章の版・`seq`・回復）をここで入れ、F3 でそのまま使い回す** | 確認の順序の行、フロントの試験、ブラウザ試験、画面の合格の条件（合格の条件の表の U 群） | セットアップだけが変わる |
| **F3-min** 購読の最小の移行（J-11） | F2 の購読を土台に、**競合の害が利用者に見えるものだけ**を移す：稼働表示、クラッシュ画面と VST の一覧、メーター（自動の再開は R1 で済み）。購読の Lint 規則は、移した機能の範囲だけに効かせる。残りの購読側（準備の画面、接続の設定、ボイスチェック、OBS など）は旧の購読のまま残す | 購読の行のうち移した機能のもの、`--feature` ごと | 内部のみ。旧の通知は残す |
| **分岐点**（13.2） | F3-min の後で、UI の構成（Tauri のまま／GPUI へ移る）を決める。GPUI は別のブランチで試作する | — | — |
| **F3-rest** 残りの購読の移行（Tauri に残る場合だけ） | F3-min で残した購読側を1機能ずつ移す。最後に、旧の購読（`listen('audio-…')` の直接の購読）が残っていないことを、機械検査と grep で確かめる | 購読の行、`--feature` ごと | 内部のみ |
| **F4** 旧の通知の廃止（Tauri に残る場合だけ） | F3-rest の確認が済んだ後にだけ着手。旧6通知と、フロントの重複した状態の組み立てを廃止。**自動の再開は、権限と実行は R1 で親にある。F4 でフロントの再開の予約・状態の重複を整理する。予約（待ち時間）まで親へ移すかは、J-7**。GPUI へ移る場合は、F3-rest と F4 は行わず、GPUI の画面が正本を直接購読する | 全 Vitest、ブラウザ試験 | 内部のみ |
| **D（文書、独立）** | #827：`docs/SPECIFICATION.md` の子の IPC を、今のワイヤ形式に合わせる（J-6）。この PR ではしない。F1b を待たない独立の文書の PR | 文書の検査 | なし |

分割の理由：F1a は、通信・プロセスの寿命・入口の移行・読み取りの境界など、互いに独立に確かめられる単位を含む。まとめて入れると、互換の試験の失敗の原因が特定できない。F1a-0 だけなら、`Mutex` を残したまま、受付順の記録と互換の試験の基準を先に固定できる。J-14 で、actor と入口の持ち主の移行（旧 F1a-2）は、受付と実行の順を変えるので F1b-0 へ移し、F1a-1 はプロセスの寿命だけにした（18.3.0）。

### 13.1 F1a-0 の実装の指針（この節と互換の契約だけで、実装と試験に進める）

**目的：** `9567061a` の互換を試験で固定し、入口を1か所にまとめ、受付の順序を記録する。**製品の挙動は変えない。**

1. **`AudioControl`（入口）：** 今と同じ場所（各コマンド、トレイ、ショートカット、更新・移行・一時利用、OBS、warmup、スケジューラ、配信セットなど）で、**同じ `Arc<Mutex<AudioHost>>` の `Mutex` を取る**入口にする。`run_blocking` との組み合わせも今のまま。`AudioControl` は、ロックを取る前後の記録と、入口の種類の名前を足すだけで、ロックの順序・保持の長さ・実行するスレッドを変えない。
2. **`Admission`（受付の記録）：** 受付の通し番号 `seq` と入口の種類を、**記録するだけ**。記録は、ロックを取ることとは**別**（記録の順序と、実際にロックを取る順序は、一致しなくてよい）。**受付の記録の順序で、操作を並べ替えない。勝ち負けにも使わない。** 10ms のスケジューラも `AudioControl` を通るが、連番を振ることと、種類ごとの件数を数えることだけを行い、個々の連番と入口の組は履歴（`records()`）に残さない（直近の操作の記録を押し出さないため。`audio/control.rs` の `Admission::accept`）。 試験 K11 で、「受付の記録は A→B だが、実際にロックを取る順は B→A」の場合を固定し、記録を勝敗に使っていないことを確かめる。
3. **`stop_audio`：** `interrupt_restore()` が返す `Pending` を、**ロックを待つ前に作り、ハンドラが終わるまで持つ**（`commands/audio.rs:484-496`、`audio/conditions.rs:55-58`）。今と同じ。
4. **読み取り：** `get_audio_state`・`get_saved_audio_config` は、**`state.lock()` を取ってから読む**（同じ `Mutex` の経路。`SnapshotCell` にしない）。試験 K2・K10 は、`Start` がロックを取ったことを確かめてから読み取りを出し、開始が保存と状態の更新を終えた後の値を返すことを確かめる。
5. **通知：** 今の経路のまま（reader の `emit`、`AudioHost` の `emit`、`Conditions::dispatch` の前後の通知、`emitter` の Mutex）。`expectedState` は、既存の完全一致のまま（旧の形に写す処理は入れない）。
6. **入口の照合：** 4.6 の一覧に加えて、次を確かめる。(a) 同じ `Arc<Mutex<AudioHost>>` を渡している配信セット（`commands/bundles.rs:2011`）、(b) 10ms のスケジューラ（`audio/mode_vst.rs:526-535`。`weak` で `lock` する）、(c) 起動時の設定（`lib.rs:300-312`）、(d) 終了の経路（`quit_app`、`Drop for AudioHost`、`audio.rs:2945`）、(e) 配信ミックスの第2の `AudioHost`（`AudioState` を通らない。`audio/post_mix.rs:383-392`）。一覧にない入口がないことを、`state.lock()` と `AudioState` の全使用箇所の検索で確かめる。
7. **試験：** 互換の契約の表を試験にする（合格の条件の表の K 群、W5）。試験の継ぎ目は、既存の試験が使うもの（`AudioHost::new` と、`execute_running_command` へ差し込む応答の模擬、`conditions`）を使う。足りない継ぎ目があれば、**製品の挙動を変えない最小の差し込み**だけを足す。`ScriptedEngine`（14章の `Transport`）は、actor が入る F1b-0 から。F1a-0 で実際に入れた scripted child（`audio/tests/compat_support.rs`）は別物で、F1a-1 の試験もそれに失敗の注入を足して使う（14.1）。W5（WebView への到着の順序）は、実際の WebView で測り、**Rust が `emit` を呼ぶ順序と、WebView に届く順序を、分けて記録する**。
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

**F1b-0 で入れる、actor の試験の基盤である。** `audio_engine` の代わりに、試験の中で動く `ScriptedEngine`。実バイナリではなく、読み書きの対（パイプの代わり）を、接続の部分に差し込める形にする（`Transport` のトレイト）。

**F1a-0 で実際に入れた scripted child とは別物である。** F1a-0 のものは、`audio/tests/compat_support.rs` で、試験の実行ファイル自身を子として起動し直し（`scripted_engine_entry`）、`AudioHost` の `test_engine_launcher` から本物の `Child` として渡す方式で、`Transport` のトレイトも仮想の時計も使わない。F1a-1 の試験（失敗の注入：Job の作成・割り当て・再開、`try_wait()` の結果）は、この既存の継ぎ目の上に足す。`ScriptedEngine`（`Transport`）は actor が入る F1b-0 から。

実プロセスの境界は、別途の実 sidecar 試験（`TESTING.md` の「実sidecarのプロセス境界と実機試験」）で行う。

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

- F1a-1（W1a・W1b・W1b'・W1c）：Job の作成の失敗（W1a）、割り当ての失敗（W1b。注入で、子は生きている）、割り当ての OS の拒否（W1b'。`JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 1` の Job に先に別のプロセスを入れて渡して起こす）、再開の失敗（W1c。`ResumeThread` の戻り値が1以外）。失敗時に子を kill し、終了を確かめ、新しい子を起動しない。
- F1a-1（W2）：終わらない子。試験の継ぎ目で `try_wait()` を「終わっていない」にし続ける注入の試験（実プロセスの `kill` は試験では止められない）。入口は 配信ミックスの停止・開始・書き込みの失敗、主の書き込みの失敗、`ensure` の `Err`、EOF の後の `snapshot()`、配信セットの復元とロールバック（`State` の置き換え）。どの入口でも、子が主の `retired` へ渡ることを確かめる。
- F1b-0（W2a〜W2c）：stdout だけが閉じる子（stdin は開いたまま）。EOF の処理と `Reaped` の順序。
- F1b-0（W3a・W3b）：パイプの詰まり（子が stdin を読まない）。writer の `try_send` と5秒の隔離。別の接続の入力の処理と、新しい操作の実行は別の期待値。
- F1a-1（W4a・W4b）：アプリの通常の終了（`quit_app` → `app.exit(0)`）と、親の強制終了（割り当ての前・後・再開の後の3区間）での子と孫の回収（Job の kill-on-close。`Drop` の有無によらない。回収の保証は Job に入った子に限る）。停止のまま残る子（J-15）と、Job に入らなかった子は、自動では回収しない（回復は Windows の再起動）。
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
| Q-C1 | F1a の互換を破る例（旧の通知の順序、`get_audio_state` の待ち） | 13章、互換の契約 8.1・8.2 | F1a では旧の通知を reader から直接 `emit`（結果の前）、`get_audio_state` は今の `state.lock()` のまま（F1b-0 で actor へ移した後は、列を通る読み取りで同じ待ちの境界）。Emitter と `SnapshotCell` は F1b の承認の差分（D-8、D-11）。`expectedState` の比較は旧の形に固定 |
| Q-C2 | 互換表の誤り・不足 | 互換の契約（改訂） | `lifecycle` と `engine_epoch` の説明を訂正。直接返るエラー、`access denied` の分岐、`Stopped` なしの `Error`、`Stop` の結果の無視、bootstrap の最初のフォールバック、`SetGlobalMute` を通らない開始、`prepare_update` の停止、`get_saved_audio_config` の直接の読み取りを追記 |
| Q-C3 | D-1〜D-7 の判断、追加の4つ | 互換の契約 8.2、13章 | D-1・D-7・D-2・D-3・D-4・D-5・D-6 に条件を追記。D-8〜D-14 を追加。受付順の記録（F1a-0）と勝敗の変更（F1b）を別の差分にした |
| Q-T1 | 合格表の第1〜5回の不足 | 合格の条件の表 H 群・U 群 | 不足の行を足した。「再現した順序をすべて入れた」を、照合した範囲に直した |
| Q-T2 | H25 が「あとで確かめる」を壊す | 11.5 | `answer: Heard|Later`。`Heard` は到達済み、`Later` は稼働中・障害なし（現行の挙動を保つ） |
| Q-T3 | 期待値の食い違い（B6、D7、B9、H1、H16、H22、H24、A6） | 合格の条件の表 | それぞれ直した |
| Q-F1 | F1a の分け方 | 13章 | F1a-0、F1a-1、F1a-2。`Superseded` は F1b の承認（のち J-14 で、F1a-1 をプロセスの寿命に絞り、F1a-2 は F1b-0 へ移した） |
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
- **J-8（決定）：** 4.7 の値（終わっていない要求の全体 256件、保留 60秒、命令全体 90秒／120秒、`Unconfirmed` の失敗まで10秒）は、仮の値として妥当。**「30秒で停止を捨てる」仕様はやめる。停止は捨てずに実行する。** 満杯のときの停止と完了の配送、終わっていない要求の全体の上限、期限の起点（受付の時刻）は 4.7 で決めた。レーンの分割と値の見直しは F1b-0（PRE-F1b-12。J-14）。
- **J-9（決定）：** `Unconfirmed` の間、**10秒で `engine_unconfirmed`** を返す。**遅れて終了を確かめられたら、「操作できる状態に戻りました」を表示する**（履歴 `process_confirmed`）。再試行を繰り返しても確かめられないときの案内は J-13 で決めた。復帰の表示は F1b へ移した（J-14）。
- **J-10（決定）：** `PersistPending`（確認中）の表示は「**保存を確認しています**」。再送は照会に合流させる。画面を閉じて開き直した場合と、ワーカーの決着を確かめられない場合は PRE-F1b-4 で扱う。
- **J-11（利用者の決定）：** F2 までは必ず行う。F3 は、競合の害が利用者に見えるもの（稼働表示、クラッシュ画面と VST の一覧、メーター）だけを移す F3-min に縮める。そこで UI の構成を分岐させ、GPUI を別のブランチで試す。問題がなければ移り、問題が出たら Tauri の構成に戻って F3-rest と F4 を続ける。13章、13.2。
- **J-12（利用者の決定、2026-11-21）：** PRE-F1a1-4（D-10）。5秒での隔離は F1b まで延ばす（writer のスレッドの分離も、J-14 で F1b-0 へ移した）。あわせて、`busy_overloaded` の拒否と、停止を受付の順を越えて先に実行することも、F1b で D-9・D-10 の承認とともに有効にする。18.3。
- **J-13（利用者の決定、2026-11-21）：** PRE-F1a1-8。`engine_unconfirmed` を3回続けて返したら、「音声エンジンを終了できません。Auralyn を終了して、起動し直してください」を返す。18.3。英語の文言は、Rust のエラーを訳す仕組みができてから使う。今は、ほかの Rust のエラーと同じく日本語だけ。
- **J-14（統括の決定、2026-11-21）：** F1a-1 を「プロセスの寿命」だけに絞る（停止の状態での作成と Job、上限つきの終了の確認、作り直しの条件）。reaper と EOF の後の自動の隔離も F1b-0。actor・受信箱のレーン・writer のスレッド・入口の持ち主の移行（旧 F1a-2）は、受付と実行の順を変えるため、D-9・D-10 の承認と一緒に F1b-0 で入れる。J-9 の復帰の表示も F1b へ移す。独立レビュー（`44b9b837` への BLOCK）による。18.3.0。
- **J-15（統括の決定、2026-11-21）：** 子を停止の状態で作ってから Job に入れるまでの窓で親が強制終了された場合、停止したままの子が残ることを受け入れる。この子は自分では終わらず、実行ファイルの更新・削除を妨げる。窓はまれなので、**自動の回収はせず**、回復は Windows の再起動とする（起動時の回収は、子の起動元を確かめる手段が要り、誤って別のプロセスを終わらせる危険がある）。Job の作成・割り当てに失敗し、終了を確かめられないまま親が終わった子も同じ扱い。作成と割り当てを1回にする方式は、std で属性つきの生成が安定化したら見直す。18.3。
- **J-16（利用者の決定、2026-11-21）：** Rust を 1.100.0 に上げ、`ChildExt::main_thread_handle`（1.100.0 で安定化）で主スレッドを再開する（Toolhelp でスレッドを探す方式をやめる）。版の更新は F1a-1 の前の別の PR で行う。
- **D-13（決定）：** 承認する。**承認の条件は、Windows の実プロセスでの確認**（Job の作成・割り当て・再開の失敗、終わらない子、アプリの通常の終了と強制の終了。W1a・W1b・W1b'・W1c・W2・W4a・W4b、18.3。W1・W4 は実プロセス（一部は注入と併用）、W2 は失敗の注入で確かめる）。確認の結果を見てから、F1a-1 のマージを承認する。承認の範囲は、互換の契約 D-13 の (a)〜(g)（18.3 の第5版）。更新・アンインストールが妨げられた場合は Windows を再起動してから再試行すること、MSIX では旧版のパスに子が残ることも、承認の範囲に含む（J-15）。

### 16.2 新しく出た、利用者の判断が要る点

この版では、新しく利用者の判断が要る点はない。J-7〜J-10 と D-13 は、独立レビュー（Sol）の推奨どおりに決定した。決めきれない設計の項目は、18章の宿題に記録した。

## 17. 確かめていないこと

- 実機・実音声・長時間運転での動作。
- `emit` の呼び出しの順序が、WebView での到着順に一致するか（コードの順序だけを確かめた）。F1a-0 の互換試験で実測する（14.4）。
- 処理設定（ノイズ低減・内蔵エフェクト）が、適用時に別のファイルへ保存されるか。J-2 の保証の前に確かめる。
- 移行が書く設定のファイルの範囲の全体（`migration.rs:688` 付近に `last_audio_config.json` が含まれることだけを確かめた）。
- Windows の Job Object の kill-on-close が、孫のプロセスまで確実に終わらせるか（F1a-1 の W4a・W4b で確かめる。回収の保証は Job に入った子に限る）。Job の割り当てに失敗する条件。W2（終わらない子）は失敗の注入で確かめ、実プロセスでは確かめない。
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
| PRE-F1a1-1 | 終了を確かめていない子から次へ進めない | 5.3 の「終了の確認」を `Reaped` のみにした。`Unconfirmed` は確認ではない。遅れた `Reaped` で失敗の要求を復活させない。合格の表の D7・B9・B18 を直した | (1) 生成したすべてのプロセスに、待つ役を決める（解は 18.3：F1a-1 は、その子を持つ `AudioHost`／`PostMix` の上限つきの同期の待ち。reaper のスレッドは F1b-0）。Job の作成・割り当てに失敗した分岐でも、子を終わらせて終了を確かめる。(2) 終了の証拠が得られたときだけ、同じ役割の子を生成し直す。(3) EOF だけが来て子が生きている場合は隔離する（F1b-0 の W2a。F1a-1 は今の挙動を保つ）。(4) 待つのに失敗したら、もう一度確かめる。(5) 子を実行させる前に Job へ割り当てる方式の選定（停止状態での作成と再開、など）。W1a〜W1c・W2・W4 で確かめる |
| PRE-F1a1-2 | 制御の受信箱が満杯のとき、終了の確認や停止を取り残す | 終わっていない要求の全体の上限（256件）、停止を期限で捨てない、`Shutdown` で2つの受信箱と `held` をすべて完了する（4.7） | **F1b-0 へ移した（J-14。PRE-F1b-12）。** 元の宿題：(1) レーンの分割：`Response`・`Eof`・`ReaderDone`・`Reaped`・`Shutdown`・`Deadline` は専用の経路。`Wire(Event)` は、有界で、重要でないものは畳む。(2) ポンプが通常の命令を `held` へ移し続けても、通常の命令にも処理の機会を割り当てる（公平性）。(3) 満杯のときの配送の保証を、模擬の試験で固定 |
| PRE-F1a1-3 | ポンプの照合のキー | `ConnId` を全役割で一意に（0章）、入力を `(role, conn)` で識別、`WriteDone`・`Deadline` を段のトークンでも照合、`ReaderDone`・`ReaderAbandoned` を入力の型に（3.1、4.1） | **F1b-0 へ移した（J-14。PRE-F1b-12）。** 元の宿題：型の定義と、打ち切り後の旧 reader の入力の無効化（`reader_epoch`）の実装。`label_gen`（旧 `engine_generation`）との対応の試験 |
| PRE-F1a1-4 | D-10：書き込みの5秒での隔離 | 基準では書き込みの詰まりに上限がないことを、互換の契約に記載。D-10 の承認の範囲に、過負荷の拒否と停止を優先する実行を含めた | 決定（J-12）の後、J-14 で、writer のスレッドの分離も **F1b-0 へ移した**（5秒での隔離と一緒に D-10 の承認で入れる）。F1a-1 は同期の書き込みのまま。W3a・W3b・B27 の期待値は F1b-0 の行 |
| PRE-F1a1-5 | W 群の分割と、足りない行 | W2 を3つに分割、W4 を正常な終了と強制の終了に分割、制御の枠が満杯の場合・保存のワーカーが止まる場合を足した | 実プロセスの試験の手順書（`TESTING.md` への追記は F1a-1 の PR）。18.3 の表で、W1a〜W1c・W2・W4a・W4b を F1a-1、W2a〜W2c・W3a・W3b を F1b-0 とした |
| PRE-F1a1-6 | 合格の表の期待値の食い違い | D7、B6（`Failed` と `Timeout` の食い違い）、B18（再開の対象）、D8（F1a での `Superseded`）を直した | — |
| PRE-F1a1-7 | J-8 の値と起点 | 全体の上限、停止を捨てない、起点は受付の時刻（4.7） | 2秒・10秒は F1a-1 で測って見直す。4.7 の値は F1b-0 で測る（18.3） |
| PRE-F1a1-8 | J-9 の文言と回数 | 10秒で `engine_unconfirmed`、遅れて確認できたら復帰を表示（J-9） | 繰り返し失敗したときの案内の文言と回数（推奨：3回）。`COPY_GUIDELINES` に従う。決定は J-13（3回）。復帰の表示は F1b へ移した（18.3） |

**解いた内容は 18.3。** F1a-1 の PR は、18.3 を前提に実装する。

### 18.3 PRE-F1a1 の解（F1a-1 の実装の前提）

F1a-0 のマージ（`f2ae2c9d`）の後に決めた。独立レビューを3回受けて（`44b9b837`、`1a63d226`、`89c8559e` への BLOCK）、範囲と方式を絞った（第5版。Rust 1.100.0 の `main_thread_handle` を入れた）。【事実】はコードで確かめたこと、【設計】は F1a-1 で作るもの。

#### 18.3.0 F1a-1 の範囲（J-14）

actor・受信箱のレーン・writer のスレッド・入口の持ち主の移行（旧 F1a-2）は、受付の順と実行の順（K11）、旧の通知の出し方、書き込みの失敗と応答の優先、`ReplySlot` の契約を変える。F1a の「挙動を変えない」と両立しないので、D-9・D-10 の承認と一緒に **F1b-0** で入れる（宿題は PRE-F1b-12）。

**F1a-1 は、今の `Mutex` と実行の経路を保ったまま、子のプロセスの寿命の穴だけを直す。** 変えないもの：`Mutex<AudioHost>` と `AudioControl` の入口、reader からの旧の通知の直接の `emit`（`audio-level` を含む）、`ReplySlot`、同期の書き込みと、書き込みの失敗の優先、応答の期限、`engine_generation` の更新点、`interrupt_restore`、`quit_app` の `app.exit(0)`、旧の `is_running`（子の登録の有無）、EOF の後の挙動（下の【事実】）。**新しい通知は出さない。**

#### PRE-F1a1-1 子の寿命

【事実】（コードで確かめた）
- 音声の接続の子は、主と配信ミックスの2種類。どちらも `spawn_engine_process`（`audio.rs:696-724`）で、std の `Command` から作る。配信ミックスは、主の `AudioHost` の中の `PostMix` が持つ別の `AudioHost`（`post_mix.rs`）。
- Job の割り当ては子を作った後で、結果を `let _ =` で捨てる（`audio.rs:776-780`）。割り当てまでの間、子は動いている。
- 終了させるときは `kill()` の後に**上限のない** `wait()`（`kill_primary_engine`、`audio.rs:2820-2824`。`Drop`、`audio.rs:2961-2969`）。子が終わらなければ、ロックを持ったまま止まり続ける。
- 配信ミックスの `discard_child()`（`post_mix.rs:634-641`）は、子の `AudioHost` を `take()` して `kill_engine()` の後に破棄する。その直後に `child()` で新しい子を作る経路がある（`post_mix.rs:572-575`）。
- 作り直しの判断は `ensure` の `try_wait()` で、`Ok(Some)` と `Err` のどちらでも作り直す（`audio.rs:735-763`）。
- EOF の後で子が生きている場合：reader は待ち手に `Engine Crashed/Exited` を渡して `reader_active` を下ろす（`audio.rs:1058`）。次の命令は、送る前に `reader_active` の検査で失敗する（`audio.rs:1167`）。`try_wait()` は `Ok(None)` なので作り直さない。子が自然に終わるか、`restart_audio_engine` で明示に作り直すまで、この状態が続く。
- `prepare_update`（`audio.rs:2781-2789`）は、停止の後に `maintenance = true` にして `kill_engine()` する。更新・移行・一時利用は、これの成功の後に進む。
- 子は、最初の命令までに機器を開かず、孫も作らない（`Engine::new()` はストリームを `None` で初期化。`core.rs:464`。`--scan` の孫は `begin_scan` から。`devices.rs:124`）。通常のログは stderr、`EngineEvent::Log` は stdout の IPC。
- 一時利用の再起動（`temporary_session.rs:328`）とエディタの環境の試験（`editor_environment.rs:244`）は Job を使わない設計。スキャナー（`child_process.rs:51-64`）は割り当ての結果を捨てる。**F1a-1 の範囲外**。スキャナーの件は別の Issue に記録する。

【設計】
1. **作成を停止の状態で行い、Job に入れてから動かす。** std の `Command` はそのまま使う（パイプ・環境・引数の引用・作業フォルダ・stderr・`CREATE_NO_WINDOW` と、std の内部の生成のロックによるハンドルの継承の保護を、今のまま保つ）。変えるのは次だけ。
   - `creation_flags` に `CREATE_SUSPENDED` を足す（stable の API）。
   - 作った直後に Job（kill-on-close）を作り、`AssignProcessToJobObject` で割り当てる。
   - 子の主スレッドを再開する。Rust 1.100.0 で安定化した `ChildExt::main_thread_handle` で主スレッドのハンドルを得て、`ResumeThread` を呼ぶ（J-16）。**成功の条件**は戻り値が `1`（停止の数が1から0へ）。`0`・`u32::MAX`（失敗）・`2` 以上は、起動の失敗として扱う。必要な `windows` の features（`Win32_System_JobObjects`、`Win32_System_Threading`）は有効。
   - **Job の作成・割り当て・再開の、どれかが失敗したら**、その子（作成・割り当ての失敗なら、まだ1命令も実行していない。再開の戻り値が `0` なら既に動いている）を `kill()` し、2 の上限つきの確認に回して、起動を失敗にする（「開始していません」。D-13）。終了を確かめるまでは、Job を持たない子も、2 の記録に残し、同じ役割の子を作らない。Job に入っていない子は、動かさない。
   - **残る窓（J-15）：** OS が子を作った時点（`spawn()` が戻る前を含む）から割り当ての成功までの間に親が強制終了されると、**停止したままの子**が残る。この子は1命令も実行せず、機器も開かず、CPU を使わない。ただし、**stdin の EOF で終わる今の後始末も実行できない**ので、自分では終わらない。メモリと、継承したパイプの端を持ち続け、**実行ファイル（`audio_engine.exe`）を書き込み・削除できなくする**（更新・アンインストールの妨げになる。小試験で確認）。今は、同じ窓で残った子は動いていて、親の死でパイプが切れると EOF で自分で終わる。**この点では今より悪い**。窓は数マイクロ秒〜数ミリ秒で、親がちょうどその間に強制終了された場合にだけ起きるので、受け入れる。**自動の回収はしない**：起動時に取り残された子を探して終わらせる案は、その子を Auralyn が起動したと確かめる手段（生成の記録との照合）が要り、誤って別のプロセスを終わらせる危険と複雑さが、まれな窓の害を上回る。回復は Windows の再起動とする。更新・アンインストールが妨げられた場合は、再起動してから再試行する。MSIX でも、旧版のパスに子が残る場合がある。作成と割り当てを1回にする方式（`PROC_THREAD_ATTRIBUTE_JOB_LIST`）は、Rust 1.100.0 でも属性つきの生成（`spawn_with_attributes`）が nightly のみで、自前の生成はハンドルの継承の競合を持ち込むため採らない。安定化したら見直す。
   - 試験の継ぎ目（F1a-0 の `test_engine_launcher`）は、`Child` を返す形のまま、停止の状態で作るように合わせ、試験の子にも製品と同じ手順（割り当て・再開）を通す。
2. **終了の確認は、上限つきの同期の待ち。記録は、主の `AudioHost` の `retired` に役割ごとに置く。** F1a-1 では reaper のスレッドを作らない（すべての処理がロックの下で同期に進む。reaper は F1b-0 で actor と一緒に入れる）。
   - 子を手放す経路は、すべて1つの関数（`retire_child(role, child, job)`）を通す：`kill_primary_engine`、配信ミックスの `discard_child()`、配信ミックスの `snapshot()` が EOF の後に子を外す経路（`post_mix.rs:706` 付近）、配信ミックスの `State::stop()`・`start()` が子の `kill_engine()` を直接呼ぶ経路（`post_mix.rs:646` 付近）、IPC の書き込みの失敗で子自身が `kill_engine()` して元のエラーを返す経路（`audio.rs:1186` 付近）、`ensure` の `try_wait()` の `Err`、起動の途中の失敗（1）。どの経路でも、既存の成功・エラーを保ったまま、**次の生成の判定・`State` の差し替え・呼び出し元への復帰のどれよりも先に**、主の記録へ移す。
   - `retire_child` は `kill()` の後、`try_wait()` を50msごとに繰り返し、**最大2秒**確かめる。`Ok(Some)` なら終わり（記録しない）。`Ok(None)` と `Err` は終了の証拠ではない（今の `Err` での作り直しをやめる。D-13）。2秒で確かめられなければ、`Child` と Job（あれば）と**最初の `kill()` の時刻**を、`retired[role]` に移す。
   - `retired` は**主の `AudioHost`** が持つ。配信ミックスの `State` は、配信セットの復元の失敗で丸ごと置き換わる（`mixing_bundle.rs:248` 付近の `State::new`）ので、そこには置かない。主の `AudioHost` はアプリの間ずっと生きる。
   - 主の `AudioHost` が持つ記録を、配信ミックスの子の `AudioHost` と `Arc` で共有し、子を手放した時点で記録に移す。記録の持ち主は主（アプリの間ずっと生きる）。
3. **作り直しの条件と期限。** その役割の子を作る経路（`ensure`、配信ミックスの `child()`、再起動）は、作る前に `retired[role]` を確かめる。
   - 空なら作る。残っていれば `try_wait()` で確かめ、`Ok(Some)` なら記録を消して作る。
   - 終わっていなければ、**記録の期限（最初の `kill()` から10秒。要求ごとにやり直さない）**まで、2秒ごとに `kill()` をやり直しながら待つ。期限を過ぎていれば、待たずに1回だけ確かめる。期限までに確かめられなければ、`engine_unconfirmed` で失敗する（作らない。ロックは持ったまま）。したがって、1回目の要求は最大10秒待ち、2回目以降は期限を過ぎていれば即座に答える。
   - 1つの要求が主と配信ミックスの両方を作る場合は、それぞれの記録の期限で待つ（同じ時刻に始まった記録なら、待ちは重ならない）。明示の再起動は主だけを作るので、主の記録だけを確かめる（配信ミックスの記録は、配信ミックスを作るときに確かめる）。
4. **`kill_engine()` の後に結果を返す既存の入口は、今の結果を保つ。** VST の復旧の途中の停止（`audio.rs:1759` 付近。成功を返す）、書き込みの失敗（`audio.rs:1186` 付近。通知と元のエラーを返す）などは、`retire_child` が2秒で戻った後、**今と同じ結果**を返す。旧の子は `retired` に残り、同じ役割の作り直しを止める。`is_running` は子の登録の有無なので `false` になる（今と同じ意味）。この間、旧の子がまだ生きている場合があることは、D-13 (f) として承認に含める。
5. **EOF の後で子が生きている場合は、今の挙動を保つ**（自動では隔離しない。自動の隔離と作り直しは、子に残る VST の状態を失わせるので、F1b-0 で W2a として扱う）。`restart_audio_engine` で作り直すときに、上の2・3が効く。
6. **アプリの終了。** 子と孫の回収は、**Job の kill-on-close に任せる**：Auralyn のプロセスが終わると、すべてのハンドルが閉じ、Job が子と孫を終わらせる。`quit_app` の `app.exit(0)` の後に `Drop` が走ることは保証しない（Tauri の管理状態と `AppHandle` の参照の関係で、最後の参照が落ちるとは限らない）。`Drop` が走った場合は、主・配信ミックス・`retired` の子に**共通の期限2秒**で `kill()` と確認を行い、終わらなくてもそのまま終える（今は上限なく待つ）。`Drop` はロックを取らない（今と同じ）。共通の2秒が効くのは主の `Drop` だけで、配信ミックスの子の `AudioHost` は、`Drop` で終わらない子を記録へ移すだけで、自分では共通の期限を待たない（`retire_child` の2秒の確認の後に移す）。
7. **`prepare_update`。** `kill_engine()` の後、`retired` の各記録を `try_wait()` で確かめ直し、終わったものを消す。残ったら、`maintenance` を `false` に戻して `engine_unconfirmed` を返す（更新・移行・一時利用へ進まない）。停止のエラー（`self.stop()?`）は、今と同じく先に返す。
8. **`engine_generation`（`stream_generation` の前半）は、今の更新点を保つ**（子を登録したとき：`audio.rs:783-789`、`kill_primary_engine()`：`audio.rs:2816`）。試験：明示の再起動で 1→3、自然な終了の後の `ensure` からの作り直しで 1→2、配信ミックスを挟んでも主の数が変わらない。旧の通知の形は変わらない。

#### PRE-F1a1-2・3・4

F1b-0 へ移した（J-14。宿題は PRE-F1b-12）。F1a-1 では、`ConnId` も入れない（照合の相手の actor がないため）。

#### PRE-F1a1-5 実プロセスの試験の手順書と、失敗の起こし方

F1a-1 の PR で `TESTING.md` の「実sidecarのプロセス境界と実機試験」に足す。D-13 の承認の条件なので、結果を PR に記録し、それを見てからマージする。**実プロセスで確かめる行と、失敗の注入（単体の試験）で確かめる行を分けて記録する。**

| 行 | 状態の作り方 | 確かめること | 確かめ方 |
|---|---|---|---|
| W1a Job の作成の失敗 | 試験の継ぎ目（`#[cfg(test)]`）で、Job の作成を失敗させる | 停止の状態の子が終わる（動かない）。起動の失敗。終了を確かめた後、次の操作で作れる | 注入＋実プロセス |
| W1b 割り当ての失敗（子が生きている） | 試験の継ぎ目で、割り当ての呼び出しを失敗として返す（子は実際には生きている） | 子を `kill()` し、終了を確かめるまで、同じ役割の子を作らない | 注入＋実プロセス |
| W1b' 割り当ての拒否（OS） | `JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 1` の Job に先に別のプロセスを入れて渡す（Windows が候補の子を終わらせる） | 管理外で子が動き続けないこと（エラーの番号は固定しない） | 実プロセス |
| W1c 再開の失敗 | `ResumeThread` の戻り値が `1` 以外（`0`、失敗、`2` 以上）を失敗とする。注入では、戻り値だけを `1` 以外にする試験と、子を実際に先に再開してしまう試験（子は動いている）を区別する | 子を終わらせて、起動の失敗 | 注入＋実プロセス |
| W2 終わらない子 | 試験の継ぎ目で、`try_wait()` の結果を「終わっていない」にし続ける（実プロセスの `kill` は、試験では止められないため）。時計を進める。入口ごとに行う：配信ミックスの停止・開始・書き込みの失敗、主の書き込みの失敗、`ensure` の `Err`、EOF の後の `snapshot()`、配信セットの復元とロールバック（`State` の置き換え） | 2秒で `retired` へ移る。どの入口でも、次の生成・`State` の差し替え・エラーを返すことのどれよりも先に、子が主の `retired` へ渡る。期限（10秒）まで待って `engine_unconfirmed`。2回目以降は期限の後なら即座に失敗。3回目の文言（J-13）は、配信ミックスの IPC のエラーも含めて、最終の文言（日英）を固定する。後で終われば、次の要求で作れる。既存の停止・書き込みの失敗の結果が変わらない（4） | 注入 |
| W4a 通常の終了 | アプリを `quit_app` で終える | Job に入った子と孫が残らない（Job の kill-on-close。`Drop` の有無によらない）。孫は孫のハンドルで確かめる。Job に入らなかった子（作成・割り当ての失敗の後、終了を確かめられないまま親が終わった場合）は回収を保証しない（J-15） | 実プロセス |
| W4b 強制の終了 | 親のプロセスを、(1) 割り当ての前、(2) 割り当ての後・再開の前、(3) 再開の後、で強制終了する（(1)(2) は試験の継ぎ目で止めて作る） | (1) 停止したままの子が残る（J-15。記録する。Windows の再起動で消える）。(2)(3) 子と孫が残らない（Job に入った子に限る） | 実プロセス |

W2a（EOF の後の自動の隔離）と W3（書き込みの詰まり）は F1b-0 へ移した。通常の配布と MSIX の両方で、主・配信ミックスの起動、失敗の後の次の起動、通常の終了・強制の終了を確かめる（MSIX のアプリが既に Job の中にいる場合の、ネストの Job。小試験では、親も子も Job に属する状態から、空の内側の Job への割り当てに成功した）。

#### PRE-F1a1-6

済み（18.1）。F1a-1 の PR で、合格の表の F1a-1 の行（B16〜B18、D7、W 群）を、この版に合わせる。

#### PRE-F1a1-7 値の測り方

F1a-1 では、`kill()` から終了までの時間（実プロセス）を記録し、2秒・10秒の妥当性を見る。4.7 の値は F1b-0 で測る。

#### PRE-F1a1-8 繰り返しの案内（J-13）と、復帰の表示

- `engine_unconfirmed` を**3回続けて**返したら、3回目以降の文言を次にする。日本語：「音声エンジンを終了できません。Auralyn を終了して、起動し直してください」。英語：「The audio engine could not be stopped. Quit Auralyn and open it again.」。1・2回目は今の文言のまま。**F1a-1 で入れる。** 英語の文言は、Rust のエラーを訳す仕組みができてから使う。今は、ほかの Rust のエラーと同じく日本語だけ。
- 数え方：`retired[role]` の記録ごとに、`engine_unconfirmed` を返した要求の数を数える。1つの要求が返す `engine_unconfirmed` は1回だけ。その要求で確かめられなかった役割の記録を、それぞれ1つ進める。返す文言は、**どれかの記録が3以上なら**3回目以降の文言にする。要求は `Mutex` で1つずつ実行されるので、続けて来た要求は続けて数える。フロントの自動の再開による要求も数える。記録が消えたら（終了を確かめたら）、数も消える。
- 文言の経路：開始・再起動は `localize_audio_error` を通り、更新・移行・一時利用は文字列をそのまま返す。どちらの経路でも、1・2回目と3回目以降の文言が、日英で上のとおりに最終の表示になることを試験で固定する（`localize_audio_error` に両方の文言の対応を足す。今の生のアクセス拒否をマイクの権限の案内に写す処理に、Job の失敗が紛れないことも確かめる）。
- **復帰の表示（J-9 の「操作できる状態に戻りました」）は F1b へ移す**（表示には履歴と購読が要る）。F1a-1 では、終了を確かめたときにログへ残すだけで、通知は出さない。
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
| PRE-F1b-12 | actor と受信箱（F1b-0。J-14 で F1a-1 から移した） | 第1案のレーン（接続ごとの wire・寿命・停止の枠・通常）と、独立レビューの指摘 | (1) 旧の通知の互換：F1b-0 でも、reader が各行で旧の通知を直接 `emit` し、先行する通知を出し終えてから応答・EOF を actor へ渡す。間引き・畳み・後送りは、旧の通知を廃止する段（F4／GPUI）まで行わない。`audio-level` も旧のまま。(2) 進行の保証：actor が各レーンを読む件数・時間の上限、終了のときに reader の送信の待ちを解く手順、接続ごとの失敗の通知の合流、未消費の完了（`WriteDone`・`Deadline`・`ReapFailed`）を含む予約の枠か上限。`Deadline` と、期限の前に届いていた応答の勝敗。`ReaderDone` と打ち切りを別の入力にし、旧の epoch の reader の直接の `emit` も止める境界。(3) 実行の順：受付の順で実行すると K11 の勝敗が変わる。停止の合流は `Stop → Start → Stop` の後ろの停止を消しうる。`StopForMaintenance` は通常の停止と結果を共有できない。返信先のリストの上限。これらを D-9 の承認の範囲として決める。(4) 書き込み：期限の起点は `WriteDone(Ok)` に載せた flush の完了の時刻。書き込みの失敗と応答の優先（今は書き込みの失敗が先。応答は書き込みの成功の後に採る）、`ReplySlot` の契約、`Shutdown` で詰まった writer の後ろに処理を積まない手順とアプリが待つ上限。別の接続の新しい要求を実行するかどうか（今は同じロック）。(5) `get_saved_audio_config` が、今は先行する操作のロックを待つ境界（3.2）。(6) 4.7 の値（256件・60秒・90／120秒）を有効にする時期。(7) **合格の試験で固定すること：** 満杯のときの旧の通知の**件数と順**、EOF から待ち手の解放までの順（reader が旧の通知を出し終えてから、`Eof` と待ち手の解放へ進む）。(8) **段のトークンでの照合：** `Response`・`WriteDone`・`Deadline`・`Reaped`・`ReapFailed` を、接続だけでなく**段のトークン**で照合し、段が違う入力で今の待ちを解かない（B21・B23・B41）。(9) §5.3 の清掃の `Stop` と、複数の応答（清掃の `Stop` の応答と、開始の応答が重なって届く場合）の扱い。(10) **W3 の期待値の分離：** 「別の接続の入力の処理（配信ミックスの `Eof`・`Shutdown` が処理される）」（W3a）と、「新しい操作の実行（詰まった間に、別の接続へ新しい命令を実行するか）」（W3b）を、別の期待値にする。(11) **D-9・D-10 の承認の項目（実行の順や、別の接続の進行を変える範囲）を、具体的に書く：** 受付の順で実行すること（K11 の勝敗が B→A から A→B に変わる）、停止を受付の順を越えて先に実行すること（`Stop → Start → Stop` の合流を含む）、`StopForMaintenance` の結果を通常の停止と共有しないこと、`busy_overloaded`（256件）、`HeldTimeout`（通常の命令のみ60秒）、書き込みの5秒の隔離、書き込みの失敗と応答の優先の変更、詰まった間に別の接続の新しい要求を実行すること。承認されない項目は、F1b-0 に入れず、受付の記録（F1a-0）の範囲に残す |
| PRE-F1b-11 | R1 の契約の一本化 | `recover { authority_id }` に一本化、12.3 を直し、G4・G5 を合わせた | — |

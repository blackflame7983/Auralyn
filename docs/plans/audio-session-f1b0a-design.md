# F1b-0a 接続の部品の設計

状態：設計（統括の案）。独立レビューの前。

前提の文書：
- 今の事実：`audio-session-f1b0-inventory.md`（以下「洗い出し」）。とくに 2章・3章・9.1。
- 変わる挙動：`audio-session-f1b0-changes.md`（C1〜C5・N1〜N3、J-17・J-18）。
- 方式：`audio-session-f1b0-options.md` の 7章（第4の案、J-19・J-20）。

## 1. 範囲

F1b-0a は、親と音声エンジンの子の「接続」だけを直す。主と配信ミックスで共通の部品にする。**95か所の入口、ホストのロック、受付、実行の順には触れない**（それは F1b-0b）。

| この段で入れる | 変わる挙動 |
|---|---|
| 書き込みを接続ごとの writer のスレッドに移し、5秒で終わらなければ接続を切り離す | C2 |
| 応答が10秒来なければ、接続を切り離す（今は待ちが残り、次の命令が失敗し続ける） | C3 |
| 出力（stdout）だけが閉じて子が生きている接続を、次に子が要る操作の時点で切り離して作り直す | C5 |
| 通知と状態の更新を、今の接続の番号で照合し、古い接続の行を捨てる | N2 |
| reader の確認と待ちの登録の間の窓（洗い出し 2.4）をなくす | （今の不具合の修正） |
| `emitter` の `Mutex` の poison で panic が連鎖しないようにする | （今の不具合の修正。挙動は変えない） |

この段で入れないもの：
- reaper のスレッドと、終了の確認でロックを持たないこと（N3）。F1b-0b で、持ち主を1つにするときに入れる。
- 停止の優先（C1）、混雑の上限（C4）、トレイ（N1）。いずれも F1b-0b。
- モード VST の書き込みの経路（洗い出し 2.1 の2つ目）。すでに書き込み専用のスレッドと10秒の期限がある。この段では変えない。F1b-0b で共通の writer にそろえるかを決める。

## 2. 変わる挙動の詳細（利用者から見て）

| # | 場面 | 今 | F1b-0a | 返す文言（案） |
|---|---|---|---|---|
| C2 | 子が stdin を読まない | 書き込みでロックを持ったまま止まる。停止・トレイ・読み取りもすべて止まる | 5秒で接続を切り離し、子を終わらせる（`retire_child`）。その命令は失敗。次に子が要る操作で作り直す | 「音声エンジンが応答しないため、終了しました。もう一度お試しください」 |
| C3 | 子が応答を返さない | 10秒で失敗し、待ちが残る。次の命令（停止を含む）は「前の音声操作の応答待ちです」で失敗し続ける | 10秒で失敗し、接続を切り離して子を終わらせる。次の命令は待ちに妨げられない。停止は「接続なし」の停止（今の経路）になる。次に子が要る操作で作り直す | C2 と同じ |
| C5 | 子の stdout だけが閉じた（子は生きている） | 送る前の確認で失敗し続ける。再起動までもどらない | 次に子が要る操作（`ensure_engine_running` を通る操作）の時点で、その子を `retire_child` で終わらせて作り直す。停止・読み取りなど子を作らない操作は、今と同じく作らない | 作り直しに成功すれば、その操作は通常どおり進む |
| N2 | 作り直した直後 | 古い接続の reader から、照合のない9種の通知が1行出うる | 出さない | — |

- C2・C3・C5 で切り離した子の VST の状態（保存していない変更）は失われる（J-17 で承認済み）。
- 切り離した子が終わらないとき（`retire_child` の2秒で確かめられない）は、F1a-1 の記録（`retired`）に残り、同じ役割の作り直しは F1a-1 の規則（10秒の期限・`engine_unconfirmed`・J-13）に従う。
- 期限の値（5秒・10秒）は J-8 の仮の値。この段の試験と実測で見直す。

## 3. 部品の設計

### 3.1 接続（`EngineLink`）

1つの子の接続に1つ。主と配信ミックスの `AudioHost` がそれぞれ持つ（今の `stdin`・`reader_active`・`pending_reply_tx`・`vst_operations` をまとめる）。

```text
EngineLink {
  conn: ConnId,                 // 全役割で一意。使い回さない
  writer: WriterHandle,         // 3.2
  replies: ReplySlot,           // 3.4。closed の状態を足す
  state: Arc<LinkState>,        // Open | Closed(cause)。reader と writer と呼び出し側が共有
}
```

- `ConnId` は、`AudioControl` か `AudioHost` の外の共有の採番（主・配信ミックスで一意）。`engine_generation`（表示用）とは別。`engine_generation` の更新点は変えない。
- 今の `reader_active: Arc<AtomicBool>` は `LinkState` の `Open` に置き換える。意図した停止（`kill_primary_engine` など）は `Closed(Intentional)`、EOF は `Closed(Eof)`、C2・C3 は `Closed(Isolated)`。

### 3.2 writer

- 接続ごとに1本のスレッド。`BufWriter<ChildStdin>` を所有する（ホストは stdin を持たない）。
- 呼び出し側（今と同じく、ホストのロックを持つスレッド）は、`WriteRequest { line, done: oneshot }` を writer の列（容量1。直列の命令なので1で足りる）に送り、`done` を**5秒**待つ。
- writer は `writeln!` と `flush` を行い、結果（`Ok` か `Err`）を `done` に返す。
- 5秒で `done` が来なければ（パイプが満杯で `flush` が戻らない）、呼び出し側は接続を切り離す（3.5）。writer のスレッドは、子を終わらせるとパイプが壊れて `flush` が `Err` で戻り、終わる。writer のスレッドを join しない（待ちが復活しないように）。`BufWriter` の `Drop` も writer のスレッドの中で起きる。
- **書き込みの失敗を応答より優先する（今と同じ）**：呼び出し側は、`done` が `Ok` になってから応答の待ちに入る。`done` の前に応答が届いても、受け取るのは `done` の後（今と同じく、`mpsc` の受け側に残る）。`done` が `Err` なら、応答を見ずに今の失敗の経路（`kill_engine` → `audio-error` → 元のエラー）を通る。
- 応答の10秒は、`done(Ok)` を受け取った時点から数える（今の「flush の後から」と同じ）。

### 3.3 reader

- 今と同じく1接続に1本。`LinkState` と `conn` を持つ。
- **N2：照合と通知を同じロックの下で行う。** 接続を切り替える側（`ensure_engine_running` の新しい接続の登録、`kill_primary_engine`、切り離し）は、`emitter` の `Mutex` の下で「今の接続の番号」を書き換える。reader は、`emitter` の `Mutex` を取ってから、自分の `conn` が今の番号と一致するかを確かめ、一致したときだけ状態の更新と通知を行う。一致しなければ、その行を捨てる（ログに1回）。これで「照合の後に切り替わる」窓がなくなる。
  - 配信ミックスの子の reader は、子の `AudioHost` の `emitter`（`None`）を使う。照合は同じ。
  - `Conditions::engine_event` の epoch の照合は残す（二重になるが、挙動は変えない）。
- **EOF：** `LinkState` を `Closed(Eof)` にしてから（すでに `Closed` なら何もしない。今の `swap(false)` と同じ判定）、今と同じ通知と `deliver(Error("Engine Crashed/Exited"))` を行う。通知は上の照合を通る。
- パースの失敗は今と同じ（ログだけ）。ただし C3 で、応答が来ない待ちは10秒で接続ごと切り離されるので、待ちが残り続けることはなくなる。

### 3.4 `ReplySlot` の窓をなくす

- `ReplySlot` に `closed` を足す。reader は EOF で `close()` する（保留中の待ちがあれば `Error("Engine Crashed/Exited")` を渡し、以後の `begin` を拒否する）。
- 呼び出し側は、`begin` に成功してから書き込みへ進む。`begin` が `closed` で失敗したら、今の「送る前の確認で失敗」と同じエラーを返す。これで「確認の後、`begin` の前に EOF が来る」窓がなくなる（洗い出し 2.4）。
- 同時に1件だけ待てる契約は変えない。

### 3.5 切り離し（C2・C3）

- 呼び出し側（ホストのロックを持つスレッド）が、`LinkState` を `Closed(Isolated)` にする → 今の `kill_engine` 相当の後始末（`kill_primary_engine` か、配信ミックスなら `discard_child`。`retire_child` を通る。`engine_generation` の更新点は今のまま）→ 失敗の文言を返す。
- 切り離しは、詰まった writer の後ろに何も積まない。子を終わらせる手段（`TerminateProcess`、Job の破棄）は writer を通らない。
- `audio-error`（`音声エンジンとの通信が切れました`）は、今の書き込みの失敗の経路と同じく出す。C3 でも同じ通知を出す（新しい通知の名前は作らない）。
- **配信ミックス**：子の `AudioHost` の命令で起きた切り離しは、子の `AudioHost` の中で `LinkState` を閉じ、主の `PostMix` が今の EOF の後と同じ経路（`snapshot` などで `release_engine`）で片付ける。主の待ちは、子の命令の失敗として返る（今の子の EOF のときと同じ）。

### 3.6 C5：出力だけが閉じた子の作り直し

- `ensure_engine_running`（今の `audio.rs:735-763`）で、子が生きている（`try_wait` が `Ok(None)`）のに `LinkState` が `Closed(Eof)` のときは、`retire_child` で終わらせてから作り直す。
- 対象は、`ensure_engine_running` を通る操作だけ（今、子を起動しうる入口）。停止（`stop`）・読み取り・`engine_exit.rs:196` の起動禁止の操作は、今と同じく子を作らない。
- 主と配信ミックスの両方に効く（配信ミックスの子も `ensure_engine_running` で作られる）。

### 3.7 `emitter` の poison

- `emitter.lock().unwrap()` の20か所を、poison でも中身を使う形（`unwrap_or_else(PoisonError::into_inner)`）にそろえる。通知の内容と順は変えない。

## 4. 変えないことの確認（互換）

- 旧の通知の名前・中身・順（K 群、K13 の `Start`・`Stop` の通知の順、W5）。N2 で捨てるのは古い接続の行だけ。
- 書き込みの失敗の経路の通知（`audio-error`）と、元のエラーの文言。
- 応答の期限の起点（flush の後から10秒）。
- `engine_generation` の更新点、`stream_generation` の表示。
- ホストのロックの持ち方（書き込みと応答の待ちの間も、今と同じく呼び出し側がロックを持つ。待ちの上限が 5秒＋10秒 に決まるだけ）。
- K2・K10（読み取りは先に受け付けた操作の完了を待つ）。上限が有限になる。

**書き換える試験：** `commands/audio/compat_tests.rs:644-661` の `timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request` は、C3 で「次の命令を妨げない・接続を切り離す」に変わる（J-17 の承認の範囲）。

## 5. 合格の条件と試験の形

| # | 確かめること | 試験の形 |
|---|---|---|
| T1 | C2：子が stdin を読まない（実パイプを満杯にする）→ 5秒で失敗、子が終わる、`audio-error`、次の操作で作り直す。待つ間に別のスレッドから読み取りを出すと、5秒＋α で返る | 実プロセス（F1a-0 の scripted child に「stdin を読まない」段を足す）。期限は試験の継ぎ目（`#[cfg(test)]`）で短くする |
| T2 | 書き込みの失敗が応答より優先：早く届いた応答の後に `done(Err)` | 試験の継ぎ目で writer の結果を差し替える |
| T3 | C3：応答が来ない → 10秒で失敗、子が終わる、次の停止が「応答待ち」で失敗しない | scripted child（応答しない段）。期限を短くする |
| T4 | 3.4 の窓：reader の EOF と `begin` の競合で、待ち手が10秒待たずに失敗する | scripted child の WaitGate で順を作る |
| T5 | C5：stdout だけ閉じた子 → 次の開始で作り直す。停止・読み取りでは作らない | 実プロセス（scripted child が stdout だけ閉じる） |
| T6 | N2：作り直しの直後に、古い接続の reader が出す9種の通知が届かない | scripted child と Recorder。照合と切り替えの順を WaitGate で作る |
| T7 | 配信ミックス：C2・C3・C5 が配信ミックスの子でも効き、主の待ちが有限で返る | scripted child（配信ミックスの役割） |
| T8 | 互換：K 群・W5 の列・`engine_life` の試験が通る。書き換えるのは T3 に当たる1件だけ | 既存の試験 |
| T9 | 壊して確かめる：writer の期限を外す・照合を外す・`closed` を外すと、それぞれ T1・T6・T4 が失敗する | 一時的な改変 |
| T10 | 実アプリ：開発ビルドで、子の stdin を詰まらせる（デバッグ用の手段がなければ省き、理由を書く）・子の stdout を閉じる、で固まらないこと | 実アプリ（できる範囲） |

## 6. 未決（レビューで確かめたいこと）

1. writer の列の容量を1にしてよいか（直列の命令で、今と同じく1件ずつ）。
2. C3 で切り離した後の停止を「接続なし」の停止（今の経路）にする扱いで、`stop_audio` の結果と通知が今の「接続なしの停止」と同じになるか（W5 の場面 D）。
3. N2 で `emitter` の `Mutex` の下で照合することが、`emit` の詰まり（洗い出し 7.4）を広げないか。
4. 配信ミックスの子の切り離しで、主の `PostMix` の状態（`running` など）が、今の子の EOF の後と同じになるか。
5. C2・C3 の文言（`COPY_GUIDELINES`）。

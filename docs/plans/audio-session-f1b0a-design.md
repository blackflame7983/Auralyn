# F1b-0a 接続の部品の設計（第3版）

状態：設計（統括の案、第3版）。第1版（`402d64a8`）・第2版（`46dabd08`）への独立レビュー（2回 BLOCK）のあと、Gemini 4 Neon の助言と、利用者の決定 J-22・J-23 を受けて直した。

前提の文書：
- 今の事実：`audio-session-f1b0-inventory.md`（以下「洗い出し」）。
- 変わる挙動：`audio-session-f1b0-changes.md`（C1〜C5・N1〜N3、J-17・J-18）。
- 方式：`audio-session-f1b0-options.md` の 7章（第4の案、J-19・J-20）。

## 0. 分け方（J-22）

F1b-0a を2つの PR に分ける。

| PR | 入れるもの | 応答の期限の挙動 |
|---|---|---|
| **F1b-0a-1**（この設計の 1〜5章） | 接続の土台（writer のスレッド・`LinkState`・`ReplySlot` の閉じた状態・回収の分離）、C2、EOF と待ちの窓、通知をロックの外で出す、N2 の一部、C5（主）、配信ミックスの失敗の共通の境界 | **変えない**（今の10秒・期限の後に待ちが残る、のまま） |
| **F1b-0a-2**（6章） | C3（応答の期限で切り離す）、命令の種類ごとの期限（J-23）、モード VST の期限をそろえる、`ProbeLoopback` の上限 | 変える |

F1b-0a-1 は応答の期限に触れないので、互換の試験の期待値を変えずに入れられる。

## 1. F1b-0a-1 の範囲

| 入れる | 変わる挙動 |
|---|---|
| 子の stdin を、接続ごとの writer のスレッドだけが持つ。モード VST も同じ writer を通す | なし（土台） |
| 書き込みが5秒終わらなければ、接続を切り離す | C2 |
| 要求の完了・接続の終了の理由・子の回収を分ける（2章） | なし（競合の不具合の予防） |
| `ReplySlot` の閉じた状態で、EOF と待ちの登録の間の窓をなくす | 今の不具合の修正 |
| 通知を `emitter` のロックの外で出す。子の回収の経路から通知の待ちを外す | 今の不具合の修正（通知の内容と順は変えない） |
| reader は、通知を出す直前ごとに自分の接続が開いているかを確かめる | N2 の一部 |
| 主の子の stdout だけが閉じて子が生きているとき、次に子を起動しうる操作の時点で作り直す | C5（主だけ） |
| 配信ミックスの子への命令を1つの口に集め、失敗をそこで受ける | 今の `?` の抜け道の修正 |

入れないもの：C3・J-23（F1b-0a-2）。reaper・N3・C1・C4・N1・N2 の完全な形・配信ミックスの自動の作り直し（F1b-0b）。

## 2. 3つの責務の分離（Neon の最小の設計）

### 2.1 要求の完了：`ReplySlot`（葉のロック。I/O と `emit` をしない）

```text
ReplySlot 状態 = Idle | Waiting(Sender<ReplyOutcome>) | Closed
ReplyOutcome = Response { resp, received_at: Instant } | Eof
```

- `begin()`：`Idle` なら `Waiting` にして受け側を返す。`Waiting` なら今の「前の音声操作の応答待ちです」。`Closed` なら今の「送る前の確認で失敗」と同じエラー。
- `deliver_response(resp)`：`Waiting` のときだけ `Idle` にして送る（`received_at` は reader が打つ）。それ以外は今と同じくログだけ。
- `close() -> Option<Sender>`：一度だけ `Closed` にし、保留中の送り側を取り出して返す。
- **F1b-0a-1 では、応答の期限の後の扱いを今のまま保つ**：期限の後も `Waiting` のまま残り、遅い応答が来れば `Idle` に戻る（今の `replies.rs:50-62` の試験の契約）。C3 で変えるのは F1b-0a-2。

### 2.2 接続の終了の理由：`LinkState`（`AtomicU8`、一度だけの CAS）

```text
Open -> Closed(Intentional | Eof | WriteFailed | WriteTimeout)    // F1b-0a-2 で ReplyTimeout を足す
```

- 今の `reader_active: Arc<AtomicBool>` と `unexpected_exit(&AtomicBool)`（`engine_exit.rs:345`）を、`LinkState` の1本にまとめる。二重の判定をなくす。`Operations` は原因の記録を取り出すだけ（`take_exit()`）にする。
- **CAS の勝ち負けが決めるのは「誰が終了の通知を出すか」だけ**：EOF に勝てば reader が `audio-engine-exited`＋`audio-error` を出す。Host の切り離し（C2・書き込みの失敗）に勝てば Host が `audio-error` を出す（主のときだけ）。意図した終了に勝てば通知なし。
- `reader_active` を参照する箇所は用途で分けて移す：(a) 読み取り・起動禁止の判定、(b) reader の終了の判定、(c) 明示の無効化、(d) 試験の状態の注入。

### 2.3 子の回収：Host が無条件に行う

Host が接続を捨てる経路（書き込みの失敗・C2・C5・`kill_engine`・`release_engine`・`take_engine_for_shutdown`・`Drop`）は、`LinkState` の CAS の勝ち負けに関係なく、次を**必ずこの順に**行う。

1. `LinkState::close(cause)`（勝ち負けを記録）
2. `ReplySlot::close()`（取り出した送り側は捨てる。待ち手は `Disconnected` で解放される）
3. writer の送り側を捨てる（writer を join しない）
4. `child.take()` → `retire_child`（F1a-1。Job と `retired` の規則）
5. **ここまで、`emitter` を取らない。** 通知（`audio-error`、`audio-conditions-changed`、モード VST の取消の通知）は、4 の後に出す。

これで、reader が `emit` の途中で止まっていても、子の回収は止まらない。

### 2.4 EOF の順（reader）

1. `ReplySlot::close()` で送り側を取り出す（以後の `begin` を締め出す。窓がなくなる）。
2. `LinkState::close(Eof)` を試す。
   - **負けたら**：取り出した送り側をその場で捨てる（待ち手は `Disconnected` で解放）。通知は出さない。
   - **勝ったら**：原因を採取 → 今の EOF の通知（`audio-conditions-changed` → `audio-engine-exited` → `audio-error`）→ 取り出した送り側へ `Eof` を送る。通知が待ち手の解放より先（今の `compat_tests.rs:106` の順）。
3. 呼び出し側は `Eof` を今の `Response::Error("Engine Crashed/Exited")` と同じ結果に写す（文言を変えない）。

### 2.5 書き込みの失敗と早い応答

- 呼び出し側は `WriteDone` を必ず5秒待つ。`Err` か5秒を過ぎたら、応答の受け側を読まずに 2.3 へ進む（書き込みの失敗が先。今と同じ）。
- `WriteDone(Ok)` の後に応答を待つ。期限（今の10秒）は writer が返す `flushed_at` から数える。

## 3. 部品

### 3.1 writer

- 接続ごとに1本。`BufWriter<ChildStdin>` の唯一の持ち主。ホストの `stdin` の項目はなくなる。
- 列の容量は1。送るときはブロックしない（`try_send`）。満杯・切断は書き込みの失敗。
- `LinkState` が閉じたあとは、列から次の書き込みを始めない。
- `WriteDone { result, flushed_at }` を返す。
- 子を終わらせるとパイプが壊れ、詰まっていた `flush` は `Err` で戻り、writer は終わる。

### 3.2 モード VST

- 今の「`stdin` を `take` して使い捨てのスレッドへ渡し、tick で戻す」をやめ、同じ writer の列に送り、`WriteDone` と応答を tick の `try_recv` で受け取る。
- **F1b-0a-1 では期限を変えない**：今の「送ってから10秒」の判定、書き込みの結果を応答より先に判定、停止・緊急のミュート・世代の変更の後の旧い結果を採らない、結果が分からないときのジャーナルと復旧が要る状態、JSON 化をロックの外で行う、をすべて保つ。10秒の起点は「書き込みのスレッドを起こした後」から「writer の列に送った後」になる（差はスレッドの生成の時間だけ）。

### 3.3 通知をロックの外で出す（Neon の指摘）

- `AudioEmitter` は `Clone`（`emit.rs:40`）なので、`emitter` のロックを短く取って `Option<AudioEmitter>` を `clone()` し、**ロックを放してから** `emit` する共通の関数を1つ作り、今の20か所の `emitter.lock().unwrap().as_ref()` → `emit` を置き換える。poison は `into_inner` で中身を使う。
- 通知の内容と順は変えない。同じ `if let` の中で続けて出していた2つの通知（`audio-conditions-changed` と本体）も、同じ順で出す。
- `kill_primary_engine`（`audio.rs:2796`）は、2.3 の順に並べ替える：接続を閉じて子を回収してから、`cancel_mode_vst` と `notify_conditions_changed` の通知を出す。状態の変更（`post_attached`、`live_modes.needs_sync`、`conditions.retire_engine()`、`engine_generation` など）の順は今のまま、通知だけを後ろに回す。
- `Conditions::dispatch` の IPC の前の通知は、切り離しの経路ではないので、この段では変えない（IPC の開始前に通知で待つことはありうる。F1b-0b で扱う）。

### 3.4 reader

- 行の始めと、通知を出す直前ごとに `LinkState` が `Open` かを確かめる。確認の直後に閉じた場合、1つの通知が出うる（完全な形は F1b-0b）。
- `emit` はロックの外になるので、reader が `emit` で止まっても、Host の `emitter` の取得は止まらない。

### 3.5 配信ミックスの失敗の共通の境界（Neon の指摘）

- `post_mix::State` に、子へ命令を送る唯一のメソッド `exec_child` を作る。今 `child.execute_running_command` を直接呼んでいる箇所（`rack`・`command`・`capture_bundle`・`restore_bundle`・`stop`・`start`・`snapshot`・`RestoreSaved`）は、すべてここを通す。
- `exec_child` は、失敗が返り、子の `LinkState` が閉じていれば（C2・書き込みの失敗・EOF）、戻る前に：`self.child = None`（子の回収は子の `AudioHost` の 2.3 で済んでいる）、`restored = false`、`running = false`。`enabled` と保存した設定は残す。そのあと元の失敗を返す。
- 主の `post_attached` と転送：**今の配信ミックスの EOF と同じ扱い**にする。主が停止中なら解除、主が稼働中なら `post_attached` を残し、次の停止・`cancel_prepared_post_start`・次の `prepare_post_mix_start` で解除する（`post_mix.rs:731-738`。主が稼働中は `PostMixClear` が拒否されるため、失敗の直後には送らない）。
- 配信ミックスの子の切り離しでは、主の `audio-error` を出さない。
- 復元の途中で外側が `enabled` を下ろす場合（`discard_child`）や、配信セット全体の巻き戻しで `State` を作り直す場合は、今の挙動のまま（`exec_child` の整合の後に、外側の処理がさらに上書きする）。

### 3.6 C5（主だけ）

- `ensure_engine_running` で、主の子が生きている（`try_wait` が `Ok(None)`）のに `LinkState` が `Closed(Eof)` のときは、2.3 で子を回収してから作り直す。
- 対象は `ensure_engine_running` を通る操作だけ。停止・読み取り・起動禁止の操作は作らない。
- 配信ミックスは対象にしない（次に使うときは保存したラックの明示の復元を通る）。

## 4. 変えないことと、意図して変える互換（F1b-0a-1）

**変えない：** 旧の通知の名前・中身・順（K 群、K13、EOF の通知が待ち手の解放より先）。書き込みの失敗の経路と文言。応答の期限（10秒）とその後の待ちの残り方（`timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request` もそのまま通る）。ホストのロックの持ち方、K2・K10・K11。`engine_generation` の更新点。モード VST の期限。

**意図して変える（J-17 の範囲）：** C2（書き込み5秒で切り離し）、C5（主）。

**試験のコードの直し（期待値は変えない）：** `stdin = None` で書き込みの失敗を作る試験（`engine_life_tests.rs:228` 付近、`post_mix_life_tests.rs:82` 付近）と、`reader_active`・`stdin` を直接組み立てる試験を、writer の失敗を差し込む継ぎ目（`#[cfg(test)]`）へ移す。

## 5. 合格の条件と試験の形（F1b-0a-1）

| # | 確かめること | 形 |
|---|---|---|
| T1 | C2：実パイプを満杯にする → 5秒で失敗、子が終わる、主なら `audio-error`、次の操作で作り直す。満杯・切断済みの writer への送信。待つ間に別のスレッドの読み取りが有限で返る（5秒＋回収） | 実プロセス（scripted child に「stdin を読まない」段）。期限は継ぎ目で短く |
| T2 | 書き込みの失敗が早い応答より先 | 継ぎ目で `WriteDone` を差し替える |
| T3 | 応答の期限の起点が `flushed_at`（`WriteDone` の受け取りを遅らせても期限が延びない） | 継ぎ目 |
| T4 | EOF と `begin` の窓：親の `begin` の直前で止める継ぎ目と子の WaitGate で、EOF が先でも待ち手が期限を待たずに失敗する | 継ぎ目＋WaitGate |
| T5 | 2.4 の順：EOF の通知が待ち手の解放より先。CAS に負けた EOF は通知を出さず、待ち手は解放される | 継ぎ目 |
| T6 | 2.3 の回収：reader を `emit` の途中で止めたまま、C2 で子が終わり、`retire_child` が呼ばれる（通知を止めても回収は進む） | 継ぎ目（`emit` を止める） |
| T7 | 正常な応答の後も、同じ接続で次の命令が通る | scripted child |
| T8 | C5（主）：stdout だけ閉じた子 → 旧の PID が回収され、次の開始で作り直し（`engine_generation` が進む）。停止・読み取り・起動禁止の操作では作らない | 実プロセス |
| T9 | N2：通知の直前の確認で、閉じた接続の通知が出ない。ロックを待つ間に旧い接続になった場合も | 継ぎ目 |
| T10 | 配信ミックス：`exec_child` を通る全経路（`rack`・`snapshot`・`capture_bundle`・`start`・`stop`・`RestoreSaved`）で、C2・書き込みの失敗・EOF の後に、失敗が戻った**直後**の `enabled`/`restored`/`running`・`child`・主の PID・主の `audio-error` が出ないこと・`post_attached`（主が稼働中・停止中）を確かめる | scripted child（配信ミックス） |
| T11 | モード VST：writer の列を通る書き込み、書き込みの詰まりの間の停止、旧い結果を採らない（既存の `mode_vst.rs:2082`・`2123` を移植し、期限が今のままであること） | 既存の試験の移植 |
| T12 | `emitter` の poison：後続が panic しない。通知の内容と順が変わらない | 継ぎ目＋既存 |
| T13 | `Drop`：writer が詰まっていても、共通の2秒（F1a-1）で終わり、writer を join しない | 継ぎ目 |
| T14 | 互換：K 群・`engine_life`・`replies.rs` の単体試験・既存の Rust 試験がすべて通る。**期待値を変える試験はない** | 既存 |
| T15 | 壊して確かめる：writer の期限、`ReplySlot` の閉じた状態、回収の前の通知の除去、通知の直前の確認、`exec_child` の整合を外すと、それぞれ T1・T4・T6・T9・T10 が失敗する | 一時的な改変 |
| T16 | W5：通知の順を、対応する release の子で測り直す（場面 A〜E） | 実 WebView |

## 6. F1b-0a-2（C3 と命令ごとの期限）の決定事項

F1b-0a-1 のマージの後に、別の設計の節として詳細を書く。決まっていること：

- **J-23（利用者）：応答の期限を命令の種類で決める。**

| 分類 | 応答の期限 | 対象 |
|---|---|---|
| A 通常の操作・状態の読み取り | 10秒 | メモリの操作・RT の列への投入・スナップショットの読み取りだけの命令（ゲイン・ミュート・統計・`PostMixStatus`・`PollDeviceScan` など） |
| B VST・音声機器・ファイルをその場で呼ぶ命令 | 30秒 | `LoadPlugin`・`RestorePlugin`・`RestoreSessionPlugin`・`GetPluginState`・`SetPluginState`・`CaptureBundleState`・`CaptureMixingBundleState`・`OpenEditor`・`UnloadPlugin`・`PostMixStart`・`Start`・**`Stop`**・`GetDevices`・`AutoGain`（試聴の開閉を含む要求）・`VoiceCheckPreview`（別の出力の試聴の開閉を含む要求）・`ExportVoiceCheck` |
| C 長さが変わる同期の計測 | 録音の時間＋10秒 | `ProbeLoopback`。録音の時間を最大10秒に制限する |

- 分類は、Rust で命令の型に対する網羅の `match`（`_` を使わない）で決め、命令を足したときに分類の漏れがコンパイルで分かるようにする。
- モード VST も同じ表にそろえる（遷移の全体の120秒は保つ）。
- 期限を過ぎたら接続を切り離す（C3）。`ReplySlot` の `ReplyOutcome` の `received_at` が期限より後なら、受け取っても期限切れとして扱う。`LinkState` に `ReplyTimeout` を足す。
- 返す文言は、子の終了を確かめられたら「音声エンジンが応答しないため、終了しました。もう一度お試しください」、確かめられなければ F1a-1 の `engine_unconfirmed`。

# F1b-0b セッションの中心部の作り直しの設計（第1版・骨子）

状態：設計の骨子（第2版）。Gemini 4 Neon のレビュー（条件つき）を受け、7章で方式と分け方を決めた。次は 7.4 の段ごとの詳細設計。

前提の文書：
- 今の事実：`audio-session-f1b0b-inventory.md`（bcd2dca2 の時点。以下「洗い出し」）。
- 変わる挙動：`audio-session-f1b0-changes.md`（C1・C4・N1・N2・N3、J-17・J-18・J-20）。
- 土台：`audio-session-f1b0a-design.md`（F1b-0a-1）、`audio-session-f1b0a2-design.md`（F1b-0a-2）。両方の既知の狭い競合3件（F1b-0a-1 の11章、F1b-0a-2 の6章）を、この段の合格の条件にする。
- 利用者の決定（2026-11-22）：F1b-0b は「部分的な作り直し」として進める。親の側のセッションの中心部（状態の持ち主・受付・接続）を `AudioControl` の後ろで新しく作り、今の95か所の入口はつなぎとして流す。子との IPC と旧い通知はそのまま。

## 1. この段で達すること

| # | 挙動（利用者から見て） | 今（洗い出し 4章） |
|---|---|---|
| C1 | 停止は、先に並んでいる通常の操作より先に実行する。停止より前に受け付けた「音を鳴らす・子を起動する」操作は、実行の前に断る | ロックを取れた順。std の `Mutex` は公平でない |
| C4 | 終わっていない操作が256件を超えたら断る。通常の操作は受付から60秒で始まらなければ失敗。停止は断らない。長い操作は一歩ごとの期限だけ（J-20） | 上限なし。`Admission` は記録だけで、件数も完了も持たない |
| N1 | トレイ・ショートカットは呼び出しのスレッドで待たない | トレイはイベントループのスレッドでホストのロックを待つ |
| N2 | 古い接続の通知を出さない（完全な形） | 通知の直前の確認だけ（1つの列が出うる） |
| N3 | 終了の確認の待ちで、ほかの操作が止まらない | `ensure_clear` がホストのロックと `Store.slots` を持ったまま最大10秒待つ |
| K1〜K3 | 既知の狭い競合3件をなくす | 洗い出し 2.4 |

変えないもの：子との IPC、旧い通知の名前・中身・順（K13・W5）、エラーの文言（C1・C4 で足す文言を除く）、`engine_generation` の更新点、読み取りが先の操作の完了を待つ境界（K2・K10）。

## 2. 方式の比較（決めること3つ）

### 2.1 実行の持ち主：どこで命令を実行するか

| 案 | 中身 | 良い点 | 危険 |
|---|---|---|---|
| 2.1-A 実行のスレッド（推奨） | 1本の「実行のスレッド」が `AudioHost`（主と配信ミックスの子を含む）を持つ。入口は `AudioControl::run(entry, |host| …)` で、閉包を受付の列に積み、結果を待つ。今の入口の本体は閉包の中身としてそのまま使う | 実行の順を1か所で決められる（C1・C4）。入口の本体を書き換えない。トレイは積んですぐ戻れる（N1） | 閉包の中で子の応答を待つ間、実行のスレッドは止まる（今のロックを持った待ちと同じ） |
| 2.1-B 今の `Mutex` の前に順番の入口を置く | ロックは残し、取る順だけを入口で決める | 変更が小さい | 第1回の方式比較で、ロックを貸し出す形を残すと二重の移行になると判断した（options 7.1） |

### 2.2 reader の役割：通知と状態の更新を誰が行うか

| 案 | 中身 | 良い点 | 危険 |
|---|---|---|---|
| 2.2-A reader は今のまま通知を出し、状態だけを1つの遷移にまとめる（推奨） | reader は今と同じく旧い通知を直接出す（W5・K13 の順を保つ）。ただし、reader と実行のスレッドの両方が触る接続の状態（`LinkState`・`ReplySlot`・`vst_operations` の終了の原因・配信ミックスの切断の記録）を、**1つの `Mutex` の下の1つの状態機械（`LinkCell`）**にまとめる。CAS と送り側の取り出しと原因の採取を、同じロックの区間で行う | 既知の狭い競合3件の根（2つの状態が別々に変わる）を直接なくす。通知の順は今のまま | reader が `LinkCell` のロックを取る間、`emit` をしない規則が要る |
| 2.2-B reader は行を実行のスレッドへ送るだけにし、通知も実行のスレッドが出す | 状態の持ち主が完全に1つになる | 閉包が子の応答を待つ間は、実行のスレッドが通知を出せない。応答より前に通知を出す今の順（K13）を保つには、待ちの中で受信箱を読む「ポンプ」が要り、再入の順が複雑になる（第1回の方式比較で、案 A の最大の危険とした点） |

### 2.3 終了の確認（N3）

| 案 | 中身 |
|---|---|
| 2.3-A reaper（推奨） | 子ごとに reaper のスレッドが `WaitForSingleObject` で待ち、終わったら `retired` の記録を消して実行のスレッドへ知らせる。`ensure_clear` は、期限まで reaper の知らせを条件変数で待つ（`Store.slots` のロックを持たない）。待つ間も実行のスレッドは止まるが、ほかの入口の受付（C1 の停止の受付、N1）は止まらない |
| 2.3-B 実行のスレッドの外で作り直しを待つ | 作り直しを要する操作を「保留」にして、終わったら再開する。段の状態機械が要る（F1b 本体の範囲） |

## 3. 推奨の組み合わせと、その理由

**2.1-A ＋ 2.2-A ＋ 2.3-A。**
- 閉包の中の待ちは、今の「ロックを持った待ち」と同じ性質なので、K2・K10・K13 の互換を保てる。2.2-B のポンプを避けられる。
- 既知の狭い競合3件は、どれも「reader と実行の側が、別々の状態を別々の順で変える」ことが根（洗い出し 2.4）。2.2-A の `LinkCell` で、その根を1か所で断つ。
- C1 の「停止を先に」は、受付の列の優先度で決まる。実行中の閉包は割り込まない（J-18）。
- N1 は、トレイ・ショートカットが閉包を積んで戻るだけになる。

## 4. 互換の安全網（洗い出し 5章の事実への対応）

- 公開の入口だけで書かれた試験（K 群、`control_tests`）は、そのまま通る必要がある。
- 内部に結び付いた試験（`post_mix_life_tests` 153 か所、`config_storage_tests` 128、`link_tests` 61、`engine_life_tests` 44、`reply_deadline_tests` 29 など）は、作り直しで壊れうる。**作り直しの前に、それらの試験の性質を、公開の入口（または `AudioControl::run` の上）から確かめる形へ移す段（F1b-0b-0）を置く。** 期待値は変えない。移せない試験は、理由と、代わりに守る性質を記録する。
- W5 は手動の測定。F1b-0b の後に測り直す。

## 5. 分け方（案）

| 段 | 中身 | 挙動 |
|---|---|---|
| F1b-0b-0 | 安全網を公開の入口へ移す（4章） | 変えない |
| F1b-0b-1 | `LinkCell`（2.2-A）。既知の狭い競合3件を根から直す | 競合の窓が閉じる（K1〜K3） |
| F1b-0b-2 | 実行のスレッド（2.1-A）と受付の列。C1・C4・N1 | 変える（J-17） |
| F1b-0b-3 | reaper（2.3-A）。N3 | 変える（ほかの入口が止まらない） |
| F1b-0b-4 | N2 の完全な形（`LinkCell` の世代で、通知の列の直前に照合） | 変える（古い通知が出ない） |

## 6. 未決（レビューで決めたいこと）

1. 2章の3つの選択（推奨の組み合わせ）は妥当か。
2. 2.2-A の `LinkCell` で、既知の狭い競合3件が本当に根から消えるか（洗い出し 2.4 の窓ごとに）。
3. 2.1-A で、閉包の中で子の応答を待つ間に実行のスレッドが止まることが、C1（停止を先に）・N3 と矛盾しないか（J-18：実行中の命令は応答を待ってから停止）。
4. F1b-0b-0（安全網を移す段）を先に置く判断と、その範囲。
5. 5章の分け方と順。

## 7. Neon のレビュー（骨子の第1版）を受けた決定

判定は「条件つき」。必須の3点を、次のとおり決めた（統括）。2.1-A・2.2-A は妥当、2.3-A は直す。

### 7.1 `LinkCell` の範囲を広げる（必須1：既知の狭い競合3件を根から閉じる）

- **競合1**：`begin`（`Open` の確認・`ReplySlot` の登録・`vst_operations.begin`）と、reader の `close_eof`（閉鎖・待ち手の取り出し・`take_exit`）を、同じ `LinkCell` のロックの区間にする。さらに、writer が書き込みの直前に `LinkCell` の下で操作を「送った」に上げ、`Aborted` になった操作を終了の原因から外す。`cut_off` の順（`vst_operations.response` が CAS の前）も、同じ区間の中の順にそろえる。
- **競合2**：配信ミックスの失敗の後始末を、`LinkCell::close(Intentional)` の1つの遷移にする。勝ったときだけ `discard_child()`、すでに EOF・期限切れで閉じていれば `detach_with()`（`enabled` を残す）へ分ける（今の「`settle()` の後に `detached` の数を比べる」2段をやめる）。
- **競合3**：経路 (b)（別の回収が待ち手を横取りする）は `LinkCell` で閉じる。経路 (a)（`reply_timed_out` が EOF に負けたとき、通知の前に `ENGINE_EXITED` を返す）は、負けたら `LinkCell` と通知の列のロックを持たずに、reader が通知の後に送る `Eof` を待ってから返す。

### 7.2 N3：作り直しの待ちを実行のスレッドの外へ出す（必須2。案 (a) を採る）

- 2.3-A のままでは、`ensure_clear` の最大10秒の待ちで実行のスレッドが止まり、停止もミュートも読み取りも止まる。N3 と C1 に反する。
- **決定**：子を起動しうる入口は、`retired` が空でなければ、**実行のスレッドへ入る前に**（受付の側で）reaper の知らせを期限まで待つ。待つ間、ほかの入口は実行のスレッドで進む。実行のスレッドの中の再確認で記録が残っていた場合は、待たずに今の規則（`engine_unconfirmed`）で答える。待っている間に C1 の停止が届いたら、待ちを起こして、その開始を断る（停止より前に受け付けた開始の扱い、C1）。
- `retire_child` の最大2秒の確認は、この段では今のまま実行のスレッドの中に残す（`engine_unconfirmed` の判定を変えないため）。reaper へ移すかは F1b で決める。

### 7.3 N2 の完全な形（必須3）

- 世代の照合だけでは、照合の直後に閉じたときの1列の窓が残る。**閉じる側は、閉じた後に通知の列のロックを1度通して、進行中の旧い列を掃き切ってから次へ進む**（または、通知の側の有効な世代の更新を、通知の列のロックの下で行う）。どちらにするかは詳細設計で決める。
- 旧い reader の `voice_activity.store(true)` が `kill_primary_engine` の後に残る窓と、`ensure_clear` の間に `engine_epoch` が古いまま `engine_event` が通る窓も、`LinkCell` の閉鎖と `retire_engine` にそろえて閉じる。

### 7.4 段の分け方の直し

| 段 | 中身 | 挙動 |
|---|---|---|
| F1b-0b-0 | 安全網の整理（範囲を絞る）：(1) 洗い出し 5.3 の固定していない約束（既知の競合3件、`cut_off`、`voice_activity`）の試験を足す。(2) `LinkCell`・reaper で壊れる試験（`link_tests`・`reply_deadline_tests`・`post_mix_life_tests`・`engine_life_tests` の内部の直接の参照）だけを、今の公開の入口と最小の継ぎ目へ寄せる。`config_storage_tests`・`device_scan_tests` は触らない | 変えない |
| F1b-0b-1 | `LinkCell`（7.1） | 競合の窓が閉じる |
| F1b-0b-2a | 実行のスレッドへの移し替えと N1（受付の順は今と同じ FIFO） | ほぼ変えない |
| F1b-0b-2b | C1・C4（受付の列の優先度と上限） | 変える（J-17） |
| F1b-0b-3 | reaper と、作り直しの待ちを外へ出す（7.2）。N3 | 変える |
| F1b-0b-4 | N2 の完全な形（7.3） | 変える |

### 7.5 詳細設計で扱うこと（Neon の未決3の指摘）

- 複数の IPC を続ける閉包（`apply_profile`・`set_output_gain` の100回の確認など）には途中の確かめの点がなく、停止が全段の後まで遅れる。J-20（一歩ごとの期限、停止が来たら次の命令を送る前に止める）の確かめの点を、共通の IPC の口に置く。
- トレイ・ショートカットのミュートが `interrupt_restore` を取らない（洗い出し 6.9）。C1 の停止の受付と同じ扱いにするかを決める。

## 8. F1b-0b-0 の詳細（安全網の整理。挙動は変えない）

前提：コードは main `5d4e8d31` のとおり。`ファイル:行` は `src-tauri/src/` を基準にする（試験は `audio/tests/`）。7章の決定は変えない。決め切れない点は「未決」として 9.9 にまとめた。なお、依頼にあった「`audio-session-f1a0-design.md` の 11章」は、このフォルダーに無い。同じ内容（既知の狭い競合3件）は `audio-session-f1b0a-design.md` の 11章にあるので、それを使った。

### 8.1 方針：継ぎ目を1か所に集める

- F1b-0b-1 で消える型は `ReplySlot`・`engine_exit::Operations`・`LinkState` の3つ（`audio.rs:292,293,298`）。試験がこれらを直接つかむ場所は、`ReplySlot` の `begin`・`deliver`・`close`・`cancel`、`Operations` の `begin`・`response`、`Reader` の構造体リテラル（`link`・`operations`・`replies`）、「reader の勝ちを真似る」ための `link.close(Eof)` と `pending_reply_tx.close()` の組、の4種類に限られる。
- F1b-0b-0 では、試験の側に **継ぎ目の窓口の1つのファイル `audio/tests/link_seam.rs`（新設。`#[cfg(test)]` の自由関数）** を置き、上の4種類をすべてここ経由にする。F1b-0b-0 の時点の中身は今の部品を呼ぶだけ。F1b-0b-1 では、窓口の中身だけを書き換える。
- 窓口の関数（案）：

| 関数 | F1b-0b-0 の中身（今） | F1b-0b-1 の中身 |
|---|---|---|
| `begin_request(&AudioHost, Option<&Command>) -> Result<Receiver<ReplyOutcome>>` | `pending_reply_tx.begin()`、続けて `vst_operations.begin(cmd)`（`audio.rs:1075-1076` と同じ順） | `link.begin(cmd)` |
| `deliver(&AudioHost, Response)`・`deliver_at(…, Instant)` | `pending_reply_tx.deliver*` | `link.deliver*` |
| `win_eof(&AudioHost) -> Option<Sender<ReplyOutcome>>` | `link.close(Eof)` が勝てば、`pending_reply_tx.close()` を返す（reader の勝ちの真似） | `link.close_eof()` の `waiter`（`exit` は捨てる） |
| `take_exit(&AudioHost) -> ExitPayload` | `vst_operations.take_exit()` | `close_eof()` の `exit`、または試験専用の取り出し |
| `register_sent_operation(&AudioHost, &Command)` | `vst_operations.begin(cmd)` | `begin` の後に `mark_sent` |
| `reader_for(&AudioHost, epoch) -> Reader` | `Reader { link, operations, replies, … }` を組む（`link_tests.rs:30-41`、`reply_deadline_tests.rs:56-69` の2つを1つにする） | `Reader { link, … }` |
| `cancel(&AudioHost)` | `pending_reply_tx.cancel()` | `link.cancel()` |

- `host.link.is_open()`・`host.link.cause()`・`host.link.close(cause) -> bool`・`Writer::start(sink, host.link.clone())`・`set_link_for_test`・`attach_stdin_for_test`・`fail_writes_for_test`・`replace_writer_for_test` は、F1b-0b-1 の `LinkCell` が同じ名前と戻り値で残す（9.1）ので、寄せない。これで寄せる数が小さくなる。

### 8.2 足す試験の一覧（9本）

ID は 8章の中だけで使う（`S1`〜`S9`）。「今」の挙動を固定する試験は、名前に `today_` を付ける。F1b-0b-1 で期待値を変えるものは、9.6 の表で「どう変えるか」を決めてある。

| ID | 名前の案 | 置く場所 | 使う継ぎ目 | 確かめること（今の挙動） |
|---|---|---|---|---|
| S1 | `s1_today_an_unsent_vst_operation_is_named_as_the_exit_cause` | `link_tests.rs` | `reader_for` の `Reader::pause`（`reader.rs:289-292`）、`link_seam::begin_request`、`await_reply` に `Aborted` の `WriteDone` を直接渡す（`link_tests.rs:702` と同じ形）。pause の解放は別スレッドで少し後に行う | reader が EOF の CAS に勝って止まっている間に `begin_request(Some(LoadPlugin))` が通る。`await_reply` は `Engine Crashed/Exited`（ENGINE_EXITED）。解放後の `audio-engine-exited` の `cause == "vst_operation"`・`op == "load"`（送っていない操作が原因に載る。競合1） |
| S2 | `s2_today_an_eof_right_after_settle_drops_enabled` | `post_mix_life_tests.rs` | 新しい継ぎ目 `after_failure_settle`（`post_mix.rs` の `State` に `#[cfg(test)]` で足す。`post_mix.rs:1155` の `state.settle()` と `:1156` の `detached` の比較の間で呼ぶ。`after_exec_check`（`post_mix.rs:312,451-454`）と同じ型）。子は台本つきで `LoadPlugin` に `Error` を返す | 公開の操作 `Request::Add` が、切断ではない理由で失敗する。継ぎ目で子の `link.close(Eof)` を挟むと、`enabled == false`・`error` が立つ・`disconnected` が空（切断として数えられない）。競合2 |
| S3 | `s3_today_the_c3_loser_returns_before_the_eof_notices` | `reply_deadline_tests.rs` | `paused_eof_reader`（`reply_deadline_tests.rs:56-69` を窓口の `reader_for` に置き換える）、`await_reply`（`WriteDone` を12秒前にして期限切れを作る。`:161-170` と同じ形） | 負けた `reply_timed_out`（`audio.rs:1155`）は、reader を止めたまま `Engine Crashed/Exited` で戻る。戻った時点で記録された通知に `audio-engine-exited` が無い。解放後に3つの通知が出る。競合3 (a) |
| S4 | `s4_today_a_host_close_drops_the_waiter_before_the_eof_notices` | `link_tests.rs` | `Reader::pause`、`link_seam::begin_request`、`host.drop_connection(Intentional)`（`audio.rs:718`。試験から呼べる）。tick の待ち手を真似て `rx.try_recv()` を使う | reader が CAS に勝って止まっている間に、別の入口が `drop_connection` する。`rx.try_recv()` は `Disconnected`（`Eof` ではない）。このとき通知は未発行。競合3 (b) |
| S5 | `s5_today_cut_off_clears_the_operation_even_when_eof_won` | `link_tests.rs` | `link_seam::register_sent_operation(LoadPlugin)`、`win_eof`（CAS だけ勝つ）、`await_reply` に `broken_pipe()`（`link_tests.rs:55-60`）の `WriteDone`、`link_seam::take_exit` | EOF が先に勝っていても、`cut_off`（`audio.rs:1180-1183`）が `vst_operations.response(Error)` を CAS の前に呼ぶので、続く `take_exit()` の `cause == "unknown"`（本当の VST が消える）。`reply_timed_out` は同じ状況で `vst_operations` に触れない（`reply_deadline_tests.rs:189` の T13 が固定済み）ので、2つの経路の違いを並べて固定する |
| S6 | `s6_today_a_closed_reader_can_still_raise_voice_activity` | `link_tests.rs` | `reader_for`、`reader.handle_event(EngineEvent::VoiceCheckState{…})`（`reader.rs:64`）。`host.link.close(Intentional)`、`host.voice_activity.store(false)`（`kill_primary_engine` の `audio.rs:2819` の真似） | 閉じた接続の reader が、検査を通過していた1行で `voice_activity` を `true` に戻す（`reader.rs:191-199`）。F1b-0b-1 では変えない。期待値を変えるのは F1b-0b-4（7.3） |
| S7 | `s7_start_is_cut_off_at_its_deadline_retired_and_no_stop_is_sent` | `reply_deadline_tests.rs` | `silent_host` と同じ形で `("Start", [WaitGate("never")])`。`set_limits_for_test(None, Some(SHORT))`。`Start` は `frontend_bootstrap.rs:497` の組み立てに倣う | F1b-0a-2 設計 9章の1点目。`Start`（B）で `execute_command` が `REPLY_TIMED_OUT`、`link.cause() == ReplyTimeout`、子が回収される、`Stop` が送られない（`observer.sent()`）、`audio-error` が1回、`confirming_start` が偽、次の `execute_command` で作り直し（`spawn_count == 2`）。`Start` の `device_open` の記録が `timeout()` で残る（`engine_exit.rs:329-342`）ことが、作り直した接続へ持ち越されない（新しい接続の原因が `unknown`）。10秒の互換の試験（`commands/audio/compat_tests.rs:645`）は `SetChannelScan`（A。`:646`）のまま |
| S8 | `s8_t2_c3_keeps_the_saved_post_mix_settings_in_memory_and_on_disk` | `post_mix_life_tests.rs` | `t2_…`（`post_mix_life_tests.rs:717`）と同じ `Rig`。保存した設定は `Request::Save` で作る（`save_request`、`:728`）。`rig.host.post_mix.file_checkpoint()`（`post_mix.rs:424`）と `std::fs::read` | F1b-0a-2 設計 9章の2点目。期限切れの前後で、`state.saved`・`state.raw`・`post-mix.json` の中身が変わらない（`enabled` が残るだけでなく、保存した中身が残る） |
| S9 | 既存の `t12_the_retire_finishes_while_the_reader_is_stuck_in_emit_whether_c3_wins_or_loses`（`reply_deadline_tests.rs:266`）の拡張 | `reply_deadline_tests.rs` | `engine_life::seam::on_stage`（`engine_life.rs:569`）に `Stage::Retired(Role)` を足し、`retire_child`（`engine_life.rs:243-261`）の2つの出口（確認できた `:247-248` と、記録へ移す `:251-260`）の直後に呼ぶ。フックは cutter のスレッドで設定する（`seam` はスレッドごと） | F1b-0a-2 設計 9章の3点目。`f.recorder.release()`（`:312`）の前に、回収の完了の印が立っていること（今は `wait_exit`＝子の終了だけで、回収の完了ではない）。勝ち・負けの両方 |

補足：
- S1・S3・S4 は、reader を止める継ぎ目が `Reader::pause` に限られる（`finish` の直後で止める）。`reader_for` の `Reader` を直接 `finish` させる形で、実プロセスは使わない。
- S2 の継ぎ目 `after_failure_settle` だけが、製品のコードへ足す試験用のコード（`#[cfg(test)]`）。S9 の `Stage::Retired` も同じ。挙動は変えない。
- S5 の「`reply_timed_out` との違い」を同じファイルで並べるのは、F1b-0b-1 で2つの経路が1つの規則（負けたら `vst_operations` に触れない）にそろうことを、差分として見せるため。
- **`Admission`・トレイのミュート・N1 の固定（洗い出し 5.3 の 4〜6）は、この段では足さない。** F1b-0b-2a 以降の対象で、`LinkCell` と無関係だから。

### 8.3 寄せる試験の一覧（期待値は変えない）

対象は、F1b-0b-1 の `LinkCell` で**コンパイルできなくなる**参照と、「reader の勝ちを真似る」組の意味が変わる参照。概算は次のとおり（grep の行数。1つの試験が複数行を持つ）。

| ファイル | 寄せる参照（概算） | 内訳と代表の例 | 寄せ先 |
|---|---|---|---|
| `link_tests.rs` | 約16か所 | `pending_reply_tx.begin()` 10行（`:159,173,188,201,230,245,250,350,360,717`）・`.deliver(…)`（`:160`）・`.close()`（`:203,362`）・`.clone()` で別スレッドへ渡す（`:251`）、`reader_for` の構造体リテラル（`:30-41`）。`link.close(Eof)` と `pending_reply_tx.close()` を続けて reader の勝ちを真似る組（`:202-203`） | `link_seam::begin_request`・`deliver`・`win_eof`・`reader_for`・`cancel`。期待値は変えない |
| `reply_deadline_tests.rs` | 約11か所 | `pending_reply_tx.begin()`（`:160,198,233,243,253`）・`.deliver_at(…)`（`:236,246`）・`vst_operations.begin(&load)`（`:195`。**これは `LinkCell` では「送った」に上げる前の操作になり、原因に載らなくなる**ので、`register_sent_operation` に寄せる）、`paused_eof_reader` の構造体リテラル（`:58-68`） | 同上＋`register_sent_operation` |
| `reply_deadline_tests.rs` の T3（`:155`）・T13（`:189`） | 2本の組み立て直し | 今は `await_reply` を試験のスレッドで呼び、**戻った後に** `pause.release()` する（`:180,208`）。F1b-0b-1 の競合3 (a) で、負けた側は `Eof` を待つので、戻らなくなる（試験が止まる）。**F1b-0b-0 で、`pause.release()` を別スレッド（`await_reply` の開始の少し後）から行う形に直す。** 今の挙動（戻りが先でも、後でも通る）のまま通る。順序そのものは S3 が固定する | 試験の組み立てだけ。期待値は変えない |
| `post_mix_life_tests.rs` | 0か所（コンパイル） | `child.link.close(CloseCause::Eof)` は14か所あるが（`:368,480,517,588,672,867,918,1010,1076,1165,1181,1216,1246,1281`）、すべて待ち手のいない接続を閉じる形（`after_exec_check`・`between_ops` の継ぎ目の中）。`LinkCell::close(cause) -> bool` が同じ名前・戻り値で残るので、そのまま通る。`replace_writer_for_test`（`:675,944`）・`fail_writes_for_test`（`:95,369,673`）・`set_link_for_test`（`:110`）も残る。名前・コメントに残る「`ReplySlot` がまだ開いていても」（`:1154`）は文言だけ直す | 触らない（コメントのみ） |
| `engine_life_tests.rs` | 0か所 | `fail_writes_for_test`（`:324`）だけで、残る。内部の参照44か所（洗い出し 5.1）は `.conditions`・`.retired`・`.child` で、reaper（F1b-0b-3）で壊れる側。`LinkCell` では壊れない | 触らない。reaper の寄せは F1b-0b-3 の前（未決 9.9-U5） |

代表的な書き換え（`link_tests.rs:201-203`）：
```text
今：  let rx = host.pending_reply_tx.begin().unwrap();
      assert!(host.link.close(CloseCause::Eof));
      let sender = host.pending_reply_tx.close().expect("待ち手がいる");
寄せた後：  let rx = link_seam::begin_request(&host, None).unwrap();
            let sender = link_seam::win_eof(&host).expect("待ち手がいる");
```
期待値（`Engine Crashed/Exited`・`audio-error` が出ない・`engine_generation == 0`）は変えない。

**4つのファイルの外にも、同じ型を直接つかむ試験がある**（7.4 の範囲に入っていない。未決 9.9-U1）：

| ファイル | 件数（概算） | 例 |
|---|---|---|
| `audio/mode_vst.rs` の試験部（`:1360-` 以降） | 約50行 | `pending_reply_tx.begin/deliver/close/cancel` 約25行（`:1796,2152,2158,2290,2314,2354,2392,2410,2474,2484,2531,2545,2564,2569,2715,2729,2760,2786`）、`link.close(Eof)` 10行（`:2320,2337,2349,2365,2377,2717,2744,2762,2784,2812`）、`Writer::start(…, host.link.clone())`（`:2375,2413,2444,2557,2742`） |
| `audio/engine_exit.rs` の試験部（`:357-`） | 26行 | `host.vst_operations.begin/response`（`:522-524,734,750-752`）・`Operations` の `.0.lock()`（`:759`）・`exit(&host.vst_operations)`（`:760`） |
| `audio/output_bundle.rs`・`session_rack.rs`・`mixing_bundle_tests.rs` | 5・1・1行 | `host.pending_reply_tx.clone()` で応答の台本を返す（`output_bundle.rs:177,247`、`session_rack.rs:347`） |
| `audio/replies.rs`・`link.rs`・`writer.rs` の単体試験 | 9・5・10行 | 型そのものの試験。型が変わるので、F1b-0b-1 で書き直す（寄せない） |

### 8.4 触らない試験と、その理由

- `config_storage_tests.rs`（36本。内部参照128）：保存ファイル・設定の試験で、`LinkCell` と関係が薄い。`set_link_for_test`（`:105,124,154,573,…`）・`host.link.is_open()`（`:235,459,…`）・`attach_stdin_for_test`（`:151,861,967`）は、9.1 で名前を残すので通る。**ただし、`host.pending_reply_tx.clone()` を取って `deliver` する3か所（`:155`・`:866`・`:976`）は、F1b-0b-1 でコンパイルできなくなる**。7.4 は「触らない」と決めているので、未決 9.9-U2 に挙げる。
- `device_scan_tests.rs`（7本。参照20）：機器のスキャンの試験で、`LinkCell` と関係が薄い。`set_link_for_test`（`:165,199`）・`attach_stdin_for_test`（`:195`）・`fail_writes_for_test`（`:203`）・`host.link.is_open()`（`:205`）は、すべて残る。壊れる参照は無い。
- どちらも、`LinkCell` の型が変わっても、試験の意味が変わらない。寄せると、保存・スキャンの安全網に不要な差分が入るだけ。

## 9. F1b-0b-1（`LinkCell`）の詳細

### 9.1 型の案

今の3つ（`LinkState`・`ReplySlot`・`vst_operations` の終了の原因の部分）と、配信ミックスの切断の判断を、**接続ごとに1つの `Arc<LinkCell>`（`std::sync::Mutex` の下の1つの状態機械）**にまとめる。`AudioHost` の項目は3つ（`link`・`vst_operations`・`pending_reply_tx`、`audio.rs:292,293,298`）が1つの `link: Arc<LinkCell>` になる。接続を作り直すたびに新しい `LinkCell` を作る（今の `reset_engine_reader`、`audio.rs:1058-1064`）。

```text
LinkCell
  inner: Mutex<Inner>           // 状態の正本。すべての遷移はここ
  phase: AtomicU8               // 開閉の鏡。遷移のたびに、ロックの中で書く（読み取り専用）

Inner
  state: Idle | Registered(Sender<ReplyOutcome>) | InFlight(Sender<ReplyOutcome>) | Closed(CloseCause)
  log:   engine_exit::OperationLog      // 今の `Operations` の `State`（in_flight・awaiting・settling・plugins）
                                         // InFlight 項目に `sent: bool` を足す
```

**`Operations` の中身は丸ごと `Inner.log` へ移す**（原因の部分＝`in_flight`・`settling` だけでなく、`awaiting`・`plugins` も）。`begin`・`response`・`timeout`・`exit` が互いに同じ項目を読み書きしており（`engine_exit.rs:53-189`）、分けると新しい競合の窓ができるため。`State` の各メソッドは `&mut self` で、既に1つのロックの下にある（`engine_exit.rs:316-355` の `Operations` は薄い包み）。`State` を `pub(super)` の `OperationLog` にして、包みを外す。

**鏡 `phase`**：`is_open()`・`cause()` は、ロックを取らずに `phase` を読む（`Acquire`）。理由は、`Notifier::chain_if` が通知の列のロック（`order`）を持ったまま `link.is_open()` を呼ぶ（`reader.rs:28`、`emit.rs:110-123`）が、`order` を持つ間はほかのロックを取れない決まり（`emit.rs:61-63`）だから。`Closed` は終端なので、鏡が古いときの誤りは「開いていると見える」側だけ（閉じたと見えることはない）。**判断が要る場面（`begin`・`mark_sent`・`close`・`close_eof`）は鏡を使わず、ロックの下で行う。**

#### 状態（4つ。`Closed` の原因は5種）

| 状態 | 意味 | 今の対応 |
|---|---|---|
| `Idle` | 開いている。待ちの要求なし | `LinkState::Open` ＋ `ReplySlot::Idle` |
| `Registered` | 開いている。要求を登録した。**まだ書き込みを始めていない**（`log.in_flight.sent == false`） | `ReplySlot::Waiting` ＋ `Operations.in_flight`（送信前も区別しない） |
| `InFlight` | 開いている。writer が書き込みを始めた（`sent == true`） | 同上（区別なし） |
| `Closed(cause)` | 閉じた（終端）。原因は `Intentional`・`Eof`・`WriteFailed`・`WriteTimeout`・`ReplyTimeout`。待ち手の送り側は、閉じた者が取り出し済み | `LinkState::Closed(cause)` ＋ `ReplySlot::Closed` |

#### 遷移の表（各行は同じロックの区間）

「しないこと」は共通で、ロックの中では `emit`・I/O・ほかのロックをしない（9.3）。

| # | 遷移 | 呼ぶ者 | 状態の変化 | 同じ区間で行うこと | 戻り値 |
|---|---|---|---|---|---|
| E1 | `begin(Option<&Command>)` | 呼び出し側（`audio.rs:1075-1076`）・tick（`mode_vst.rs:701`） | `Idle → Registered` | 受け側を作る。`Some(cmd)` なら `log.begin(cmd)`（`sent = false`） | `Ok(rx)` |
| E2 | `begin` | 同 | `Registered`/`InFlight`：変えない | — | `Err`（今の「前の音声操作の応答待ちです」） |
| E3 | `begin` | 同 | `Closed`：変えない | — | `Err(CLOSED)`（`replies.rs:9`） |
| E4 | `mark_sent()` | writer（書き込みの直前。`writer.rs:190-199`） | `Registered → InFlight` | `log.in_flight.sent = true` | `true`（書いてよい） |
| E5 | `mark_sent` | 同 | `Idle`/`InFlight`：変えない | — | `true`（登録なしの書き込み・試験の writer は今どおり書く） |
| E6 | `mark_sent` | 同 | `Closed`：変えない | — | `false`（`Aborted`） |
| E7 | `deliver_at(resp, at)` | reader（`reader.rs:45-50`） | `Registered`/`InFlight → Idle` | `log.response(&resp)`、続けて送り側へ `Response{resp, received_at}` を送る（`mpsc` の送信は待たない） | `true` |
| E8 | `deliver_at` | 同 | `Idle`：変えない | `log.response(&resp)` だけ（今の `operations.response` が先に走る挙動を保つ） | `false`（ログ「no one is waiting」） |
| E9 | `deliver_at` | 同 | `Closed`：変えない | 何もしない | `false` |
| E10 | `close_eof()` | reader の終端（`reader.rs:280-306`） | `Idle`/`Registered`/`InFlight → Closed(Eof)` | 送り側を取り出す（`Idle` は無し）。`log.exit(now)` で原因を採る（**`sent == false` の登録は原因にしない**）。`phase` を更新 | `Some(EofWin{waiter, exit})`（勝ち） |
| E11 | `close_eof` | 同 | `Closed`：変えない | 何もしない（送り側は閉じた者が処理済み） | `None`（負け） |
| E12 | `close(cause)` | Host（`close_connection`・`reply_timed_out`・`cut_off`・`fail_mode_deadline`・差し替え。`audio.rs:710,1156,1183`・`mode_vst.rs:693`・`audio.rs:1060`） | `Idle`/`Registered`/`InFlight → Closed(cause)` | 送り側を取り出して**捨てる**（待ち手は `Disconnected`）。原因ごとに記録を片づける：`WriteFailed`・`WriteTimeout` は `log.response(Error(文言))`（今の `cut_off` の `audio.rs:1181-1182`）、`ReplyTimeout` は `log.timeout()`（今の `audio.rs:1157-1159`）、`Intentional` は何もしない | `true`（勝ち） |
| E13 | `close(cause)` | 同 | `Closed`：変えない | **何もしない。送り側にも記録にも触れない**（今の `cut_off` の「CAS の前の `response`」と、`close_connection` の「負けても送り側を取る」を、やめる） | `false`（負け） |
| E14 | `cancel()` | tick（`mode_vst.rs:703,716`） | `Registered`/`InFlight → Idle` | 送り側を捨てる。`log` は変えない（モード VST は操作の記録を持たない） | — |
| E15 | `set_open_for_test(bool)` | 試験 | 直接決める | `Idle` か `Closed(Intentional)` | — |

**状態の数の確認**：状態は `Idle`・`Registered`・`InFlight`・`Closed` の4つ。今は `LinkState`（開閉と原因）×`ReplySlot`（3つ）×`in_flight`（有無）の組から、整合しない組（`Closed` なのに待ちが `Waiting` のまま、など）が出る。`LinkCell` はその組を作れない。

#### 公開の窓口（`AudioHost` の側）

- `is_open()`・`cause()`・`close(cause) -> bool` は、`LinkState` と同じ名前・戻り値で残す。`Writer::start(sink, host.link.clone())`・`rack_pin: Option<Arc<LinkCell>>`（`post_mix.rs:310`）の `Arc::ptr_eq`（`:575`）も、型だけが変わる。
- `close_eof()`・`mark_sent()`・`begin()`・`deliver_at()`・`cancel()` は新設・改名。

### 9.2 7.1 の3つの競合が、どの遷移で閉じるか（窓ごと）

#### 競合1：未送信の VST の操作が終了の原因に載る

| 窓 | 今の順 | 直した後の順 |
|---|---|---|
| 1a. reader の CAS の後に、`begin` が通る | R：`link.close(Eof)`（CAS、`reader.rs:282`）→（止まる）→ H：`is_open()` が真だった後に `pending_reply_tx.begin()`（`audio.rs:1068,1075`）・`vst_operations.begin(&cmd)`（`audio.rs:1076`）→ R：`take_exit()`（`reader.rs:294`）が未送信の `LoadPlugin` を原因にする。writer は `Aborted`（`writer.rs:190-199`） | H の `begin`（E1）と R の `close_eof`（E10）は同じロックの区間で、**どちらかが先**。(i) `begin` が先：`Registered`。`close_eof` が送り側を取り、`log.exit()` は `sent == false` の登録を無視して `unknown`。writer の `mark_sent`（E6）は `false`（`Aborted`）。待ち手は `Eof` で解放（`Engine Crashed/Exited`）。(ii) `close_eof` が先：`begin` は `Err(CLOSED)`（E3）。登録は起きない |
| 1b. `begin` の後、writer が書く前に閉じる | 上と同じ（`Aborted` でも記録が残る） | 1a (i) と同じ |
| 1c. 書き込みを始めた後に閉じる | `vst_operations` に載る（これは正しい） | `mark_sent`（E4）で `InFlight`。`close_eof` が `sent == true` の操作を原因にする（同じ結果） |
| 1d. `cut_off` の順 | H：`vst_operations.response(Error)`（`audio.rs:1181-1182`）→ `link.close(cause)`（`:1183`）。EOF が先に勝っていても、`response` が `in_flight` を先に消す（洗い出し 6.1） | H：`close(cause)`（E12）。勝ったときだけ同じ区間で `log.response(Error)`。負けたとき（E13）は `log` に触れず、reader の `exit()` が本当の原因を採る |

#### 競合2：`settle()` の直後の EOF で `enabled` が落ちる

| 窓 | 今の順 | 直した後の順 |
|---|---|---|
| 2a. 公開の操作の失敗の処理 | `state.settle()`（`post_mix.rs:1155`）が `connection_lost()` を読む（開いている）→（reader が `close(Eof)`）→ `detached == detached_before`（`:1156`）→ `discard_child()`（`:1157`、`enabled = false`、`:797-804`） | 子があれば、`child.link.close(Intentional)`（E12）の戻り値で分ける。**勝った（`true`）：** 閉じたのは自分。`discard_child()`（今と同じ。`enabled = false`・`error` を立てる）。**負けた（`false`）：** すでに EOF・期限切れ・書き込みの失敗で閉じている。`detach_with(None)`（`enabled` を残す）。子が無ければ、今どおり `detached` の数で分ける（`exec_child` が先に外した場合） |
| 2b. 「`settle()` の後に `detached` の数を比べる」2段 | 2段の間に窓 | 1回の `close(Intentional)` の戻り値 1つ。窓は無い |
| 2c. ほかの `settle()`（`exec_child`・`start`・`Enable`。`post_mix.rs:450,845,1018`） | 開いている・閉じているを読み、閉じていれば外す | 変えない。開いていれば何もしないので、読んだ後の EOF は次の呼び出しで外れる（失敗の処理で判断を変える場所は、2a だけ） |

#### 競合3：K13 で、通知の前に `Disconnected` になる

| 窓 | 今の順 | 直した後の順 |
|---|---|---|
| 3a. 期限切れの負け（`reply_timed_out`） | H：`link.close(ReplyTimeout)` に負ける（`audio.rs:1156`）→ `kill_engine` → `drop_connection` → `ReplySlot::close()` が送り側を取って捨てる（`audio.rs:712`）→ `Ok(Error(ENGINE_EXITED))` を返す（`:1167-1169`）。reader の通知3件より前 | `close(ReplyTimeout)` に負ける（E13。送り側には触れない）。子を回収する（I3。通知を待たない）。その後、**`LinkCell` と通知の列のロックを持たずに、`rx` で `Eof` を待つ**（9.5）。`Eof` が来てから（＝reader が3つの通知を出し終えてから）`Ok(Error(ENGINE_EXITED))` を返す |
| 3b. 別の入口の回収が送り側を横取りする（tick が待ち手） | reader が CAS に勝って止まっている間に、別の入口の `kill_engine`／停止が `drop_connection`（`audio.rs:718-725`）→ `close_connection` が `ReplySlot::close()` で送り側を捨てる（`:712`）。tick の `try_recv` は `Disconnected`（`mode_vst.rs:596`）。通知より前に待ち手が解放される | `close(Intentional)` が負ける（E13）ので、送り側は reader の `EofWin` に残る。tick の `try_recv` は `Empty` のまま、reader が通知3件を出し終えて `Eof` を送るまで続く。回収（`writer = None`・`child.take()`・`retire_child`）は無条件に進む。（`close(Intentional)` が**勝った**ときは、EOF は競りに負けるので EOF の通知自体が出ない。K13 の対象外で、今と同じ） |

### 9.3 ロックの規則

**共通：** `LinkCell` のロックは**葉**。持つ間は、メモリの更新と、待たない `mpsc` の `Sender::send`・`drop` だけをする。`emit`・I/O・ホストのロック・`order`（通知の列）・`emitter`・`Store.slots`・`held_notices`・ほかの `LinkCell`・`Conditions` の更新・`kill`・`sleep`・`recv`・`join` をしない。ロックの順は **ホスト → `order` → `LinkCell`（鏡の読み取りだけ）** で、`LinkCell` のロックから外へは出ない。`Mutex` の poison は `into_inner` で進む（`emit.rs:86-107` と同じ。`begin` の「IPC応答の状態を取得できません」の分岐はなくなる）。

| 役者 | 使い方 |
|---|---|
| reader | 行ごとの `is_open()`（`reader.rs:33`）・`chain_if` の確認（`reader.rs:28`）は鏡だけ。応答は `deliver_at`（E7〜E9）。終端は `close_eof()`（E10・E11）を1回呼び、**ロックを放してから**、`conditions.engine_event`・通知の列・`waiter.send(Eof)` を今の順で行う（`reader.rs:293-305` の順を保つ：先に通知、後で解放）。`Reader::pause` は `close_eof()` の戻りの直後（`reader.rs:289-292` の位置）に置く |
| writer | 書き込みの直前に `mark_sent()` を1回（E4〜E6）。書き込み（`write_payload`）はロックの外。`Aborted` は `false` のとき |
| 呼び出し側（ホストのロックを持つ H・tick） | `begin`（E1〜E3）→ 提出 → `await_reply` → 失敗なら `close(cause)`（E12・E13）。`await_reply` の `recv_timeout`・`Eof` の待ちは、`LinkCell` のロックを持たずに行う（9.5）。`is_open()`・`cause()`・`connection_lost()` は鏡 |
| 回収（`drop_connection`・`kill_engine`・`release_engine`・`Drop`） | `close(Intentional)`（E12）を1回。その後に `writer = None`・`child.take()`・`retire_child`（`kill`・確認の最大2秒）を行う。`retire_child` の間は `LinkCell` のロックを持たない（`close` はもう戻っている） |
| 配信ミックスの失敗の処理（`post_mix.rs:1151-1163`） | `child.link.close(Intentional)` を1回呼び、戻り値で `discard_child` か `detach_with` に分ける（9.2 の 2a）。戻った後に子の回収（`kill_engine`・`release_engine`）をする |

### 9.4 writer が書き込みの直前に「送った」に上げる仕組み（競合1）

- `writer::run`（`writer.rs:190-199`）は、今は `link.is_open()` を読んで書くか `Aborted` にする。これを `link.mark_sent()`（E4〜E6）に置き換える。`mark_sent` は同じロックの区間で、「開いているか」と「登録した操作を `sent` に上げる」を行う。**書く判断と記録の更新が1つの区間**なので、「`Aborted` の操作が原因に載る」ことも「`sent` なのに書かなかった」ことも起きない。
- `Writer::start`・`start_with` の引数は `Arc<LinkState>` から `Arc<LinkCell>` に変わる（`writer.rs:133,145`）。`Job` には操作の識別を持たせない（接続は直列で、登録は同時に1つ。E2）。
- 書き込みの失敗（`Err`）・5秒の期限切れの後は、`sent == true` の操作が `InFlight` に残る。`cut_off` の `close(WriteFailed/WriteTimeout)` が勝てば `log.response(Error)` で片づく（E12）。EOF に負ければ、`close_eof` が `sent == true` の操作を原因にする。
- モード VST の tick は操作の記録を持たない（`begin(None)`）。`mark_sent` は `Registered → InFlight` の遷移だけを行い、`log` は変えない。
- 試験の継ぎ目：`mark_sent` の直前で止める `before_mark_sent`（`#[cfg(test)]`、`writer.rs`）。T3 で使う。

### 9.5 7.1 の競合3 (a)：負けたら、ロックを持たずに `Eof` を待つ

- `await_reply` は、期限切れ（`Timeout`、または `received_at` が期限の後の応答）のとき、`rx` を渡して `reply_timed_out(rx)` を呼ぶ（`audio.rs:1141-1143`）。
- `reply_timed_out` の順：`close(ReplyTimeout)` → 子の回収（`kill_engine`／`kill_primary_engine`。今のまま）→ **負けたとき（`won == false`）だけ**、`rx.recv_timeout(EOF_WAIT)` を行う。この待ちは、`LinkCell` のロックを持たず、`order` も持たない。ホストのロックだけは、今の待ちと同じく持つ。
- 結果は3通り：`Eof`（reader が通知を出し終えた）／`Disconnected`（送り側が捨てられた。たとえば、勝った者が reader ではなく試験のヘルパー、または `Response` を受け取り済みで送り側が残っていない）／`Timeout`。**どれも `Ok(Error(ENGINE_EXITED))` を返す**（結果の文言は変えない。違うのは順序の保証だけ）。
- **上限 `EOF_WAIT`（案：2秒。`CONFIRM`＝2秒、`engine_life.rs:30` と同じ）。** reader が `emit` の途中で止まっていると、`Eof` は来ない。`Timeout` になったら、通知の前に `ENGINE_EXITED` を返す（今と同じ結果。ログに `warn` を残す）。ホストのロックを持つ最長の延びは `EOF_WAIT`。通常は、通知3件の発行だけ（ミリ秒）。値は未決（9.9-U3）。
- I3（回収は通知を待たない）は保つ：待ちは回収の**後**。回収の中の `hold_notices` が `order` を待つ既知の範囲（F1b-0a-1 設計 3.3）は変わらない。
- 経路 (b)（tick）は待たない：tick の `try_recv`（`mode_vst.rs:569-609`）が `Empty` のあいだ次の tick へ戻る（今の構造のまま）。

### 9.6 変える箇所の一覧（`ファイル:関数`）

製品のコード：

| ファイル:行 | 関数・項目 | 変えること |
|---|---|---|
| `audio/link.rs:45-84` | `LinkState` | `LinkCell` に置き換える（9.1 の E1〜E15）。`CloseCause`（`:6-18`）は残す。単体試験（`:86-`）を書き直す |
| `audio/replies.rs:28-109` | `ReplySlot` | 削除。`CLOSED`（`:9`）・`ReplyOutcome`（`:12-20`）は `link.rs`（または残す）。単体試験（`:111-`）は `LinkCell` の遷移の試験へ移す |
| `audio/engine_exit.rs:36-190,316-355` | `State`・`Operations` | `State` を `pub(super) OperationLog` にし、`InFlight` に `sent` を足す。`exit()`（`:169-189`）は `sent == false` の `in_flight` を原因にしない。`Operations` の包み（`:316-355`）を削除 |
| `audio.rs:292,293,298` | `AudioHost` の項目 | 3つ（`link`・`vst_operations`・`pending_reply_tx`）を `link: Arc<LinkCell>` の1つに |
| `audio.rs:567-571` | `AudioHost::with_retired` 相当の初期化 | `LinkCell::closed()` |
| `audio.rs:610-619` | `attach_stdin_for_test`・`set_link_for_test` | `LinkCell` の型へ。`reopen_for_test` の呼び出しをなくす |
| `audio.rs:709-715` | `close_connection` | `close(cause)`（E12）1回。`pending_reply_tx.close()` の呼び出しを削除 |
| `audio.rs:893` | `ensure_engine_running` の C5 の確認 | 鏡の `cause()`。変わらない |
| `audio.rs:932-945` | `ensure_engine_running` の writer・reader の組み立て | `Writer::start(stdin, self.link.clone())`・`Reader { link, … }`（`operations`・`replies` を除く） |
| `audio.rs:1058-1064` | `reset_engine_reader` | 新しい `LinkCell::open()` 1つ |
| `audio.rs:1066-1080` | `execute_running_command_inner` | `ensure!(is_open)`（`:1068`）と、`begin`・`vst_operations.begin`（`:1075-1076`）を `self.link.begin(Some(&cmd))` 1つに。`before_begin_hook::run()`（`:1070-1071`）は `begin` の直前のまま |
| `audio.rs:1097-1149` | `await_reply` | `reply_timed_out(rx)` に `rx` を渡す。期限切れ・遅い応答の2つの分岐（`:1141-1143`） |
| `audio.rs:1155-1177` | `reply_timed_out` | `close(ReplyTimeout)` の中で `log.timeout()` を行う（`:1157-1159` を削除）。負けたときの `Eof` の待ち（9.5）を足す |
| `audio.rs:1180-1201` | `cut_off` | `vst_operations.response(Error)`（`:1181-1182`）を削除（`close` の勝ちの側へ移る） |
| `audio/reader.rs:8-19` | `Reader` | `operations`・`replies` を除く |
| `audio/reader.rs:43-50` | `run`（応答の行） | `operations.response`＋`replies.deliver_at` を `link.deliver_at` 1つに |
| `audio/reader.rs:280-306` | `finish` | `close_eof()` 1回。負け（`None`）は何もせず戻る（`:282-286` の `replies.close()` を削除）。勝ちは `waiter`・`exit` を取り、通知の後に `Eof` を送る |
| `audio/writer.rs:133-199` | `Writer::start`・`start_with`・`run` | `Arc<LinkCell>`。`run` は `mark_sent()` |
| `audio/mode_vst.rs:693,698,701-716` | `fail_mode_deadline`・`connection_lost`・`send_mode_command` | `close(ReplyTimeout)`・鏡の `is_open()`・`begin(None)`・`cancel()`。tick の判定の順（`:537-615`）は変えない |
| `audio/post_mix.rs:310,551-575` | `rack_pin`・ラックの読み取り | 型を `Arc<LinkCell>` に |
| `audio/post_mix.rs:1151-1163` | `post_mix` の公開の操作の失敗の処理 | `settle()`＋`detached` の比較を、`close(Intentional)` の戻り値による分岐に（9.2 の 2a） |
| `audio/engine_life.rs:243-261` | `retire_child` | `Stage::Retired`（S9。`#[cfg(test)]`）。挙動は変えない |

試験のコード：
- `audio/tests/link_seam.rs`：窓口の中身（9.7 の最初の行）。
- 期待値を変える試験は 9.8。
- `mode_vst.rs`・`engine_exit.rs`・`output_bundle.rs`・`session_rack.rs`・`replies.rs`・`link.rs`・`writer.rs` の試験部：型の変更に合わせて書き換える（8.3 の最後の表。範囲は未決 9.9-U1）。
- `config_storage_tests.rs:155,866,976`：未決 9.9-U2。

### 9.7 合格の条件と試験の形

ID（`T1`〜）は 9章の中だけで使う。

| # | 確かめること | 形 |
|---|---|---|
| T1 | `LinkCell` の遷移の表（E1〜E15）。各行の「状態の変化・同じ区間で行うこと・戻り値」。`Closed` からは戻らない。`close` の負けは何もしない（E13）。`close_eof` の勝ちが送り側と原因を1度だけ渡す（E10・E11）。poison でも panic しない | 単体（`link.rs`） |
| T2 | 競合1（1a・1b）：`begin` と `close_eof` を、両方の順で衝突させる。(i) `begin` が先：`mark_sent` は `false`、`audio-engine-exited` の `cause == "unknown"`、待ち手は `Eof`。(ii) `close_eof` が先：`begin` は `CLOSED`。多数回の競り（`link.rs` の `exactly_one_of_many_racing_closers_wins` に倣う）で、未送信の操作が原因に載ることが一度もない | 単体＋継ぎ目（`Reader::pause`、`begin` の直前の `before_begin_hook`） |
| T3 | 競合1（1c）：`mark_sent` の直前で止める（`before_mark_sent`）。止めたまま `close_eof` を通すと原因に載らない。`mark_sent` を通した後に `close_eof` を通すと、その操作が載る | 継ぎ目（`writer.rs` の新設） |
| T4 | 競合1（1d）：EOF が先に勝っていても、`cut_off` は `log` に触れず、reader の `exit()` が本当の VST を採る。`cut_off` が勝つときは `log.response(Error)` が効く | 継ぎ目 |
| T5 | 競合2：継ぎ目 `after_failure_settle`（失敗の処理の決定の直前）で子の `link.close(Eof)` を挟む。`enabled` が残る・`disconnected` が立つ・`error` が立たない。挟まない通常の失敗は、今どおり `enabled == false`・`error` が立つ（`discard_child`） | 継ぎ目（配信ミックス） |
| T6 | 競合3 (a)：reader を `close_eof` の直後で止める。`reply_timed_out` は子を回収した後に `Eof` を待ち、止めている間は戻らない。別スレッドで解放すると、通知3件が出てから `Ok(Error(ENGINE_EXITED))` が返る（順は `[CC, "audio-engine-exited", "audio-error"]` の後で解放）。待っている間、別のスレッドが `link.is_open()`・`link.begin()`・`Notifier::emit` を呼んで、ブロックしない（`LinkCell` と `order` を持っていない）。上限：reader を解放しないと、`EOF_WAIT` の後に `ENGINE_EXITED` で戻る（`set_limits_for_test` に足す継ぎ目で短くする）。回収は待ちの前に終わっている（S9 の `Stage::Retired`） | 継ぎ目（`Reader::pause`） |
| T7 | 競合3 (b)：reader を `close_eof` の直後で止め、別の入口が `drop_connection(Intentional)` する。tick 役の `rx.try_recv()` は `Empty`。解放後に `Eof`。回収は進む（`child` が外れ、`writer` が `None`）。`close(Intentional)` が勝つ側（reader より先）では、通知は出ず `Disconnected`（今と同じ） | 継ぎ目 |
| T8 | ロックの規則：reader を `emit` の途中で止める（`Recorder::block_after`）。その間に、別のスレッドの `begin`・`close(Intentional)`・`cancel`・`mark_sent` が返る（`LinkCell` のロックを `emit` をまたいで持っていない）。`close_eof` の戻りの後は `LinkCell` を持たずに通知を出す | 継ぎ目（`Recorder`） |
| T9 | 鏡：試験専用のヘルパーで `LinkCell` のロックを持ったまま、別のスレッドの `is_open()`・`cause()` と `Notifier::chain_if` が返る（`order` を持つ間に `LinkCell` のロックを取らない）。遷移の直後の鏡が `Closed` を示す | 継ぎ目 |
| T10 | 互換：K 群（`compat_tests`・`commands/audio/compat_tests.rs`）・`control_tests`・`engine_life_tests`・`post_mix_life_tests`・`link_tests`・`reply_deadline_tests`・モード VST の試験が通る。**期待値を変えるのは 9.8 の表だけ** | 既存 |
| T11 | 壊して確かめる（一時的な改変）：(a) `begin` と `close_eof` を別のロックに戻す → T2 が失敗。(b) `mark_sent` を `is_open()` に戻す → T3。(c) `close` の勝ち側の記録の片づけを CAS の前に戻す → T4。(d) 失敗の処理を `settle()`＋`detached` の比較に戻す → T5。(e) 負けの側の `Eof` の待ちを外す → T6。(f) `close` が負けても送り側を取る → T7。(g) `LinkCell` のロックを持ったまま `send` 以外（通知）を呼ぶ → T8 | 一時的な改変 |
| T12 | `voice_activity`（S6）と `engine_event` の epoch の窓は、**この段では変えない**（F1b-0b-4）。S6 が今の挙動のまま通る | 既存（S6） |
| T13 | W5：旧の通知とコマンドの応答の到着順を、対応する release の子で測り直す（`docs/TESTING.md:42-110`。reader の通知の順を変えていないことの確認。手動） | 手動 |

### 9.8 8章で足した試験の期待値を「直った」に変える一覧

| ID | 試験 | 今の期待値 | F1b-0b-1 の期待値（直った） |
|---|---|---|---|
| S1 | `s1_today_an_unsent_vst_operation_is_named_as_the_exit_cause` → `an_unsent_vst_operation_is_not_named_as_the_exit_cause` | `begin_request` が通り、`cause == "vst_operation"`・`op == "load"` | `begin_request` が `CLOSED`（reader が先のとき）。`begin` が先のときは `cause == "unknown"`（T2 の (i)・(ii) の両方） |
| S2 | `s2_today_an_eof_right_after_settle_drops_enabled` → `an_eof_right_after_settle_keeps_enabled` | `enabled == false`・`error` が立つ・`disconnected` が空 | `enabled == true`・`disconnected` が立つ・`error` が空・子は外れて回収済み |
| S3 | `s3_today_the_c3_loser_returns_before_the_eof_notices` → `the_c3_loser_waits_for_the_eof_notices` | reader を止めたまま `await_reply` が戻る。戻った時点で `audio-engine-exited` が無い | reader を止めている間は戻らない。解放後、通知3件が出てから戻る。上限で戻る場合も `ENGINE_EXITED`（T6） |
| S4 | `s4_today_a_host_close_drops_the_waiter_before_the_eof_notices` → `a_host_close_before_the_eof_race_still_reports_the_exit_to_the_waiter` | `rx.try_recv()` が `Disconnected`・通知は未発行 | `Empty`。解放後、通知3件の後に `Eof` |
| S5 | `s5_today_cut_off_clears_the_operation_even_when_eof_won` → `cut_off_leaves_the_operation_as_the_exit_cause_when_eof_won` | `take_exit` の `cause == "unknown"` | `cause == "vst_operation"`・`op == "load"` |
| S6 | `s6_today_a_closed_reader_can_still_raise_voice_activity` | `voice_activity == true` | **変えない**（F1b-0b-4 で `false` に） |
| S7 | `s7_start_is_cut_off_…` | — | 変えない |
| S8 | `s8_t2_c3_keeps_…` | — | 変えない |
| S9 | T12 の拡張 | — | 変えない（`Stage::Retired` の呼ぶ位置は変わらない） |
| （既存）T3・T13 の組み立て直し（8.3） | 別スレッドから解放 | 同じ（F1b-0b-0 で済んでいる） |

### 9.9 未決（決め切れない点。統括の判断を待つ）

- **U1：7.4 の4ファイルの外の試験。** `audio/mode_vst.rs` の試験部（約50行。`pending_reply_tx`・`link.close(Eof)`・`Writer::start(…link.clone())`）、`engine_exit.rs` の試験部（26行）、`output_bundle.rs`（`:177,247`）・`session_rack.rs`（`:347`）は、F1b-0b-1 でコンパイルできなくなる。F1b-0b-0 の継ぎ目（`link_seam.rs`）に寄せる範囲へ入れるか、F1b-0b-1 で型と一緒に直すか。推奨は、`mode_vst.rs`・`output_bundle.rs`・`session_rack.rs` の `pending_reply_tx` の呼び出しだけを `link_seam` 経由にする（約30行。期待値は変えない）。`engine_exit.rs`・`replies.rs`・`link.rs`・`writer.rs` の単体は、型そのものの試験なので F1b-0b-1 で直す。
- **U2：`config_storage_tests.rs:155,866,976`。** 3か所が `host.pending_reply_tx.clone()` を取って `deliver` する。7.4 の「触らない」を守ると、F1b-0b-1 でコンパイルできない。(a) `AudioHost` に試験専用の `reply_slot_for_test()`（戻り値は `Arc<LinkCell>`、`deliver` を残す）を足し、この3行だけを F1b-0b-0 で書き換える。(b) 項目名 `pending_reply_tx` を残す（`Arc<LinkCell>` の別名の項目）。(a) を推奨するが、7.4 を変える。
- **U3：`EOF_WAIT` の値と上限後の振る舞い。** 案は2秒・上限後は `ENGINE_EXITED` を返す（順序の保証を諦める）。ホストのロックを持つ最長の延びになる。値の根拠は測っていない。
- **U4：負けた側が待つ手段。** 7.1 は「reader が通知の後に送る `Eof` を待つ」。案は `rx`（9.5）。ただし、遅い応答を受け取り済みの待ち手は、送り側が残っておらず `Disconnected` で即座に戻る（9.10 の (b)）。`LinkCell` に条件変数を持たせて「通知の終了」を待つ形なら、この残りは消えるが、`LinkCell` のロックを待ちの間に放す設計（`Condvar::wait`）が要り、9.3 の「葉」の規則に例外ができる。どちらにするか。
- **U5：reaper で壊れる試験の寄せ。** 7.4 は、`LinkCell` と reaper の両方で壊れる試験を F1b-0b-0 で寄せるとした。`engine_life_tests`（内部参照44。`.retired`・`.child`・`engine_life::seam`）と `post_mix_life_tests` の `retired` まわりは、`LinkCell` では壊れない（8.3）。reaper（F1b-0b-3）の寄せを、F1b-0b-0 に含めるか、F1b-0b-3 の前の段にするか。この文書は前者を含めていない。
- **U6：鏡（`phase: AtomicU8`）。** 7.1 は「1つの `Mutex`」だが、`chain_if` が `order` を持って `is_open()` を呼ぶ（`emit.rs:61-63` の規則）ので、ロックを取らない読み取りが要る。鏡を足す案にした。許してよいか。許さない場合は、`chain_if` の確認を `order` の外へ出す必要があり、N2 の窓が広がる。
- **U7：`Operations` の全体を `LinkCell` へ入れる範囲。** 依頼は「`vst_operations` の終了の原因の部分」。`awaiting`・`plugins`（読み込んだ VST の一覧。`engine_exit.rs:42-47`）も、`begin`・`response` が同じ項目を触るので一緒に移した（9.1）。`plugins` を別のロックに残す案は、`response` の中で2つのロックを取ることになり、規則（9.3）に反する。
- **U8：`voice_activity` と epoch の窓の時期。** 7.3 は「`LinkCell` の閉鎖と `retire_engine` にそろえて閉じる」とだけ書き、段は F1b-0b-4 とある。この文書は F1b-0b-1 では変えないとした（T12・S6）。確認したい。
- **U9：書き込みの失敗の通知の規則（E12）。** `close` が負けたときに、`log` にも送り側にも触れない（E13）ことで、今の `close_connection` の「負けても送り側を取って捨てる」（`audio.rs:712`）が変わる。reader が先に EOF に勝つ場合、送り側は reader が持つので問題ないが、**試験専用の `link.close(Eof)`（reader なしで CAS だけ勝つ）は、送り側を捨てるだけになる**（E12 の勝ち）。そのため、reader の勝ちを真似る試験は `win_eof`（8.1）へ寄せる必要がある（寄せた）。製品のコードに影響はない。

### 9.10 既知の狭い競合として残るもの

- **(a) 「送った」の後の閉鎖。** `mark_sent` で `sent` を立てた後、`write` が子に読まれる前に子が終わると、読まれていない操作が原因に載る。パイプの書き込みの成功は、子の受け取りを意味しない（今も同じ。区別できない）。
- **(b) 受け取り済みの待ち手が負けたとき。** 遅い応答（`received_at` が期限の後）を受け取った後に `reply_timed_out` が負ける場合、送り側は応答を送った時点で使い終わっており、`Eof` は来ない（`Disconnected` で即座に戻る）。通知の前に `ENGINE_EXITED` を返しうる。未決 U4 で条件変数にすれば消える。
- **(c) `EOF_WAIT` の上限後。** reader が `emit` で止まっているとき、通知の前に戻る（9.5）。
- **(d) 鏡の読み取り。** reader が行の先頭で `is_open()` を読んだ後に閉じると、1つの列が出うる（通知の列の直前の確認の後に閉じる窓。F1b-0a-1 設計 3.4 と同じ）。完全な形は F1b-0b-4（7.3）。
- **(e) `voice_activity.store(true)`・epoch の古い `engine_event`。** 変えない（F1b-0b-4）。S6 が固定する。
- **(f) 配信ミックスの `settle_with`（`post_mix.rs:450,845,1018`）の読み取り。** 開いていると読んだ後の EOF は、その操作の中では何も外さず、次の呼び出しで外れる。結果は切断として失敗するだけで、`enabled` は落ちない（`discard_child` を呼ぶ判断は 2a だけ）。

## 10. 未決 U1〜U9 の決定（統括、2026-11-23）

| # | 決定 |
|---|---|
| U1 | `LinkCell` で壊れる試験は、7.4 の4ファイルの外（`mode_vst.rs`・`engine_exit.rs`・`output_bundle.rs`・`session_rack.rs` の試験部）も含めて、F1b-0b-0 で `audio/tests/link_seam.rs` の窓口へ寄せる。範囲は「`LinkCell` で壊れる参照のすべて」とし、7.4 の表の F1b-0b-0 の行をこの意味に読み替える。期待値は変えない |
| U2 | `config_storage_tests` は、壊れる3か所（`:155`・`:866`・`:976`）だけを窓口へ寄せる。それ以外は触らない |
| U3 | `EOF_WAIT` は2秒の案で始め、実装の試験で見直す。上限を過ぎたら、待たずに `Engine Crashed/Exited` を返し、ログに1回残す（結果は同じで、通知との順だけが崩れる。9.10 の既知の狭い競合に入れる） |
| U4 | 負けた側の待ちは、`rx` ではなく `LinkCell` の条件変数にする。reader が EOF の通知の列を出し終えたら「通知済み」を立てて知らせる。遅い応答を受け取り済みの待ち手も、同じ条件変数で待てる |
| U5 | reaper で壊れる試験の寄せは、F1b-0b-3 の段に含める（F1b-0b-0 には入れない） |
| U6 | 鏡（`AtomicU8`）を許す。正本は `LinkCell` で、鏡は `LinkCell` のロックの中でだけ書き、通知の列のロックの中の読み取りにだけ使う |
| U7 | `Operations` の全体（`awaiting`・`plugins` を含む）を `LinkCell` に移す。`LinkCell` のロックの区間では I/O と `emit` をしない規則を守る |
| U8 | `voice_activity` と epoch の窓は F1b-0b-4 で直す |
| U9 | 試験専用の `link.close(Eof)` は `win_eof` に寄せる（9章のとおり） |
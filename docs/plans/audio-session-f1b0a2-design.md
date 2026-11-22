# F1b-0a-2 応答の期限での切り離し（C3）と命令ごとの期限の設計

状態：設計（第2版）。Gemini 4 Neon のレビュー（条件つきで進めてよい）の条件を 8章のとおり反映した。

前提の文書：
- 今の事実：`audio-session-f1b0a2-inventory.md`（以下「洗い出し」。2add03ed で照合済み）と、判断の要る3点の確認（Sol、2026-11-22）。
- 土台：`audio-session-f1b0a-design.md`（F1b-0a-1。2章の3つの責務、2.4 の EOF の順、10章、11章の既知の狭い競合）。
- 決定：J-17（C3）、J-18、J-23（命令の種類での期限）、J-25（試聴の破棄の前処理がある命令は B）。

## 1. 範囲と、変わる挙動

| # | 場面 | 今（洗い出し 3章） | F1b-0a-2 |
|---|---|---|---|
| C3 | 応答が期限までに来ない | 呼び出しは失敗するが、`ReplySlot` は `Waiting` のまま残り、`LinkState` は開いたまま、子も残る。次の命令（停止を含む）は「前の音声操作の応答待ちです」で書き込みの前に断られ続ける（遅い応答が来るか EOF まで） | 接続を切り離して子を回収する（C2 と同じ後始末）。次の命令は待ちに妨げられない。次に子を起動しうる操作で作り直す |
| J-23・J-25 | 応答の期限 | すべての命令で10秒 | 命令の種類で A 10秒・B 30秒・C（`ProbeLoopback`）録音の時間＋10秒（2章） |
| C 上限 | `ProbeLoopback` の録音の時間 | 上限がない | 最大10秒（2.3） |
| モード VST | 遷移の1段の期限 | 送ってから10秒（tick） | 送ってから、その命令の種類の期限（2章）。遷移の全体の120秒は保つ |

変えないもの：
- 書き込みの期限（5秒、C2）。
- 起動の確認（J-24）の期限（`StartIdentityCapability` は A。10秒）。
- 旧の通知の名前・中身・順（C3 の通知は C2 と同じ `audio-error` を使い、新しい通知は足さない）。
- ホストのロックの持ち方。K2・K10・K11。

## 2. 命令の種類と期限（J-23・J-25）

### 2.1 基準

命令の処理の中で、応答を返す前に、次のどれかを同期に行いうるものは **B**、どれも行わないものは **A**。

- VST の呼び出し
- 音声機器のストリームの作成・破棄（**試聴のストリームの破棄の前処理を含む。J-25**）
- Windows の共有メモリの作成・解放
- ファイルの I/O
- 待ち（`sleep`、`join`、フェードの確認など）

### 2.2 分類の決め方

- 親の側に `fn reply_deadline(cmd: &IpcCommand) -> Duration` を作り、`IpcCommand` の全バリアントを **`_` を使わない `match`** で分類する。命令を足したときに、分類の漏れがコンパイルで分かる。
- 1つの命令の中で要求の種類が分かれるもの（`Mixing`、`LiveOutput`、`NoiseMeasurement`、`BuiltinEffects`、`PeakProtection`、`BroadcastTruePeak`、`ModeSilence` など）は、要求の中身まで `match` する。`Snapshot` など読み取りだけの要求は A、それ以外は B（洗い出しと Sol の確認による）。
- 要求の中身の列挙型も `_` を使わずに `match` する（新しい要求の漏れも防ぐ）。例：`LiveMode` は `SingingOn`・`TalkOn` が B、それ以外は洗い出し 1.3 に従う。`ModeSilence` の分類は、洗い出し 1.3 と Sol の確認（`Begin` は出力のフェードの確認を最大100ms待つので B、`Snapshot`・`Finish` は A）を実装で照らして決め、根拠を残す。
- 分類の表は、実装の PR で `docs/plans/audio-session-f1b0a2-design.md` の付録として、`ファイル:行` の根拠つきで残す。

### 2.3 C：`ProbeLoopback`

- 期限は「録音の時間＋10秒」。
- 録音の時間の上限は10秒。親の側で、送る前に確かめる。実装の最初に、画面とコマンドから渡される録音の時間の範囲を確かめ、10秒を超える値が渡されないなら「超えたら断る」、渡されうるなら「10秒に丸める」にする（どちらにしたかを報告する）。

## 3. C3 の手順（役者×状態×順序）

### 3.1 役者

| 役者 | ロック | 触る状態 |
|---|---|---|
| 応答を待つ呼び出し側（同期の命令。配信ミックスの子への命令を含む） | ホストのロックを持つ | `ReplySlot` の受け側、`LinkState`、`vst_operations`、子（回収） |
| reader | 持たない | `LinkState`（EOF の CAS）、`ReplySlot`（送り側の取り出し）、`vst_operations`（原因の採取）、通知の列 |
| writer | 持たない | 書き込みだけ（閉じた接続では始めない） |
| モード VST の tick | ホストのロックを持つ | 自分の遷移の受け側、`LinkState`、子（回収） |
| 通知（`emit_order`） | `emitter` だけ | 通知の列 |

### 3.2 C3 の順（同期の命令）

呼び出し側は、`WriteDone(Ok)` の `flushed_at` から、その命令の期限（2章）まで応答を待つ。期限までに応答が来なければ：

1. `LinkState::close(ReplyTimeout)` を**最初に**試す（`vst_operations` を書き換える前に）。
2. **勝った場合**：F1b-0a-1 の 2.3 の回収をそのまま行う（`ReplySlot::close()` → writer の送り側を捨てる → 子の回収。主は `kill_engine`、配信ミックスの子は `exec_child` の切断の後処理で `enabled` を残す）。回収の後に、主なら `audio-error` を出す。子の終了を確かめられたら「音声エンジンが応答しないため、終了しました。もう一度お試しください」、確かめられなければ `engine_unconfirmed`（J-13）を返す。
3. **負けた場合**（reader が EOF の CAS に勝っていた）：`vst_operations` を書き換えない（reader の `take_exit()` に本当の原因の VST を残す）。EOF として扱う。結果は今の EOF と同じ `Engine Crashed/Exited`。通知は reader が出す（呼び出し側は `audio-error` を出さない）。子の回収は、F1b-0a-1 の 2.3 のとおり無条件に行う。

**例外（起動の確認、J-24）：** `confirming_start` の間の C3 は、F1b-0a-1 の 2.3 と同じく `kill_primary_engine`（主の子だけ）で回収し、配信ミックスの子・`enabled`・オケの入力の選択（`mixing.selected`）を残し、`audio-error` を出さない。結果は起動の失敗（確かめられなければ `engine_unconfirmed`）。`ensure_engine_running` の側と `kill_primary_engine` を二重に呼ばない。

**主の C3 と配信ミックス：** 主の C3 で `kill_engine` が配信ミックスの子も回収するのは、C2 と同じ今の挙動（洗い出し 6.6）。I5 は「配信ミックスの子の期限切れ」に限る。

**保証の範囲：** reader が `emit` の途中で止まっていても子の回収は止まらない（I3）。回収の後に保持した通知を出すときに `emit_order` を待ちうるのは、F1b-0a-1 の 3.3 と同じ既知の範囲。

### 3.3 期限の後に届いた応答

- `ReplyOutcome::Response` に `received_at` を足す（reader が打つ）。
- 呼び出し側は、受け取った応答の `received_at` が期限より後なら、期限切れとして 3.2 を行う（受け側の取り出しが遅れても、期限を延ばさない）。
- 今の時刻が期限を過ぎていても、受け側を必ず1回読む（`try_recv`）。到着済みで `received_at` が期限以前の応答は、成功として採る（先に期限切れへ落とさない）。
- モード VST の tick の `try_recv` でも、同じく `received_at` で判定する（tick の遅れで、期限を過ぎた応答を受け入れたり、期限内の応答を捨てたりしない）。
- 3.2 で `ReplySlot` を閉じるので、そのあと届いた応答は reader が捨てる（今と同じくログだけ）。

### 3.4 モード VST

- tick の判定の順（F1b-0a-1 の 3.2）は変えない。期限の値だけを、10秒からその命令の種類の期限に変える（起点は今と同じく送った時点）。
- 期限切れの後始末も今のまま（結果が分からない扱いで遷移を中止し、子を回収する。理由は `ReplyTimeout` にそろえる）。通知はモード VST の今の通知のまま（`audio-error` は足さない）。

### 3.5 守ること（不変条件）

- I1：1つの要求の結果は1回だけ決まる（応答・EOF・期限切れのどれか）。
- I2：期限切れで接続を閉じたら、その接続へ新しい書き込みを始めない（writer は閉じた接続で始めない）。
- I3：子の回収は、`LinkState` の勝ち負けに関係なく行う。回収が終わるまで、通知の待ちに依存しない。
- I4：期限切れの後に、同じ役割の子を作り直すのは、F1a-1 の規則（終了を確かめた後、10秒の期限、`engine_unconfirmed`）に従う。
- I5：配信ミックスの子の期限切れでは、主の子を回収しない。`enabled` と保存した設定を残す。

## 4. 意図して変える互換

- 応答の期限切れの後に待ちが残り、次の命令が「応答待ち」で断られ続けること → 接続を切り離す（C3）。試験 `commands/audio/compat_tests.rs` の `timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request` と、`link_tests.rs` の T3（`Waiting` に固有の文言を見ている場合）を、新しい契約（子を回収する・次の命令が断られない・停止を送らない）に書き換える。
- `replies.rs` の単体の試験のうち、「期限の後に遅い応答を消費して同じスロットを使い直す」もの → 期限切れで閉じるので、新しい契約に書き換える。
- B の命令の応答の期限が30秒になる（固まった子を切り離すまでの時間が延びる）。
- `ProbeLoopback` の録音の時間に上限が付く。
- 互換の契約（`audio-session-compat-contract.md`）の、タイムアウトの後の拒否の記述と D-10 を、この段の PR で直す。

## 5. 合格の条件と試験の形

| # | 確かめること | 形 |
|---|---|---|
| T1 | C3（主）：応答が来ない → 期限で失敗、`LinkState` が `ReplyTimeout`、子が回収される、`audio-error`、次の命令（停止を含む）が「応答待ち」で断られない、次の起動で作り直す | scripted child（応答しない段）、継ぎ目で期限を短く |
| T2 | C3（配信ミックスの子）：**公開の配信ミックスの操作**（共通のエラー処理の境界）から起こし、主の子が残る、`enabled` と保存した設定が残る、主の `audio-error` が出ない、子が回収される、続く `snapshot` に切断が表示される | scripted child |
| T3 | 3.2 の負け：期限の直前に EOF が CAS に勝つ → `Engine Crashed/Exited`、`audio-error` を出さない、子は回収される | 継ぎ目（`Reader::pause`） |
| T4 | 3.3：期限の前に届いた応答を期限の後に受け取っても成功。`received_at` が期限の後なら期限切れで、`LinkState` が `ReplyTimeout`・`ReplySlot` が閉じる・子が回収される、まで進む | 継ぎ目 |
| T5 | 期限の値：A・B・C の代表の命令で、期限が10秒・30秒・録音の時間＋10秒になる。分類の `match` が全バリアントを覆う（コンパイル）。B の要求の中身での分かれ（`Snapshot` は A） | 単体 |
| T6 | `ProbeLoopback` の上限 | 単体 |
| T7 | モード VST：B の命令（`RestorePlugin`・`GetPluginState`）で、10秒を超え30秒未満の応答を受け入れる。30秒で中止して子を回収する（`LinkState` が `ReplyTimeout`、巻き戻しなし、`audio-error` なし）。A の命令は10秒のまま。`received_at` の判定 | 継ぎ目（tick の時計） |
| T8 | 起動の確認（J-24）の期限は10秒のまま。`confirming_start` の間の C3 で、配信ミックスの子・`enabled`・`mixing.selected` が残り、`audio-error` が出ず、起動の失敗か `engine_unconfirmed` になる | 既存＋scripted child |
| T12 | I3：reader を `emit` の途中で止めたまま、C3 の CAS の勝ち・負けの両方で `retire_child` が完了する | 継ぎ目（`Reader::pause`・`emit` を止める） |
| T13 | 3.2 の負け：`vst_operations` を書き換えず、`audio-engine-exited` の原因が reader の採った本当の VST になる | 継ぎ目 |
| T9 | 文言：確認済みと未確認（J-13 の数え方を含む） | 既存の C2 の試験に倣う |
| T10 | 互換：K 群・`engine_life`・F1b-0a-1 の試験が通る。書き換えるのは 4章の3件だけ（10秒の互換の試験、`replies.rs` の単体、`link_tests.rs` の T3） | 既存 |
| T11 | 壊して確かめる：期限の分類、3.2 の勝ち負け、`received_at` の判定、配信ミックスの主を残すこと、を外すと、それぞれ T5・T3・T4・T2 が失敗する | 一時的な改変 |

## 6. 既知の狭い競合

F1b-0a-1 の 11章の3つは、この段でもそのまま残る（F1b-0b の合格の条件）。C3 の切り離しも、同じ窓（reader が CAS に勝った直後の `vst_operations`、配信ミックスの `settle()` の直後の EOF、`ReplySlot` の閉じる前の Host の回収）を通る。この段では増やさない。

## 7. レビューの判断の基準

今直すのは、退行・保存データの破損や喪失・固まる/回復できない・main では起きない誤った情報の残存、のどれかに当たるものだけ。それ以外は 6章に足して F1b-0b へ送る。

## 8. Neon のレビュー（第1版）への対応

| 指摘 | 対応 |
|---|---|
| 必須：起動の確認の間の C3（J-24 の例外） | 3.2 の例外、T8 |
| 必須：CAS に負けたときの `vst_operations` と戻り値 | 3.2 の 1・3、T13 |
| 必須：I3 の試験、T2 を公開の操作から | T12、T2 |
| 推奨：期限の後の空読みの禁止、モード VST の `received_at` | 3.3、T4、T7 |
| 軽微：要求の中身の列挙型、`LiveMode`・`ModeSilence` の例示 | 2.2 |
| F1b-0b へ：A の命令の分類のずれを検出する単体の検査 | F1b-0b の合格の条件に足す |

## 付録 A. 命令の分類の根拠（実装：`src-tauri/src/audio/deadline.rs`）

実装は `reply_deadline`（`deadline.rs:24`）。`_` を使わない `match` で、`Command` の全65バリアントと、要求の中身の列挙型を分ける。`ファイル:行` は `src-tauri/src/` を基準にし、洗い出し 1.3 で読んだ位置を、実装の時点（`a958945a`）で照らし直したもの。

### A.1 基準の当てはめ

2.1 の基準を、共通の前処理・後処理まで含めて当てはめた。

- 前処理 P-h（`audio_engine/core/commands.rs:210-239`）：19命令で `voice_preview.invalidate_candidate()`（試聴のストリームを Drop。WASAPI の Drop はスレッドを `join` する）。
- 前処理 P-i（`audio_engine/core/commands.rs:240`、除外表 `audio_engine/core/auto_gain_commands.rs:6-46`）：除外表にない命令は `gain_preview = None`（`auto_gain_commands.rs:101`）。
- 除外表にある命令と要求は、本体が B の行為をしない限り A。除外表にない命令は、試聴の破棄の前処理を持つので B（J-25）。
- 除外表にあっても、本体が試聴の破棄をするものは B：`SetOutputGain`（`auto_gain_commands.rs:63`）、`LiveMode` の `SingingOn`・`TalkOn`（`audio_engine/core.rs:1776`・`:1782`、要求の分岐は `audio_engine/core/commands.rs:513-518`）。

### A.2 結果

| 区分 | 命令（要求の中身） | 根拠 |
|---|---|---|
| A（15命令、全部） | `ProcessingState`・`PostMixStatus`・`GetPluginRack`・`GetDevices`・`ConfigureLiveModes`・`BeginDeviceScan`・`PollDeviceScan`・`CancelDeviceScan`・`StartIdentityCapability`・`ProcessInputCapability`・`SetLoudnessMeasurement`・`SetChannelScan`・`GetFrameTimingTrace`・`StopVoiceCheckRecording`・`StopVoiceCheckPlayback` | 除外表（`auto_gain_commands.rs:7-46`）にあり、本体はメモリ・atomics・キャッシュの読み取り・実行中の列への投入だけ（洗い出し 1.3 の #1・5・11・13・15〜20・44・48・50・55・57）。`GetDevices` はキャッシュ（`audio_engine/devices.rs:116-122`）。 |
| 要求で分ける（A・B） | `ModeMonitor`：`Snapshot`・`Restore` は A | 除外表。`Restore` は係数の準備（`audio_engine/split_monitor.rs:406-431`）で、I/O・VST・ストリームはない。 |
| | `ModeSilence`：`Snapshot`・`Finish` は A、`Begin` は B | `Begin` は出力のフェードの確認を最大100 ms 待つ（`audio_engine/mode_silence.rs:168-170` の `fade_and_wait`）。`Snapshot`・`Finish` は確認だけ（`:175-214`）。 |
| | `LiveMode`：`Snapshot`・`Save`・`BindProfile`・`Recover`・`Arm`・`Disarm` は A、`SingingOn`・`TalkOn` は B | A.1 のとおり（`audio_engine/core/commands.rs:477-531`）。 |
| | `Mixing`：`Snapshot` は A、`Configure`・`Levels` は B | `Snapshot` だけ除外表（`auto_gain_commands.rs:32-34`）。ほかは P-i。 |
| | `NoiseMeasurement`：`Snapshot` は A、`Start`・`Cancel`・`Invalidate`・`Approve` は B | `Snapshot` だけ除外表（`:23-25`）。 |
| | `BuiltinEffects`：`Snapshot` は A、`Apply`・`ApplyProposal`・`Undo`・`Redo` は B | `Snapshot` だけ除外表（`:43-45`）。 |
| | `LiveOutput`・`PeakProtection`・`BroadcastTruePeak`：`config: None` は A、`Some` は B | `None` だけ除外表（`:9-11`）。`Some` は P-i。 |
| B（40命令。上の分けるもの以外の39と `AutoGain`） | `CaptureMixingBundleState`・`PostMixPrepare`・`PostMixClear`・`PostMixStart`・`RestoreSessionPlugin`・`Start`・`Stop`・`LoadPlugin`・`RestorePlugin`・`UnloadPlugin`・`ReorderPlugins`・`OpenEditor`・`SetBypass`・`SetMute`・`SetGain`・`ResumePlugin`・`SetGlobalMute`・`SetInputGain`・`SetNoiseReduction`・`StartNoiseLearning`・`CancelNoiseLearning`・`SetNoiseControlConfig`・`SetBuiltInEffects`・`SetOutputGain`・`SetGlobalBypass`・`SetInputChannels`・`GetRuntimeStats`・`GetPluginState`・`CaptureBundleState`・`SetPluginState`・`StartVoiceCheckRecording`・`PlayVoiceCheck`・`VoiceCheckPreview`・`ExportVoiceCheck`・`PlayTestTone`・`StopTestTone`・`MeasureRoundTrip`・`CancelMeasurement`・`GetRoundTripMeasurement`、`AutoGain`（全11要求） | 本体で VST・ストリーム・共有メモリ・ファイル・`sleep`／`join` を行う（`Start`・`Stop`・`LoadPlugin` など。洗い出し 1.3）、または除外表になく P-i で試聴を破棄しうる（`SetMute`・`SetGain`・`ResumePlugin`・`SetNoiseReduction` など ★ の24命令。洗い出し 1.4）。`AutoGain` は機器の列挙・試聴ストリームの作成・破棄（`auto_gain_commands.rs:249`・`:255`・`:386-392`）。 |
| C（1命令） | `ProbeLoopback` | 録音の `sleep`（`audio_engine/core.rs:1114`、`audio_engine/loopback_probe.rs:58-59`）。期限は、丸めた録音の時間＋10秒。 |

件数：命令は A 15、要求で分ける 9（`ModeMonitor` は全要求が A）、B 40（`AutoGain` を含む）、C 1。合計65。要求の中身の列挙型は `_` を使わずに全バリアントを書く（`auto_gain::Request` の11、`live_modes::Request` の8、`builtin::Request`・`noise_learning::Request` の各5など）。

### A.3 `ProbeLoopback` の録音の時間の上限

- 呼び出し元：`commands/audio.rs:1187-1209` の Tauri コマンド `probe_loopback` の `duration_ms: Option<u32>`。画面（`src/api/audio.ts:326-331`）は値をそのまま渡し、既存の画面の呼び出し（`TroubleshootModal.tsx:346`）は1500 ms だが、WebView からの `invoke` は任意の `u32` を渡せる。
- 結論：10秒を超える値が来うるので、**断らず、10秒に丸める**。`AudioHost::probe_loopback`（`audio.rs:2605`）が送る前に `deadline::probe_duration_ms` で丸め、`reply_deadline` も同じ丸めを使う（丸めた時間＋10秒。最大20秒）。

### A.4 実装の位置

- 応答の期限：`audio.rs:1097`（`await_reply`）、C3 は `audio.rs:1155`（`reply_timed_out`）。期限の値は `audio/writer.rs` の `reply_limit(&Command)`。
- `received_at` は reader が行を読んだ直後に打つ（`audio/reader.rs`）。`ReplyOutcome::Response { resp, received_at }`（`audio/replies.rs`）。
- モード VST：`Pending.limit`（`audio/mode_vst.rs:193`）、`send_mode_command`（`:700`）が命令の種類で決める。期限の後の処理は `fail_mode_deadline`（`:692`）で、理由は `ReplyTimeout`、巻き戻しはしない。

## 9. 実装のレビュー（Sol、PASS with nits）で F1b-0b へ送ったもの

- 10秒の互換の試験は `SetChannelScan`（A）に差し替えたので、`Start`（B）に固有の失敗の処理（短い期限での失敗、回収、`Stop` を送らないこと）を別に確かめる。
- T2 に保存した設定を用意し、期限切れの前後で、メモリ上の設定とファイルの中身が変わらないことを確かめる。
- T12 で、回収が終わったことを、通知を再開する前に試験用のフックで確かめる（今は、子の終了から回収の完了までの間に通知の待ちを入れても通りうる）。

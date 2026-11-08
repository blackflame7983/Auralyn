# 再生再開・再open・時刻欠落の境界（#454）

音声の時刻合わせは、遅延線のフェード、プロセス入力の比例補正、queueの1回だけのskip、の三つの既存機構だけを使う。この文書は、その機構が境界で古い音を残さず、差分とqueue残量が定義した幅へ戻るか、戻せない不連続を失敗として出すかを分類する。新しい可変バッファやPI制御は足していない。

NRのフレーム対応（[NR_TIME_ALIGNMENT.md](NR_TIME_ALIGNMENT.md)）と、queue量の時間換算（[QUEUE_DIAGNOSTICS.md](QUEUE_DIAGNOSTICS.md)）は別の量であり、下表の差分遅延へ足さない。

## 読み方

行は境界条件、列はモジュールである。セルは「既存の試験名」「今回追加した試験名」「未対応とその理由」のいずれかである。数値の出どころは次節。合成試験は端数frameの累積、インパルス、無音であり、実clockの長時間、実機、聴感の合格ではない。

OBSソースのclock補正は [設計案](OBS_SOURCE_PLUGIN_DESIGN.md)（#223）と別リポジトリ [Auralyn-OBS](https://github.com/blackflame7983/Auralyn-OBS) の試験へ委ねる。未統合の結果を通常版の合格にしない。配線と1時間録音は [#211](LATENCY_MEASUREMENTS.md)、実機・聴感・48〜72時間は [#72](https://github.com/blackflame7983/Auralyn/issues/72) であり、ここでのcallback回数では代替しない。

## 範囲

### 遅延線（alignment）

- rateは8kHz以上192kHz以下。offsetは±2000ms。既知の処理待ちは不明のままか、rateの2倍以下。
- 差分frameは `既知待ち + offset_ms * rate / 1000`（整数除算）。負なら声を、正なら伴奏を、その絶対値だけ遅らせる。
- 線の容量は `rate * 4 + 1`。遅延が容量以上の `change` は拒否し、配信は failed で無音にする。
- 切替フェードは `max(rate / 200, 1)` frame。48kHzでは240frame（5ms）。下りきってから両線のcursorと書込み数を0にし、同じ長さで戻す。bufferの中身は消さない。書込み数が遅延未満の間は無音なので、resetより前のsampleは読まない。
- 48kHzで−20msは声960frame。インパルスはそのframeに1サンプルだけ出る。

### clock（プロセス入力のSRC）

- 目標深さの基準は2048frame。処理単位は256frame。ringの下限容量は16384frame。補正は±2000ppmで飽和する。
- 偏差は `(queue − 目標) / 2048`。補正は `−偏差 * 0.004` を±0.002へ挟む。飽和する偏差は **1024frame**（`0.002 / 0.004 * 2048`）。
- render中の目標は `callback_target`。同率256frameでは `2048 + ceil(256 / 0.998) + 260 = 2565`。260はFIRの先読み分である。
- 試験が読む深さはrenderの後なので、1024frameの幅に1block（256frame）の下側だけを足す。超過は `queued <= 目標 + 1024` かつ `queued >= 目標 − 1024 − 256`。
- 深さは `容量 − 256` 以上で overfull。48kHzの既定容量では16128frame。failedになり、underrunとは別で、queueを空けても再開しない。出力はそのcallbackから無音。
- primingは `callback_target` 未満では無音で待つ。失敗にはしない。SRCの入力が足りなくなったときだけ underrunで失敗し、古い音を繰り返さない。
- 制御が無い+1500ppmは、256frameのcallback4000回で約1536frame溜まる。1024frameの幅に収まることは、補正が働いていることを意味する。

### starved（主callbackとプロセス入力の共有）

- 最後のpacketから30ms以上空いたunderrunは、queueを全部捨ててresamplerを初期化し、primingからやり直す。
- packetが30msより新しいままunderrunが100ms続けば失敗にする。両方なら30ms側（破棄）を優先する。
- 30ms未満かつ100ms未満は、失敗フラグを保ったまま待つ。音は無音のままである。
- この判定は経過ミリ秒だけを見る。WASAPIのtimestamp値は使わない。実時刻の注入口は無いので、境界値は純粋関数で固定し、破棄後の音と深さはRendererで固定する。

### 有限回復（queue_recovery）

- 開始時の目標は1block、高い側は3block。blockは、その試行で見た最大の出力callbackと入力burstの大きい方。
- `block * 4` がqueue容量を超えると非対応（status 1）。skipしない。
- 高い側の超過が `rate / 10` frame続くとフェードを始める。フェードは `max(rate / 100, 1)` frame。48kHzでは480frame（10ms）。
- skipはgainが0の次のblock先頭で `queue − 1 * block`。48kHz、block512、queue4096では3584frameを捨て、残る512frameが目標深さである。残ったインパルスの位置は元の位置から3584を引いたindexである。
- 同じ開始試行では1回だけ。2回目はexhausted（status 2）で、unityへ戻したままskipしない。
- mute、テスト音、ボイスチェック、録音、ラウドネス、分離出力、プロセス入力ではblockedであり、skipしない。プロセス入力の速度差はclock側だけが追う。

## 境界

| 境界 | alignment | clock | queue_recovery | 主callbackのstarved |
| --- | --- | --- | --- | --- |
| 再生停止後の再開 | 今回 `rapid_delay_changes_drop_the_old_impulse_and_reset_block_does_not_allocate`。reset後の初回512frameは、遅延線に残った音を出さない | 既存 `pause_and_resume_clear_old_audio_without_rt_allocation`。今回 `stale_resume_discards_the_queued_impulse_and_depth_stays_inside_the_correction_band` が、30ms側の破棄のあと古いインパルスを出さず深さを幅の中に保つ | 今回 `recovery_skip_moves_the_surviving_impulse_to_the_target_depth`。skip後の残量は目標block数。2回目の停止は既存 `one_recovery_then_second_pause_keeps_unity_and_reports_exhausted_without_allocating` | 今回 `underrun_action_discards_from_30ms_and_fails_a_fresh_gap_at_100ms`。30msで破棄、新しいpacketのまま100msで失敗。実Instantを進める結合は未対応（注入できる時計が無い） |
| consumer停止中の滞留 | 対象外。queueを持たない | 今回 `consumer_pause_below_overfull_returns_depth_inside_the_correction_band`。overfull未満の滞留は再生し、0ppmで深さだけ1024frameの幅へ戻す。この経路は古い音を捨てない | 深さが3block以下ならskipしない。超過が続けば上のskipが1回だけ深さを目標へ戻す。プロセス入力は常にblocked | 未対応。underrunになるまで破棄しない。深いが合法なqueueを時刻で捨てる処理は無い |
| device再open | 今回の試験の後半。44.1kHzの新しいmixerは、前のmixerの音を出さない | 今回 `new_renderer_after_rate_change_does_not_keep_the_previous_signal`。失敗した古いRendererは残し、新しいRendererは無音から始まる | 未対応。StartごとにRecoveryを作り直すが、機器を開かずにEngineの再openは組まない。初期gainが1であることは既存 `default_growth_and_blocked_measurement_never_skip_or_leave_silence` | 未対応。新しいStartではstarvedの計時が無い状態から始まる。callback全体の再openは機器が要る |
| packet burst | 対象外 | 今回 `packet_burst_overfull_fails_and_stays_silent`。`容量−256` 以上で失敗し、深さを戻しても無音のまま。既存 `pause_and_resume_clear_old_audio_without_rt_allocation` の末尾は、回復のあと満杯にする別条件 | 既存 `default_growth_and_blocked_measurement_never_skip_or_leave_silence`。blockが増えて容量を超えると非対応でskipしない | overfullはunderrunではないので破棄しない。Rendererの失敗は今回のburst試験。startup側のfailed共有は同じ分岐だが、機器callbackとの結合は未対応 |
| timestamp欠落 | 未対応。遅延線はtimestampを受け取らない | 未対応。SRCはqueue深さだけを見る | 未対応。skipはframe数だけを見る | 未対応（補正として）。`GetBuffer` の時刻引数は両方None。`DATA_DISCONTINUITY` と `TIMESTAMP_ERROR` は数えるだけ。今回 `discontinuity_and_timestamp_error_flags_are_counted_without_moving_samples`。サンプルの位置は動かない。上限を超えたpacketは計数しない |
| timestamp逆行 | 未対応。同上 | 未対応。同上 | 未対応。同上 | 未対応。逆行した時刻の値を読む処理が無い。フラグが立ったときだけ計数が増える（同じ試験）。フラグが無ければ検出できない |
| epoch変更 | 未対応（補正として）。epochでは遅延を変えない。再Startは新しいmixer | 未対応（補正として）。epochでは比率を変えない。再Startは新しいRenderer | 未対応（補正として）。queueのepochが進んでもRecoveryの目標深さは変わらない | 未対応（補正として）。観測側は既存 `batch_readiness_missing_metadata_and_epoch_mismatch_stay_unknown`、`metadata_gaps_bad_times_epochs_and_bounded_pending_never_invent_zero_latency`、`stop_seals_pending_but_not_unconsumed_input_and_new_epoch_is_empty` が、古いepochを遅延0にしない。音声の遅延線へは渡さない |
| ±ppm | 対象外。ppmを見ない | 既存 `signed_clock_offsets_stay_bounded_and_limits_are_explicit`（離散模擬、360000step、深さ1024以上4096未満）、`actual_src_consumption_tracks_both_clock_directions_without_frame_drops`、`independent_device_rates_follow_both_clock_directions_without_allocating`、`large_callbacks_follow_clock_drift_without_sawtooth_correction_or_allocation`。再開後の±1500ppmは今回のstale試験 | 速度差を繰り返しのskipで隠さない。既存 `one_recovery_then_second_pause_keeps_unity_and_reports_exhausted_without_allocating`。プロセス入力はblocked | 追従中はunderrunにしない。既存のclock試験がunderruns 0。補正が±2000ppmを超えて失敗にする処理は無い（飽和して深さがずれる） |
| rate変更 | 容量とフェード長は生成時のrate。今回の試験が44.1kHzの新しいmixerで初回blockの割当0を見る | 今回 `new_renderer_after_rate_change_does_not_keep_the_previous_signal`。既存 `independent_device_rates_follow_both_clock_directions_without_allocating` は最初から異率 | 既存 `sine_impulse_and_opposite_channels_have_bounded_silent_skip_boundary` が44.1/48/96/192/384kHzでskip境界を見る | 新しいRendererはprimedでない。今回のrate変更試験の初回renderは無音で、割当0 |
| 初回処理・切替・resetのRT割当 | 既存 `changing_delay_fades_resets_old_audio_and_never_allocates`。今回の連打、フェード中の再変更、reset後512frameも割当0 | 既存のrender試験に加え、今回の破棄と `wait_for_audio`、burstの失敗render、新しいRendererの初回renderが割当0 | 既存 `one_recovery_then_second_pause_keeps_unity_and_reports_exhausted_without_allocating` と `loudness_request_during_down_or_silent_measures_only_next_unity_block`。今回のskip決定も割当0 | 判定は整数比較だけ。破棄と再primingの割当0はclockの今回の試験。callbackスレッドへ待ちやログは足していない |

既知の処理待ちと手動offsetの分離は既存 `impulse_alignment_preserves_sign_and_applies_known_processing_separately`。priming不足と大きなcallbackは既存 `priming_waits_for_the_whole_callback_and_real_depletion_still_fails` と `maximum_callback_capacity_is_reserved_before_rendering`。完全frameの消費は既存 `mapped_queue_consumes_whole_frames_and_duplicates_only_the_selected_channel`。測定要求がフェード中なら次のunityまで待つことは既存のloudness試験と `pending_measurement_cancel_and_replacement_keep_latest_intent`。

本人用のプロセス入力は、pauseかgenerationが変わったblockでqueueを捨ててから `wait_for_audio` する。このRenderは機器を開く関数の中でしか作れないため、その分岐自体の試験は未対応である。捨てる操作と再primingの音は、上のclock試験が同じ二つの呼出で見ている。

## 未対応のままにしたもの

- WASAPIのtimestamp欠落・逆行で遅延を足したり引いたりする処理。フラグは計数し、サンプル列は動かさない。
- epoch文字列を音声の比率や遅延へ渡す処理。文字列は開始試行の識別であり、`{プロセスID}-{ナノ秒}:queue:{試行}` をStartのたびに新しくする。
- Engine全体のdevice再open。queue、Recovery、Renderer、遅延線はStartで作り直すが、その結合は機器が要る。
- 30msと100msの実経過。境界値は純粋関数、破棄後の音はRenderer、と呼出側は同じ関数を使う。壁時計を進める試験は無い。
- consumerが止まっただけでunderrunにもoverfullにもならないqueue。深さは±2000ppmの範囲へ戻るが、溜まった音は再生する。
- 補正が±2000ppmに張り付いたまま、なお深さが1024frameを超えて増え続ける場合の追加の失敗。現状は飽和したまま追従を続ける。overfullまで達すればその時点で失敗する。
- OBSプラグイン側のclock。#223とAuralyn-OBSを参照し、この表の合格に含めない。

## 実行

`src-tauri` で次を実行する。デバイスは開かない。

```powershell
cargo test --locked --lib rapid_delay_changes_drop_the_old_impulse_and_reset_block_does_not_allocate
cargo test --locked --lib underrun_action_discards_from_30ms_and_fails_a_fresh_gap_at_100ms
cargo test --locked --lib stale_resume_discards_the_queued_impulse_and_depth_stays_inside_the_correction_band
cargo test --locked --lib consumer_pause_below_overfull_returns_depth_inside_the_correction_band
cargo test --locked --lib packet_burst_overfull_fails_and_stays_silent
cargo test --locked --lib new_renderer_after_rate_change_does_not_keep_the_previous_signal
cargo test --locked --lib recovery_skip_moves_the_surviving_impulse_to_the_target_depth
cargo test --locked --lib discontinuity_and_timestamp_error_flags_are_counted_without_moving_samples
```

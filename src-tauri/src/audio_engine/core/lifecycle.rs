//! 開始・終了の所有権境界。デバイスに依存せず失敗経路を検証する。
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapRb,
};
use std::sync::atomic::{AtomicBool, Ordering};

// 本番CPALと同じ失敗境界を、実driverをロードせず回帰検証する。
#[cfg(test)]
#[path = "../../../../third_party/cpal-0.17.3/src/host/asio/build_lifecycle.rs"]
mod asio_build_lifecycle;

type ReturnProducer<T> = <HeapRb<T> as Split>::Prod;
type ReturnConsumer<T> = <HeapRb<T> as Split>::Cons;

/// 出力の既定設定への再試行と、優先した入力rateから戻す再試行を各1回に制限する。
/// ASIOは共有driverのrateを使うため、独立した入力rateの優先・再試行を追加しない。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StartupPolicy {
    prefer_same_rate_input: bool,
    output_fallback: bool,
}

impl Default for StartupPolicy {
    fn default() -> Self {
        Self {
            prefer_same_rate_input: true,
            output_fallback: true,
        }
    }
}

impl StartupPolicy {
    pub(super) fn prefer_same_rate_input(self, is_asio: bool) -> bool {
        self.prefer_same_rate_input && !is_asio
    }

    pub(super) fn retry_default_input(self, used_preferred_input: bool) -> Option<Self> {
        (used_preferred_input && self.prefer_same_rate_input).then_some(Self {
            prefer_same_rate_input: false,
            ..self
        })
    }

    pub(super) fn retry_default_output(self) -> Option<Self> {
        self.output_fallback.then_some(Self {
            output_fallback: false,
            ..self
        })
    }
}

/// callbackを破棄するスレッドでは所有値を解放せず、制御側へ一度だけ返す。
pub(crate) struct CallbackOwner<T> {
    value: Option<T>,
    returned: ReturnProducer<T>,
}

pub(crate) struct ControlOwner<T>(ReturnConsumer<T>);

pub(crate) fn callback_owner<T>(value: T) -> (CallbackOwner<T>, ControlOwner<T>) {
    // この専用キューへの送信はCallbackOwner::dropの一回のみ。満杯にならない。
    let (returned, receiver) = HeapRb::new(1).split();
    (
        CallbackOwner {
            value: Some(value),
            returned,
        },
        ControlOwner(receiver),
    )
}

impl<T> CallbackOwner<T> {
    pub(crate) fn get_mut(&mut self) -> &mut T {
        self.value
            .as_mut()
            .expect("callbackの所有値はDropまで保持する")
    }
}

impl<T> Drop for CallbackOwner<T> {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            // 非RT側はstreamを破棄するまでreceiverを保持する。
            // 唯一の送信なので容量不足は起こらない。
            if let Err(value) = self.returned.try_push(value) {
                // 不変条件が壊れた場合も、callback側でVSTを解放しない。
                std::mem::forget(value);
                debug_assert!(false, "callback終了キューへの重複返却");
            }
        }
    }
}

impl<T> ControlOwner<T> {
    pub(crate) fn take(&mut self) -> Option<T> {
        self.0.try_pop()
    }
}

/// 開始途中の失敗では、入力→出力の順に回収する。成功時だけEngineへ移す。
pub(super) struct StreamPair<S> {
    input: Option<S>,
    output: Option<S>,
}

/// 入力build失敗時、呼出側へエラーが戻る前に出力を解放する。
#[cfg(test)]
pub(super) fn build_input<S, E>(
    output: S,
    build: impl FnOnce() -> Result<S, E>,
) -> Result<(S, S), E> {
    let input = build()?;
    Ok((output, input))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BuildOrder {
    InputFirst,
    OutputFirst,
}

impl BuildOrder {
    pub(super) fn for_host(is_asio: bool) -> Self {
        if is_asio {
            Self::InputFirst
        } else {
            Self::OutputFirst
        }
    }
}

#[derive(Debug)]
pub(super) enum BuildPairError<E> {
    Input(E),
    Output(E),
}

/// 未実行closureと生成済みstreamを、Devices/processor回収より先に解放する。
/// 戻り値は登録順によらず出力・入力の順で、play順と混同しない。
pub(super) fn build_pair<S, E>(
    order: BuildOrder,
    build_output: impl FnOnce() -> Result<S, E>,
    build_input: impl FnOnce() -> Result<S, E>,
) -> Result<(S, S), BuildPairError<E>> {
    match order {
        BuildOrder::InputFirst => {
            let input = build_input().map_err(BuildPairError::Input)?;
            let output = build_output().map_err(BuildPairError::Output)?;
            Ok((output, input))
        }
        BuildOrder::OutputFirst => {
            let output = build_output().map_err(BuildPairError::Output)?;
            let input = build_input().map_err(BuildPairError::Input)?;
            Ok((output, input))
        }
    }
}

/// ローカルstream/未実行closureは呼出前に破棄する。失敗buildのcallbackを
/// driverが保持する場合も、Deviceの最終解放までreceiverを保持してから回収する。
pub(super) fn release_devices_before_retry<D>(devices: (D, D), cleanup: impl FnOnce()) {
    drop(devices);
    cleanup();
}

impl<S> StreamPair<S> {
    pub(super) fn start<E>(
        output: S,
        input: S,
        mut play: impl FnMut(&S) -> Result<(), E>,
    ) -> Result<Self, E> {
        let pair = Self {
            input: Some(input),
            output: Some(output),
        };
        play(pair.output.as_ref().expect("生成済み出力"))?;
        play(pair.input.as_ref().expect("生成済み入力"))?;
        Ok(pair)
    }

    pub(super) fn commit(mut self) -> (S, S) {
        (
            self.input.take().expect("開始済み入力"),
            self.output.take().expect("開始済み出力"),
        )
    }
}

impl<S> Drop for StreamPair<S> {
    fn drop(&mut self) {
        self.input.take();
        self.output.take();
    }
}

/// 機器のDefault長が不明な場合も、確保上限を固定しRT側で再確保しない。
pub(super) const MAX_BLOCK_FRAMES: usize = 65_536;

pub(super) fn block_capacity(
    fixed: Option<u32>,
    default_max: Option<u32>,
) -> anyhow::Result<usize> {
    // Defaultの能力上限は実際のcallback長ではない。WASAPIのu32::MAXも
    // 未限定の能力として扱い、アプリが準備する上限へ抑える。
    let frames = match fixed {
        Some(frames) => frames as usize,
        None => default_max
            .filter(|&frames| frames > 0)
            .map_or(MAX_BLOCK_FRAMES, |frames| {
                (frames as usize).min(MAX_BLOCK_FRAMES)
            }),
    };
    anyhow::ensure!(
        frames > 0 && frames <= MAX_BLOCK_FRAMES,
        "音声バッファは1〜{}フレームに対応しています（指定: {}）",
        MAX_BLOCK_FRAMES,
        frames
    );
    Ok(frames.max(4096))
}

/// 確保容量を超えるcallbackを部分送出せず、全体無音と停止要求へ変える。
pub(super) fn output_block_frames(
    data: &mut [f32],
    channels: usize,
    capacity: usize,
    stream_failed: &AtomicBool,
    capacity_failed: &AtomicBool,
) -> Option<usize> {
    let frames = data.len().checked_div(channels).unwrap_or(0);
    if frames > capacity {
        data.fill(0.0);
        stream_failed.store(true, Ordering::Release);
        capacity_failed.store(true, Ordering::Release);
        return None;
    }
    if frames == 0 {
        data.fill(0.0);
        return None;
    }
    Some(frames)
}

#[cfg(test)]
mod tests {
    #[test]
    fn queue_cleanup_releases_observer_and_retains_only_stopped_attempt_counters() {
        use super::super::Engine;
        use crate::audio_engine::queue_diagnostics::{QueueDiagnostics, QueueState};
        let mut engine = Engine::new();
        assert!(engine.queue_snapshot().is_none());
        let queue = Arc::new(HeapRb::<f32>::new(9));
        let weak_queue = Arc::downgrade(&queue);
        let (mut producer, consumer) = queue.clone().split();
        producer.try_push(0.2).unwrap();
        producer.try_push(0.3).unwrap();
        engine.queue_observer = Some(queue);
        let diagnostics = Arc::new(QueueDiagnostics::new("old".into(), 44_100, 48_000, 1, 2, 9));
        diagnostics.record_input(1, 1, 1, 1, 2);
        engine.queue_diagnostics = Some(diagnostics.clone());
        engine.queue_state = QueueState::Running;
        assert_eq!(engine.queue_snapshot().unwrap().current_frames, Some(1));
        // 本番ではstream終了で両端が消える。同じ順序をデバイスなしで再現する。
        drop(producer);
        drop(consumer);
        engine.clear_audio_resources();
        assert!(weak_queue.upgrade().is_none());
        assert_eq!(Arc::strong_count(&diagnostics), 2);
        let stopped = engine.queue_snapshot().unwrap();
        assert_eq!(stopped.state, QueueState::Stopped);
        assert!(stopped.current_frames.is_none());
        assert_eq!(stopped.queued_frames_at_stop, Some(1));
        assert_eq!(stopped.accepted_output_frames, 1);
        engine.clear_audio_resources();
        assert_eq!(
            engine.queue_snapshot().unwrap().queued_frames_at_stop,
            Some(1)
        );
        engine.queue_diagnostics = Some(Arc::new(QueueDiagnostics::new(
            "next".into(),
            96_000,
            96_000,
            2,
            2,
            9,
        )));
        engine.queue_state = QueueState::Preparing;
        engine.queue_slots_at_stop = None;
        let next = engine.queue_snapshot().unwrap();
        assert_ne!(next.epoch, stopped.epoch);
        assert_eq!(next.accepted_output_frames, 0);
        assert!(next.queued_frames_at_stop.is_none());
    }

    #[test]
    fn input_and_output_retry_budgets_are_independent_and_exhaust_after_three_attempts() {
        let initial = StartupPolicy::default();
        assert!(initial.prefer_same_rate_input(false));
        assert!(!initial.prefer_same_rate_input(true));
        assert!(initial.retry_default_input(false).is_none());

        // 優先入力拒否→既定入力拒否→既定出力でも拒否。
        let native_input = initial.retry_default_input(true).unwrap();
        assert!(!native_input.prefer_same_rate_input(false));
        assert!(native_input.retry_default_input(true).is_none());
        let native_both = native_input.retry_default_output().unwrap();
        assert!(native_both.retry_default_input(true).is_none());
        assert!(native_both.retry_default_output().is_none());

        // 先に出力が拒否された場合も、入力だけ戻す1回を残す。
        let native_output = initial.retry_default_output().unwrap();
        assert!(native_output.prefer_same_rate_input(false));
        assert!(native_output.retry_default_output().is_none());
        let native_both_reversed = native_output.retry_default_input(true).unwrap();
        assert_eq!(native_both, native_both_reversed);

        // ASIOでは優先入力を選ばず、従来の出力fallback1回だけを使う。
        let used_asio_preferred = initial.prefer_same_rate_input(true);
        assert!(initial.retry_default_input(used_asio_preferred).is_none());
        assert!(initial
            .retry_default_output()
            .unwrap()
            .retry_default_output()
            .is_none());
    }

    #[test]
    fn stopped_builtin_changes_start_from_latest_config_without_old_queued_revisions() {
        use super::super::Engine;
        use crate::audio_engine::builtin::{Config, Preset};
        use ringbuf::{traits::*, HeapRb};
        use std::sync::atomic::Ordering;
        let mut engine = Engine::new();
        let (producer, mut consumer) = HeapRb::new(8).split();
        engine.command_tx = Some(producer);

        for cutoff in [40.0, 160.0] {
            engine
                .builtin
                .legacy(Config {
                    active: true,
                    preset: Preset::Singing,
                    amount: 0.7,
                    reverb: Some(crate::audio_engine::reverb::ReverbParams {
                        enabled: true,
                        mix: cutoff / 1000.0,
                        ..Default::default()
                    }),
                    singing: Some(crate::audio_engine::singing::SingingParams {
                        low_cut_hz: cutoff,
                        ..Default::default()
                    }),
                })
                .unwrap();
            engine.publish_builtin();
        }
        assert!(engine.pending_audio_msgs.is_empty());
        assert_eq!(engine.builtin.config.singing.unwrap().low_cut_hz, 160.0);
        let revision = engine.builtin.revision;
        let (initial, _) = engine.initial_builtin().unwrap();
        assert_eq!(initial.singing.unwrap().low_cut_hz, 160.0);
        assert_eq!(initial.reverb.unwrap().mix, 0.16);
        engine.flush_pending_audio_msgs();
        assert!(engine.pending_audio_msgs.is_empty());
        assert!(consumer.try_pop().is_none());
        assert_eq!(engine.builtin.applied.load(Ordering::Acquire), revision);
        engine.clear_audio_resources();
        assert_eq!(engine.builtin.config.singing.unwrap().low_cut_hz, 160.0);
    }

    #[test]
    fn clearing_stream_invalidates_builtin_history_without_changing_config() {
        use super::super::Engine;
        use crate::audio_engine::builtin::{Config, Request};
        let mut engine = Engine::new();
        let before = engine.builtin.snapshot(false);
        let config = Config {
            active: true,
            ..Default::default()
        };
        engine
            .builtin
            .request(
                Request::Apply {
                    epoch: before.epoch,
                    expected_revision: before.revision,
                    config: config.clone(),
                },
                false,
            )
            .unwrap();
        let token = engine.builtin.snapshot(false);
        assert!(token.undo_token.is_some());
        engine.clear_audio_resources();
        let after = engine.builtin.snapshot(false);
        assert!(after.undo_token.is_none() && after.redo_token.is_none());
        assert_eq!(after.config, config);
        assert!(engine
            .builtin
            .request(
                Request::Undo {
                    epoch: after.epoch,
                    expected_revision: after.revision,
                    undo_token: token.undo_token.unwrap()
                },
                false
            )
            .is_err());
    }
    #[test]
    fn stopping_drops_unpublished_deferred_restore_and_pending_start_is_rejected() {
        use super::super::Engine;
        use crate::{
            audio_engine::restoration::{unix_ms, StagedRestore},
            ipc::RestorePluginRequest,
            vst_host::instance::with_mock_vst,
        };
        with_mock_vst(false, |instance| {
            let mut engine = Engine::new();
            engine.pending_restore = Some(
                StagedRestore::load_with(
                    RestorePluginRequest {
                        path: "mock.vst3".into(),
                        state: Some(String::new()),
                        bypassed: true,
                        muted: true,
                        gain: 0.5,
                    },
                    1,
                    unix_ms() + 8_000,
                    |_| Ok(instance),
                )
                .unwrap(),
            );
            engine.clear_audio_resources();
            assert!(engine.pending_restore.is_none());
            assert!(engine.plugin_manager.order.is_empty());
        });
        let mut engine = Engine::new();
        engine
            .plugin_manager
            .pending_init
            .push("legacy-pending".into());
        assert!(engine
            .plugin_manager
            .prepare_for_audio_start(48_000.0, 2, 4096)
            .is_err());
        assert_eq!(engine.plugin_manager.pending_init, ["legacy-pending"]);
    }

    #[test]
    fn full_command_queue_keeps_restored_processor_and_complete_initial_controls_until_control_cleanup(
    ) {
        use super::super::{AudioThreadMessage, Engine};
        use crate::{
            audio_engine::restoration::{unix_ms, StagedRestore},
            ipc::RestorePluginRequest,
            vst_host::instance::with_mock_vst,
        };
        with_mock_vst(false, |instance| {
            let mut engine = Engine::new();
            let mut staged = StagedRestore::load_with(
                RestorePluginRequest {
                    path: "mock.vst3".into(),
                    state: Some(String::new()),
                    bypassed: true,
                    muted: true,
                    gain: 0.0,
                },
                1,
                unix_ms() + 8000,
                |_| Ok(instance),
            )
            .unwrap();
            let processor = staged.finish(Some((48_000.0, 8192, 2))).unwrap().unwrap();
            let index = engine
                .plugin_manager
                .reserve_restored_index(&staged)
                .unwrap();
            let (id, _, _) = engine.plugin_manager.commit_restored(staged, index);
            let (prod, mut cons) = HeapRb::<AudioThreadMessage>::new(1).split();
            engine.command_tx = Some(prod);
            engine.queue_audio_msg(AudioThreadMessage::SetInputGain(1.0));
            engine.queue_audio_msg(AudioThreadMessage::AddProcessor {
                index,
                processor,
                initial_gain: 0.0,
                initial_bypassed: true,
                initial_muted: true,
            });
            assert_eq!(engine.pending_audio_msgs.len(), 1);
            assert!(engine.plugin_manager.get(&id).is_some());
            assert!(matches!(
                cons.try_pop(),
                Some(AudioThreadMessage::SetInputGain(1.0))
            ));
            engine.flush_pending_audio_msgs();
            match cons.try_pop().unwrap() {
                AudioThreadMessage::AddProcessor {
                    processor,
                    initial_gain,
                    initial_bypassed,
                    initial_muted,
                    ..
                } => {
                    assert_eq!(initial_gain, 0.0);
                    assert!(initial_bypassed && initial_muted);
                    drop(processor);
                }
                _ => panic!("restored processor must be one complete publication"),
            }
            engine.clear_audio_resources();
            assert!(engine
                .plugin_manager
                .get(&id)
                .unwrap()
                .create_processor()
                .is_none());
            drop(engine);
        });
    }

    #[test]
    fn first_callback_levels_keep_explicit_intent_across_cleanup_and_retry() {
        use super::super::Engine;
        use std::sync::atomic::Ordering;
        let mut engine = Engine::new();
        let (muted, input, mut output) = engine.initial_callback_levels();
        assert!(!muted);
        assert_eq!((input, output.next()), (1.0, 1.0));
        assert!(!engine.output_gain_initialized);
        for (muted, input, output) in [(true, 0.0, 0.0), (true, 1.5, 2.0), (false, 0.25, 0.8)] {
            engine.set_global_mute_intent(muted);
            engine.voice_input_gain = input;
            engine.request_output_gain(output).unwrap();
            for _ in 0..3 {
                // 開始失敗・fallback・停止は同じ回収処理を通る。
                engine.clear_audio_resources();
                let (initial_mute, initial_input, mut initial_output) =
                    engine.initial_callback_levels();
                assert_eq!(initial_mute, muted);
                assert_eq!(initial_input, input);
                // 最初のsampleから保持値。0からのランプや1へのリセットをしない。
                assert_eq!(initial_output.next(), output);
                assert_eq!(engine.voice_input_gain, input);
                assert!(engine.output_gain_initialized);
                assert_eq!(
                    engine.gain_shared.confirmed_gain.load(Ordering::Acquire),
                    output.to_bits()
                );
                assert_eq!(
                    engine.gain_shared.applied_revision.load(Ordering::Acquire),
                    engine.output_gain_revision
                );
            }
        }
    }

    use super::*;
    use crate::vst_host::instance::allocation_counts;
    use std::sync::{Arc, Mutex};

    struct Tracked(
        Arc<Mutex<Vec<(&'static str, std::thread::ThreadId)>>>,
        &'static str,
    );

    #[test]
    fn asio_builds_input_first_but_both_hosts_play_output_first_and_commit_once() {
        for is_asio in [false, true] {
            let order = BuildOrder::for_host(is_asio);
            let events = Arc::new(Mutex::new(Vec::new()));
            let builds = std::cell::RefCell::new(Vec::new());
            let (output, input) = build_pair(
                order,
                || {
                    builds.borrow_mut().push("output");
                    Ok::<_, ()>(Tracked(events.clone(), "output"))
                },
                || {
                    builds.borrow_mut().push("input");
                    Ok::<_, ()>(Tracked(events.clone(), "input"))
                },
            )
            .unwrap();
            assert_eq!(
                *builds.borrow(),
                if is_asio {
                    vec!["input", "output"]
                } else {
                    vec!["output", "input"]
                }
            );
            let mut plays = Vec::new();
            let streams = StreamPair::start(output, input, |stream| {
                plays.push(stream.1);
                Ok::<_, ()>(())
            })
            .unwrap();
            assert_eq!(plays, ["output", "input"]);
            assert!(events.lock().unwrap().is_empty());
            let (input, output) = streams.commit();
            drop(input);
            drop(output);
            assert_eq!(events.lock().unwrap().len(), 2);
        }
    }

    #[test]
    fn both_build_orders_reclaim_unused_closure_or_first_stream_before_devices_and_cleanup() {
        for order in [BuildOrder::InputFirst, BuildOrder::OutputFirst] {
            for failure in ["input", "output", "output play", "input play"] {
                let events = Arc::new(Mutex::new(Vec::new()));
                let devices = (
                    Tracked(events.clone(), "input device"),
                    Tracked(events.clone(), "output device"),
                );
                let (callback, mut returned) = callback_owner(Tracked(events.clone(), "processor"));
                struct Stream {
                    _callback: Option<CallbackOwner<Tracked>>,
                    _tracked: Tracked,
                }
                let builds = std::cell::RefCell::new(Vec::new());
                let output_events = events.clone();
                let output_builds = &builds;
                let result = build_pair(
                    order,
                    move || {
                        output_builds.borrow_mut().push("output");
                        // 失敗時も、生成しなかったcallbackはこのclosureの終了時に返却する。
                        if failure == "output" {
                            return Err("output");
                        }
                        Ok(Stream {
                            _callback: Some(callback),
                            _tracked: Tracked(output_events, "output stream"),
                        })
                    },
                    || {
                        builds.borrow_mut().push("input");
                        if failure == "input" {
                            return Err("input");
                        }
                        Ok(Stream {
                            _callback: None,
                            _tracked: Tracked(events.clone(), "input stream"),
                        })
                    },
                );
                match result {
                    Err(BuildPairError::Input(direction)) => assert_eq!(direction, failure),
                    Err(BuildPairError::Output(direction)) => assert_eq!(direction, failure),
                    Ok((output, input)) => {
                        let mut plays = 0;
                        assert!(StreamPair::start(output, input, |_| {
                            plays += 1;
                            if (failure == "output play" && plays == 1) || plays == 2 {
                                Err(())
                            } else {
                                Ok(())
                            }
                        })
                        .is_err());
                    }
                }
                // 未実行出力closureを含め、build_pairの返却時にはcallbackを回収済み。
                let processor = returned.take().expect("callbackはDevices解放前に返却する");
                assert!(returned.take().is_none());
                release_devices_before_retry(devices, || {
                    drop(processor);
                    events
                        .lock()
                        .unwrap()
                        .push(("plugin stop", std::thread::current().id()));
                });
                events
                    .lock()
                    .unwrap()
                    .push(("next snapshot", std::thread::current().id()));
                let events = events.lock().unwrap();
                let names: Vec<_> = events.iter().map(|e| e.0).collect();
                let devices_begin = names.iter().position(|n| *n == "input device").unwrap();
                assert!(names[..devices_begin].iter().all(|n| n.ends_with("stream")));
                assert_eq!(
                    &names[devices_begin..],
                    [
                        "input device",
                        "output device",
                        "processor",
                        "plugin stop",
                        "next snapshot"
                    ]
                );
                assert!(events.iter().all(|e| e.1 == std::thread::current().id()));
                let expected_builds = match (order, failure) {
                    (BuildOrder::InputFirst, "input") => vec!["input"],
                    (BuildOrder::OutputFirst, "output") => vec!["output"],
                    (BuildOrder::InputFirst, _) => vec!["input", "output"],
                    _ => vec!["output", "input"],
                };
                assert_eq!(*builds.borrow(), expected_builds);
            }
        }
    }

    #[test]
    fn retry_releases_streams_and_both_devices_before_processor_and_new_snapshot() {
        for failure in ["output build", "input build", "output play", "input play"] {
            let events = Arc::new(Mutex::new(Vec::with_capacity(16)));
            let devices = (
                Tracked(events.clone(), "input device"),
                Tracked(events.clone(), "output device"),
            );
            let (callback, mut returned) = callback_owner(Tracked(events.clone(), "processor"));
            struct Stream {
                _callback: Option<CallbackOwner<Tracked>>,
                _stream: Tracked,
            }
            let output = Stream {
                _callback: Some(callback),
                _stream: Tracked(events.clone(), "output stream"),
            };
            match failure {
                "output build" => drop(output),
                "input build" => assert!(build_input(output, || Err::<Stream, _>(())).is_err()),
                _ => {
                    let input = Stream {
                        _callback: None,
                        _stream: Tracked(events.clone(), "input stream"),
                    };
                    let mut play = 0;
                    assert!(StreamPair::start(output, input, |_| {
                        play += 1;
                        if (failure == "output play" && play == 1) || play == 2 {
                            Err(())
                        } else {
                            Ok(())
                        }
                    })
                    .is_err());
                }
            }
            release_devices_before_retry(devices, || drop(returned.take().unwrap()));
            events
                .lock()
                .unwrap()
                .push(("next snapshot", std::thread::current().id()));
            let names: Vec<_> = events.lock().unwrap().iter().map(|event| event.0).collect();
            let output = names
                .iter()
                .position(|name| *name == "output stream")
                .unwrap();
            let processor = names.iter().position(|name| *name == "processor").unwrap();
            let input_device = names
                .iter()
                .position(|name| *name == "input device")
                .unwrap();
            let output_device = names
                .iter()
                .position(|name| *name == "output device")
                .unwrap();
            let snapshot = names
                .iter()
                .position(|name| *name == "next snapshot")
                .unwrap();
            assert!(output < processor && input_device < processor && output_device < processor);
            assert!(input_device < snapshot && output_device < snapshot);
            assert!(events
                .lock()
                .unwrap()
                .iter()
                .all(|event| event.1 == std::thread::current().id()));
        }
    }
    impl Drop for Tracked {
        fn drop(&mut self) {
            self.0
                .lock()
                .unwrap()
                .push((self.1, std::thread::current().id()));
        }
    }

    #[test]
    fn asio_prepare_failure_registers_neither_callback_and_reclaims_unexecuted_closure() {
        use super::asio_build_lifecycle::prepare_and_register;
        for direction in ["input", "output"] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let (callback, mut returned) = callback_owner(Tracked(events.clone(), "processor"));
            let registered = std::cell::Cell::new(false);
            let result = prepare_and_register(
                || Err::<(), _>(direction),
                || {
                    registered.set(true);
                    callback
                },
            );
            assert!(result.is_err());
            assert!(!registered.get());
            assert!(events.lock().unwrap().is_empty());
            drop(returned.take().expect("未実行の登録closureも返却する"));
            assert_eq!(events.lock().unwrap()[0].0, "processor");
        }
    }

    #[test]
    fn asio_start_failure_removes_message_and_data_callbacks_before_device_or_processor_drop() {
        use super::asio_build_lifecycle::{prepare_and_register, start_prepared_stream};
        struct RegisteredStream {
            callback: Option<CallbackOwner<Tracked>>,
            events: Arc<Mutex<Vec<(&'static str, std::thread::ThreadId)>>>,
        }
        impl Drop for RegisteredStream {
            fn drop(&mut self) {
                self.callback.take();
                let mut events = self.events.lock().unwrap();
                events.push(("data removed", std::thread::current().id()));
                events.push(("message removed", std::thread::current().id()));
            }
        }
        for direction in ["input", "output"] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let devices = (
                Tracked(events.clone(), "input device"),
                Tracked(events.clone(), "output device"),
            );
            let (callback, mut returned) = callback_owner(Tracked(events.clone(), "processor"));
            let (_, stream) = prepare_and_register(
                || Ok::<_, &str>(()),
                || RegisteredStream {
                    callback: Some(callback),
                    events: events.clone(),
                },
            )
            .unwrap();
            assert!(start_prepared_stream(stream, |_| Err(direction)).is_err());
            let names: Vec<_> = events.lock().unwrap().iter().map(|e| e.0).collect();
            assert_eq!(names, ["data removed", "message removed"]);
            release_devices_before_retry(devices, || {
                drop(
                    returned
                        .take()
                        .expect("driverが生存していても失敗Streamから返却済み"),
                );
                events
                    .lock()
                    .unwrap()
                    .push(("plugin stop", std::thread::current().id()));
            });
            events
                .lock()
                .unwrap()
                .push(("next snapshot", std::thread::current().id()));
            let events = events.lock().unwrap();
            let names: Vec<_> = events.iter().map(|e| e.0).collect();
            assert_eq!(
                names,
                [
                    "data removed",
                    "message removed",
                    "input device",
                    "output device",
                    "processor",
                    "plugin stop",
                    "next snapshot"
                ]
            );
            assert!(events.iter().all(|e| e.1 == std::thread::current().id()));
        }
    }

    #[test]
    fn failed_build_retained_by_driver_returns_processor_before_control_cleanup() {
        struct Driver {
            callback: Option<CallbackOwner<Tracked>>,
            events: Arc<Mutex<Vec<(&'static str, std::thread::ThreadId)>>>,
        }
        impl Drop for Driver {
            fn drop(&mut self) {
                self.callback.take();
                self.events
                    .lock()
                    .unwrap()
                    .push(("driver drop", std::thread::current().id()));
            }
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let (callback, mut returned) = callback_owner(Tracked(events.clone(), "processor"));
        let driver = std::rc::Rc::new(Driver {
            callback: Some(callback),
            events: events.clone(),
        });
        let devices = (driver.clone(), driver);
        assert!(returned.take().is_none());
        release_devices_before_retry(devices, || {
            drop(
                returned
                    .take()
                    .expect("Device最終dropより先にreceiverを破棄しない"),
            );
            events
                .lock()
                .unwrap()
                .push(("plugin stop", std::thread::current().id()));
        });
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.0)
                .collect::<Vec<_>>(),
            ["driver drop", "processor", "plugin stop"]
        );
    }

    #[test]
    fn callback_destruction_returns_ownership_without_release_or_allocation() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let (callback, mut control) = callback_owner(Tracked(events.clone(), "processor"));
        std::thread::spawn(move || assert_eq!(allocation_counts(|| drop(callback)), (0, 0)))
            .join()
            .unwrap();
        assert!(events.lock().unwrap().is_empty());
        drop(control.take().unwrap());
        assert!(control.take().is_none());
        assert_eq!(
            *events.lock().unwrap(),
            [("processor", std::thread::current().id())]
        );
    }

    #[test]
    fn play_failures_release_both_streams_before_retry_and_success_commits_once() {
        for failed in [Some("output"), Some("input"), None] {
            let events = Arc::new(Mutex::new(Vec::new()));
            let mut played = Vec::new();
            let result = StreamPair::start(
                Tracked(events.clone(), "output"),
                Tracked(events.clone(), "input"),
                |stream| {
                    played.push(stream.1);
                    if Some(stream.1) == failed {
                        Err(())
                    } else {
                        Ok(())
                    }
                },
            );
            if failed.is_some() {
                assert!(result.is_err());
                assert_eq!(
                    events
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|e| e.0)
                        .collect::<Vec<_>>(),
                    ["input", "output"]
                );
            } else {
                assert!(events.lock().unwrap().is_empty());
                let (input, output) = result.unwrap().commit();
                assert!(events.lock().unwrap().is_empty());
                drop(input);
                drop(output);
                assert_eq!(events.lock().unwrap().len(), 2);
            }
            assert_eq!(
                played,
                if failed == Some("output") {
                    vec!["output"]
                } else {
                    vec!["output", "input"]
                }
            );
        }
    }

    #[test]
    fn capacity_uses_this_attempt_and_rejects_unsupported_lengths() {
        for size in [128, 8192, 256, 65_536] {
            assert_eq!(
                block_capacity(Some(size), Some(512)).unwrap(),
                (size as usize).max(4096)
            );
        }
        assert_eq!(block_capacity(None, Some(16_384)).unwrap(), 16_384);
        assert_eq!(block_capacity(None, None).unwrap(), MAX_BLOCK_FRAMES);
        assert_eq!(
            block_capacity(None, Some(u32::MAX)).unwrap(),
            MAX_BLOCK_FRAMES
        );
        assert_eq!(
            block_capacity(None, Some(65_537)).unwrap(),
            MAX_BLOCK_FRAMES
        );
        assert_eq!(block_capacity(None, Some(0)).unwrap(), MAX_BLOCK_FRAMES);
        for size in [0, 65_537, u32::MAX] {
            assert!(block_capacity(Some(size), None).is_err());
        }
    }

    #[test]
    fn oversized_callback_silences_the_whole_block_and_notifies_without_allocation() {
        let failed = AtomicBool::new(false);
        let capacity_failed = AtomicBool::new(false);
        let mut data = vec![0.25; (MAX_BLOCK_FRAMES + 1) * 2];
        assert_eq!(
            allocation_counts(|| {
                assert_eq!(
                    output_block_frames(&mut data, 2, MAX_BLOCK_FRAMES, &failed, &capacity_failed),
                    None
                );
            }),
            (0, 0)
        );
        assert!(data.iter().all(|&sample| sample == 0.0));
        assert!(failed.load(Ordering::Acquire));
        assert!(capacity_failed.swap(false, Ordering::AcqRel));
        assert!(!capacity_failed.load(Ordering::Acquire));
        // 上限内の端数ブロックはそのまま通り、通知や無音化を行わない。
        failed.store(false, Ordering::Release);
        let mut supported = [0.25; 14];
        assert_eq!(
            output_block_frames(&mut supported, 2, 8, &failed, &capacity_failed),
            Some(7)
        );
        assert_eq!(supported, [0.25; 14]);
        assert!(!failed.load(Ordering::Acquire));
        assert!(!capacity_failed.load(Ordering::Acquire));
    }

    #[test]
    fn input_build_failure_releases_output_and_callback_before_fallback() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let (callback, mut control) = callback_owner(Tracked(events.clone(), "processor"));
        struct Output {
            _callback: CallbackOwner<Tracked>,
            _stream: Tracked,
        }
        let output = Output {
            _callback: callback,
            _stream: Tracked(events.clone(), "output"),
        };
        let result = build_input(output, || Err::<Output, _>("input build"));
        assert!(result.is_err());
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.0)
                .collect::<Vec<_>>(),
            ["output"]
        );
        // 本番と同じく、stream破棄後の制御側cleanupを済ませてから再試行する。
        drop(control.take().unwrap());
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.0)
                .collect::<Vec<_>>(),
            ["output", "processor"]
        );
    }

    #[test]
    fn each_input_fallback_returns_callback_and_releases_processors_before_next_preparation() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut policy = StartupPolicy::default();
        for attempt in 0..3 {
            // 次の準備は、それ以前のstream/callback/processorの回収後にだけ始める。
            assert_eq!(events.lock().unwrap().len(), attempt * 2);
            let (callback, mut control) = callback_owner(Tracked(events.clone(), "processor"));
            struct Output {
                _stream: Tracked,
                _callback: CallbackOwner<Tracked>,
            }
            let output = Output {
                _stream: Tracked(events.clone(), "output"),
                _callback: callback,
            };
            assert!(build_input(output, || Err::<Output, _>("input build")).is_err());
            assert_eq!(events.lock().unwrap().len(), attempt * 2 + 1);
            drop(control.take().unwrap());
            assert!(control.take().is_none());
            assert_eq!(events.lock().unwrap().len(), attempt * 2 + 2);
            match attempt {
                0 => policy = policy.retry_default_input(true).unwrap(),
                1 => policy = policy.retry_default_output().unwrap(),
                _ => {
                    assert!(policy.retry_default_input(false).is_none());
                    assert!(policy.retry_default_output().is_none());
                }
            }
        }
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .map(|event| event.0)
                .collect::<Vec<_>>(),
            [
                "output",
                "processor",
                "output",
                "processor",
                "output",
                "processor"
            ]
        );
    }

    #[test]
    fn engine_cleanup_is_idempotent_and_clears_all_attempt_receivers() {
        use super::super::{CallbackProcessors, Engine};
        let mut engine = Engine::new();
        let (mut callback, control) = callback_owner(CallbackProcessors {
            reverb: crate::audio_engine::reverb::Reverb::new(Default::default(), 48_000).unwrap(),
            processors: std::array::from_fn(|_| None),
            pending_retire: std::array::from_fn(|_| None),
            pending_rejected: crate::audio_engine::deferred_drop::DeferredDrop::new(),
        });
        assert!(callback.get_mut().processors.iter().all(Option::is_none));
        engine.processor_return = Some(control);
        let (producer, consumer) = HeapRb::new(1).split();
        engine.command_tx = Some(producer);
        drop(consumer);
        let (_, consumer) = HeapRb::new(1).split();
        engine.channel_rx = Some(consumer);
        let (_, consumer) = HeapRb::new(1).split();
        engine.retire_rx = Some(consumer);
        engine.gain_main_device = Some("previous-output".into());
        drop(callback);
        for _ in 0..2 {
            engine.clear_audio_resources();
            assert!(engine.processor_return.is_none());
            assert!(engine.command_tx.is_none());
            assert!(engine.channel_rx.is_none());
            assert!(engine.retire_rx.is_none());
            assert!(engine.gain_capture_rx.is_none());
            assert!(engine.gain_main_device.is_none());
            assert!(engine.input_stream.is_none() && engine.output_stream.is_none());
            assert_eq!(engine.processing_block_capacity, 0);
        }
    }

    #[test]
    fn all_processor_preparation_paths_use_effective_capacity_across_restart() {
        use super::super::Engine;
        let mut engine = Engine::new();
        engine.current_sample_rate = 48_000.0;
        engine.current_channels = 2;
        // Default時の統計用512は、実際に準備する最大容量とは独立する。
        engine.current_block_size = 512;
        for (fixed, default_max, expected) in [
            (None, Some(8192), 8192),
            (None, Some(u32::MAX), MAX_BLOCK_FRAMES),
            (Some(16_384), Some(512), 16_384),
            (Some(256), Some(8192), 4096),
        ] {
            engine
                .configure_processing_capacity(fixed, default_max)
                .unwrap();
            // 起動時prepare、LoadPlugin、遅延prepareの本番呼出元はすべて
            // processor_setupを通し、callbackも同じ保持容量を使用する。
            assert_eq!(engine.processor_setup(), (48_000.0, expected, 2));
            assert_eq!(engine.processing_block_capacity, expected);
            assert_eq!(engine.current_block_size, 512);
            engine.clear_audio_resources();
            assert_eq!(engine.processor_setup(), (48_000.0, 0, 2));
        }
    }
}

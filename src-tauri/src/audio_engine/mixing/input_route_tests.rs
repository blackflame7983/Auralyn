//! #464 観点1・8。取得callbackだけを合成producerへ置き換え、実際のSRC・分岐・workerを通す。
use super::*;
use crate::audio_engine::{
    builtin,
    core::lifecycle::CallbackOwner,
    live_output,
    mixing::{controls, runtime, Levels},
    queue_diagnostics::QueueDiagnostics,
    split_monitor::{self, BroadcastFrame},
};
use std::sync::{atomic::AtomicU64, mpsc};

const RATE: u32 = 48_000;
const BLOCK: usize = 256;
type AudioTx = <Arc<HeapRb<f32>> as Split>::Prod;

// Controller::prepareのデバイス解決以降と同じ容量・所有形状。CPAL/COMは呼ばない。
fn source(output_rate: u32) -> (AudioTx, Render) {
    let capacity = process_capture::clock::queue_capacity(RATE, output_rate, BLOCK).unwrap();
    let queue = Arc::new(HeapRb::new(capacity * 2));
    let (tx, rx) = queue.split();
    let shared = Arc::new(process_capture::Shared::for_mixing(
        Arc::default(),
        RATE,
        Arc::default(),
    ));
    (
        tx,
        Render {
            renderer: process_capture::clock::Renderer::with_rates_and_capacity(
                RATE,
                output_rate,
                capacity,
            )
            .unwrap(),
            queue: rx,
            samples: vec![0.0; BLOCK * 2],
            shared,
            starved_at: None,
            generation: (0, 0),
        },
    )
}

fn fill(tx: &mut AudioTx, ordinal: &mut usize, signal: impl Fn(usize) -> [f32; 2]) {
    // 独立producerは出力clockではなく、入力側の番号を進める。
    while tx.occupied_len() < 4096 * 2 {
        assert_eq!(tx.push_slice(&signal(*ordinal)), 2);
        *ordinal += 1;
    }
}

struct Graph {
    worker: Option<split_monitor::Worker>,
    monitor: CallbackOwner<split_monitor::Monitor>,
    controller: split_monitor::Controller,
    voice_tx: <HeapRb<f32> as Split>::Prod,
    music_tx: AudioTx,
    queue: split_monitor::BroadcastQueue,
    received: mpsc::Receiver<Vec<f32>>,
    source: Arc<process_capture::Shared>,
}

impl Graph {
    fn new(rate: u32) -> Self {
        let (voice_tx, voice_rx) = HeapRb::new(8192).split();
        let queue = Arc::new(HeapRb::new(8192));
        let (broadcast_tx, mut broadcast_rx) = queue.clone().split();
        let config = live_output::Config {
            split_processing: true,
            monitor_singing: Some(builtin::Config::default()),
            monitor_talk: Some(builtin::Config::default()),
            ..Default::default()
        };
        let failed = Arc::new(AtomicBool::new(false));
        let (controller, mut monitor) = split_monitor::Controller::prepare_with_input_channels(
            voice_rx,
            broadcast_tx,
            None,
            Arc::new(QueueDiagnostics::new("#464".into(), rate, rate, 2, 2, 4096)),
            BLOCK,
            &config,
            rate,
            1.0,
            1.0,
            [0, 1],
            false,
            false,
            Arc::new(AtomicU64::new(u64::from(1.0f32.to_bits()))),
            failed.clone(),
            None,
            0,
            Default::default(),
            None,
            2,
        )
        .unwrap();
        let shared = Arc::new(controls::Shared::new(&Levels::default()));
        shared.update(&Levels::default(), Some(127)).unwrap();
        let (music_tx, render) = source(rate);
        let source = render.shared.clone();
        monitor.get_mut().configure_mixing(
            runtime::Monitor::new(render, shared.clone(), rate).unwrap(),
            None,
            shared.clone(),
        );
        let mut mixer = runtime::Broadcast::new(rate, shared, source.clone()).unwrap();
        let (sent, received) = mpsc::channel();
        let mut frames = [BroadcastFrame::default(); BLOCK];
        let mut audio = vec![vec![0.0; BLOCK]; 2];
        let worker = split_monitor::Worker::start(
            move |output| {
                assert_eq!(broadcast_rx.pop_slice(&mut frames), BLOCK);
                for (index, frame) in frames.iter().enumerate() {
                    audio[0][index] = frame.voice[0];
                    audio[1][index] = frame.voice[1];
                }
                mixer.process(&mut audio, &frames);
                for (index, frame) in output.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                    *frame = [audio[0][index], audio[1][index]];
                }
                // テスト側の観測のみ。製品callbackには確保やI/Oを追加しない。
                sent.send(output.to_vec()).unwrap();
            },
            queue.clone(),
            controller.shared.clone(),
            failed,
            BLOCK,
        )
        .unwrap();
        Self {
            worker: Some(worker),
            monitor,
            controller,
            voice_tx,
            music_tx,
            queue,
            received,
            source,
        }
    }

    fn block(&mut self, frames: usize) -> Vec<f32> {
        assert_eq!(self.voice_tx.push_slice(&vec![0.0; frames * 2]), frames * 2);
        let mut output = vec![0.0; frames * 2];
        self.monitor.get_mut().render(&mut output, None);
        assert!(!self.controller.shared.failed.load(Ordering::Acquire));
        assert!(!self.source.failed.load(Ordering::Acquire));
        output
    }

    fn capture(&mut self, epoch: usize, old: bool) -> (Vec<f32>, Vec<f32>, usize) {
        let mut ordinal = epoch;
        let mut monitor = Vec::new();
        let mut broadcast = Vec::new();
        for _ in 0..20 {
            fill(&mut self.music_tx, &mut ordinal, |n| {
                let n = n - epoch;
                if old {
                    let value = -0.4 - (n % 100) as f32 * 0.001;
                    [value, value * 0.5]
                } else if n >= 1024 && (n - 1024).is_multiple_of(521) {
                    let value = 0.25 + ((n - 1024) / 521 % 4) as f32 * 0.025;
                    [value, value * -0.5]
                } else {
                    [0.0; 2]
                }
            });
            monitor.extend(self.block(BLOCK));
            // wall clockはworker異常時の打切りだけ。音声の時刻・期待値には使わない。
            broadcast.extend(
                self.received
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap(),
            );
        }
        (monitor, broadcast, ordinal)
    }
}

impl Drop for Graph {
    fn drop(&mut self) {
        // workerをjoinしてからキュー・callback ownerを破棄する。
        drop(self.worker.take());
    }
}

fn impulse_position(samples: &[f32]) -> usize {
    // train中の最大振幅ではなく最初のインパルスの到達を測る。rateで探索範囲を変えない。
    samples
        .as_chunks::<2>()
        .0
        .iter()
        .position(|frame| frame[0] > 0.1)
        .expect("インパルスが観測できない")
}

#[test]
fn dsp464_restart_recreates_independent_input_queues_renderer_and_broadcast_worker() {
    for output_rate in [48_000, 44_100] {
        let mut old = Graph::new(RATE);
        let (monitor, broadcast, last) = old.capture(0, true);
        assert!(monitor.iter().any(|sample| *sample < -0.1));
        assert!(broadcast.iter().any(|sample| *sample < -0.1));
        assert!(old.music_tx.occupied_len() > 0);
        // 半ブロックをworker待ちキューへ残し、SRC・遅延線・キューすべてを汚して停止する。
        old.block(BLOCK / 2);
        assert_eq!(old.queue.occupied_len(), BLOCK / 2);
        drop(old);
        // Stopでproducer自体が消える。停止中の500msは入力の時間軸だけを進める。
        let restart_epoch = last + RATE as usize / 2;
        let mut restarted = Graph::new(output_rate);
        let (actual_monitor, actual_broadcast, _) = restarted.capture(restart_epoch, false);
        let mut fresh = Graph::new(output_rate);
        let (fresh_monitor, fresh_broadcast, _) = fresh.capture(restart_epoch, false);
        for (name, actual, expected) in [
            ("monitor", actual_monitor, fresh_monitor),
            ("broadcast", actual_broadcast, fresh_broadcast),
        ] {
            // 全出力を比較するので、SRCの裾やworkerの遅延線に残った古い音も検出する。
            assert_eq!(actual, expected, "{name}, restart rate={output_rate}");
            assert!(actual
                .as_chunks::<2>()
                .0
                .iter()
                .all(|frame| (frame[1] + frame[0] * 0.5).abs() < 1e-6));
            let position = impulse_position(&actual);
            assert_eq!(position, impulse_position(&expected));
            eprintln!("#464 restart {RATE}->{output_rate} {name}: old_frames=0, impulse={position} frames, fresh_delta=0 frames, stopped=500 ms");
        }
    }
}

#[test]
fn dsp464_track_meters_are_after_track_gain_before_monitor_gate_and_downstream_processing() {
    for case in [
        "unity",
        "voice_gain",
        "music_gain",
        "monitor_gate",
        "voice_mute",
        "music_mute",
    ] {
        let mut levels = Levels::default();
        match case {
            "voice_gain" => levels.voice.gain = 0.5,
            "music_gain" => levels.accompaniment.gain = 0.25,
            "monitor_gate" => levels.monitor_accompaniment = false,
            "voice_mute" => levels.voice.muted = true,
            "music_mute" => levels.accompaniment.muted = true,
            _ => {}
        }
        let shared = Arc::new(controls::Shared::new(&levels));
        shared.update(&levels, Some(0)).unwrap();
        let (mut tx, render) = source(RATE);
        let mut broadcast =
            runtime::Broadcast::new(RATE, shared.clone(), render.shared.clone()).unwrap();
        let mut monitor = runtime::Monitor::new(render, shared.clone(), RATE).unwrap();
        let mut ordinal = 0;
        let mut frames = [BroadcastFrame::default(); BLOCK];
        let mut audio = vec![vec![0.0; BLOCK]; 2];
        let mut monitor_music = [0.0; 2];
        // SRCの立上り・5msのゲイン補間を測定区間から除く。各ケースは同じ初期状態から。
        for _ in 0..32 {
            fill(&mut tx, &mut ordinal, |_| [0.2, -0.1]);
            monitor.begin_block(BLOCK, false, 0);
            for (index, frame) in frames.iter_mut().enumerate() {
                let mixed = monitor.frame(index);
                monitor_music = mixed.monitor;
                *frame = BroadcastFrame {
                    accompaniment: mixed.broadcast,
                    mute_generation: mixed.mute_generation,
                    ..Default::default()
                };
            }
            monitor.finish_block();
            audio[0].fill(0.4);
            audio[1].fill(-0.2);
            broadcast.process(&mut audio, &frames);
        }
        let vg = if levels.voice.muted {
            0.0
        } else {
            levels.voice.gain
        };
        let mg = if levels.accompaniment.muted {
            0.0
        } else {
            levels.accompaniment.gain
        };
        for (name, actual, expected) in [
            (
                "voice",
                controls::Shared::peaks(&shared.voice_peak),
                [0.4 * vg, 0.2 * vg],
            ),
            (
                "music",
                controls::Shared::peaks(&shared.accompaniment_peak),
                [0.2 * mg, 0.1 * mg],
            ),
            (
                "mix",
                controls::Shared::peaks(&shared.mix_peak),
                [0.4 * vg + 0.2 * mg, 0.2 * vg + 0.1 * mg],
            ),
        ] {
            eprintln!("#464 {case} {name}: {actual:?}, expected={expected:?}");
            for (a, e) in actual.into_iter().zip(expected) {
                assert!(
                    (a - e).abs() < 1e-5,
                    "{case} {name}: actual={actual:?}, expected={expected:?}"
                );
            }
        }
        let gate = if levels.monitor_accompaniment {
            1.0
        } else {
            0.0
        };
        assert!((monitor_music[0] - 0.2 * mg * gate).abs() < 1e-5);
        assert!((monitor_music[1] + 0.1 * mg * gate).abs() < 1e-5);
    }
}

#[test]
fn resume478_mixing_route_publishes_resume_counts_once_per_boundary() {
    let (mut tx, mut render) = source(RATE);
    let mut ordinal = 0;
    fill(&mut tx, &mut ordinal, |_| [0.2, -0.2]);
    render.begin_block(BLOCK, false, (0, 0));
    let mut discarded = 0;
    for boundary in 1..=3 {
        for _ in 0..4800 {
            assert_eq!(tx.push_slice(&[-0.1, 0.1]), 2);
        }
        assert_eq!(
            crate::dsp_verification_allocator::allocation_counts(|| {
                // 最大2窓（約80ms）とfadeの後に、同じ境界が一度だけ通知される。
                for _ in 0..(RATE as usize * 80).div_ceil(1000 * BLOCK) + 3 {
                    for _ in 0..BLOCK {
                        assert_eq!(tx.push_slice(&[-0.1, 0.1]), 2);
                    }
                    render.begin_block(BLOCK, false, (0, 0));
                }
            }),
            (0, 0)
        );
        let snapshot = render.shared.snapshot();
        assert_eq!(snapshot.pause_resets, boundary);
        assert!(snapshot.waiting_discarded_frames > discarded);
        discarded = snapshot.waiting_discarded_frames;
        for _ in 0..4 {
            for _ in 0..BLOCK {
                assert_eq!(tx.push_slice(&[-0.1, 0.1]), 2);
            }
            render.begin_block(BLOCK, false, (0, 0));
        }
        let snapshot = render.shared.snapshot();
        assert_eq!(snapshot.pause_resets, boundary);
        assert_eq!(snapshot.waiting_discarded_frames, discarded);
        assert!(!snapshot.failed);
    }
}

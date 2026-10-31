//! 配信DSPを別workerへ閉じ込める固定二役構成。monitor callbackは内蔵処理だけを所有する。
use super::{
    core::{
        lifecycle::{callback_owner, CallbackOwner, ControlOwner},
        AudioThreadMessage,
    },
    live_modes::{Mode, RtVoice, Voice},
    live_output::Config,
    reverb,
};
use anyhow::{anyhow, Result};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapRb,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc,
};
type AudioRx = <HeapRb<f32> as Split>::Cons;
type AudioTx = <HeapRb<f32> as Split>::Prod;
pub type GainRx = <HeapRb<f32> as Split>::Cons;
type JobRx = <HeapRb<Job> as Split>::Cons;
type JobTx = <HeapRb<Job> as Split>::Prod;
#[expect(
    clippy::large_enum_variant,
    reason = "固定容量キューの値をRTで解放するため、Boxによる最終解放を持ち込まない"
)]
enum Job {
    Mode {
        voice: Voice,
        reverb: reverb::Coefficients,
        revision: u64,
        talk: bool,
        frames: u32,
    },
    Window(u64),
}
pub struct Controls {
    // 下位2bitは回復抑止要求とunity ACK、上位は要求世代。workerの古い完了で新要求を解除しない。
    measurement: AtomicU64,
    unity_after: AtomicU64,
    muted: AtomicBool,
    input_gain: AtomicU32,
    output_gain: AtomicU32,
    channels: AtomicU64,
    pub generation: AtomicU64,
    pub accepted: AtomicU64,
    pub completed: AtomicU64,
    pub failed: Arc<AtomicBool>,
    pub queued: AtomicU64,
    pub offered: AtomicU64,
    pub dropped: AtomicU64,
}
impl Controls {
    fn reserve_measurement(&self) {
        let _ = self
            .measurement
            .try_update(Ordering::AcqRel, Ordering::Acquire, |state| {
                Some((state.wrapping_add(4) & !3) | 1)
            });
    }
    fn measurement_blocked(&self) -> bool {
        self.measurement.load(Ordering::Acquire) & 1 != 0
    }
    pub fn measurement_ticket(&self) -> u64 {
        self.measurement.load(Ordering::Acquire)
    }
    pub fn measurement_ready(&self, ticket: u64) -> bool {
        ticket & 1 == 0 || ticket & 2 != 0
    }
    pub fn measurement_ready_at(&self, ticket: u64, first_frame: u64) -> bool {
        ticket & 1 == 0
            || (self.measurement_ready(ticket)
                && first_frame >= self.unity_after.load(Ordering::Acquire))
    }
    fn acknowledge_unity(&self, ticket: u64) {
        if ticket & 3 != 1 {
            return;
        }
        // 予約後にunityへ戻ったblockの末尾。古いunity blockでは測定を始めない。
        self.unity_after
            .store(self.offered.load(Ordering::Relaxed), Ordering::Release);
        let _ = self.measurement.compare_exchange(
            ticket,
            ticket | 2,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
    pub fn finish_measurement_block(&self, ticket: u64, active: bool) {
        if !active {
            let _ = self.measurement.compare_exchange(
                ticket,
                ticket & !1,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
}
pub struct Controller {
    pub shared: Arc<Controls>,
    tx: JobTx,
    pending: Option<Job>,
    pending_window: Option<u64>,
    owner: ControlOwner<Monitor>,
    rate: u32,
    config: Config,
}
pub struct Monitor {
    timing: Option<super::frame_timing::OutputRecorder>,
    diagnostics: Arc<super::queue_diagnostics::QueueDiagnostics>,
    input_buffer: Vec<f32>,
    recovery: super::queue_recovery::Recovery,
    input: AudioRx,
    broadcast: AudioTx,
    recovery_gains: AudioTx,
    jobs: JobRx,
    shared: Arc<Controls>,
    levels: Arc<AtomicU64>,
    main_failed: Arc<AtomicBool>,
    voice: RtVoice,
    reverb: reverb::Reverb,
    peak: super::peak_protection::Rt,
    peak_shared: Arc<super::peak_protection::Shared>,
    output_gain: f32,
    generation: u64,
}
impl Controller {
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        input: AudioRx,
        broadcast: AudioTx,
        timing: Option<super::frame_timing::OutputRecorder>,
        diagnostics: Arc<super::queue_diagnostics::QueueDiagnostics>,
        max_frames: usize,
        config: &Config,
        rate: u32,
        input_gain: f32,
        output_gain: f32,
        channels: [usize; 2],
        muted: bool,
        _bypassed: bool,
        levels: Arc<AtomicU64>,
        main_failed: Arc<AtomicBool>,
        mode: Option<Mode>,
        revision: u64,
        peak: (
            super::peak_protection::Config,
            Arc<super::peak_protection::Shared>,
        ),
    ) -> Result<(Self, CallbackOwner<Monitor>, GainRx)> {
        let selected = if mode == Some(Mode::Talk) {
            &config.monitor_talk
        } else {
            &config.monitor_singing
        };
        let selected = selected
            .as_ref()
            .ok_or_else(|| anyhow!("自分用の歌・雑談設定を明示してください"))?;
        let voice = RtVoice::new(Voice::prepare(selected, rate).map_err(|e| anyhow!(e))?);
        let reverb = reverb::Reverb::new(selected.reverb.unwrap_or_default(), rate)
            .map_err(|e| anyhow!(e))?;
        let (tx, jobs) = HeapRb::new(32).split();
        let shared = Arc::new(Controls {
            measurement: AtomicU64::new(0),
            unity_after: AtomicU64::new(0),
            muted: AtomicBool::new(muted),
            input_gain: AtomicU32::new(input_gain.to_bits()),
            output_gain: AtomicU32::new(output_gain.to_bits()),
            channels: AtomicU64::new(channels[0] as u64 | ((channels[1] as u64) << 32)),
            generation: AtomicU64::new(0),
            accepted: AtomicU64::new(revision),
            completed: AtomicU64::new(revision),
            failed: Arc::new(AtomicBool::new(false)),
            queued: AtomicU64::new(0),
            offered: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        });
        let recovery =
            super::queue_recovery::Recovery::new(input.capacity().get() / 2, rate as usize, 1, 3);
        let (recovery_gains, gains) = HeapRb::new(broadcast.capacity().get() / 2).split();
        let (monitor, owner) = callback_owner(Monitor {
            timing,
            diagnostics,
            input_buffer: vec![0.0; max_frames * 2],
            recovery,
            input,
            broadcast,
            recovery_gains,
            jobs,
            shared: shared.clone(),
            levels,
            main_failed,
            voice,
            reverb,
            peak: super::peak_protection::Rt::new(peak.0, rate),
            peak_shared: peak.1,
            output_gain,
            generation: 0,
        });
        Ok((
            Self {
                shared,
                tx,
                pending: None,
                pending_window: None,
                owner,
                rate,
                config: config.clone(),
            },
            monitor,
            gains,
        ))
    }
    pub fn message(&mut self, message: &AudioThreadMessage) {
        if matches!(
            message,
            AudioThreadMessage::StartVoiceCheckRecording { .. }
                | AudioThreadMessage::StartAutoGainCapture(_)
                | AudioThreadMessage::SetLoudnessMeasurement(Some(_))
        ) {
            self.shared.reserve_measurement();
        }
        match message {
            AudioThreadMessage::SetGlobalMute(value) => {
                self.shared.muted.store(*value, Ordering::Release);
                self.shared.generation.fetch_add(1, Ordering::AcqRel);
            }
            AudioThreadMessage::SetInputGain(value) => self
                .shared
                .input_gain
                .store(value.to_bits(), Ordering::Release),
            AudioThreadMessage::SetOutputGain { value, .. } => self
                .shared
                .output_gain
                .store(value.to_bits(), Ordering::Release),
            AudioThreadMessage::SetInputChannels(l, r) => self
                .shared
                .channels
                .store(*l as u64 | ((*r as u64) << 32), Ordering::Release),
            _ => {}
        }
    }
    pub fn mode(&mut self, mode: Mode, revision: u64) -> Result<()> {
        let config = if mode == Mode::Talk {
            &self.config.monitor_talk
        } else {
            &self.config.monitor_singing
        };
        let config = config
            .as_ref()
            .ok_or_else(|| anyhow!("自分用の本番設定が未定義です"))?;
        let job = Job::Mode {
            voice: Voice::prepare(config, self.rate).map_err(|e| anyhow!(e))?,
            reverb: super::live_modes::reverb_coefficients(config, self.rate)
                .map_err(|e| anyhow!(e))?,
            revision,
            talk: mode == Mode::Talk,
            frames: (self.rate / 50).max(1),
        };
        self.pending = Some(job);
        self.flush();
        Ok(())
    }
    pub fn snapshot(&self, epoch: String) -> super::live_output::MonitorSnapshot {
        super::live_output::MonitorSnapshot {
            epoch,
            broadcast_queue_frames: self.shared.queued.load(Ordering::Relaxed),
            offered_frames: self.shared.offered.load(Ordering::Relaxed),
            dropped_frames: self.shared.dropped.load(Ordering::Relaxed),
            accepted_revision: self.shared.accepted.load(Ordering::Acquire).to_string(),
            completed_revision: self.shared.completed.load(Ordering::Acquire).to_string(),
            broadcast_failed: self.shared.failed.load(Ordering::Acquire),
        }
    }
    pub fn window(&mut self, revision: u64) {
        self.pending_window = Some(revision);
        self.flush();
    }
    pub fn flush(&mut self) {
        if let Some(job) = self.pending.take() {
            if let Err(job) = self.tx.try_push(job) {
                self.pending = Some(job);
                return;
            }
        }
        if let Some(revision) = self.pending_window.take() {
            if self.tx.try_push(Job::Window(revision)).is_err() {
                self.pending_window = Some(revision);
            }
        }
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        drop(self.owner.take());
    }
}
impl Monitor {
    #[cfg(test)]
    pub fn render(&mut self, data: &mut [f32], info: Option<&cpal::OutputCallbackInfo>) {
        self.render_inner(data, info, None);
    }
    pub(crate) fn render_gated(
        &mut self,
        data: &mut [f32],
        info: Option<&cpal::OutputCallbackInfo>,
        gate: &super::mode_silence::Shared,
    ) {
        let ticket = gate.ticket();
        if gate.drain_monitor_input() {
            self.input.skip(self.input.occupied_len());
            self.input_buffer.fill(0.0);
            if let Some(timing) = &mut self.timing {
                timing.invalidate_recovery();
            }
            gate.monitor_input_drained();
        }
        self.render_inner(data, info, Some(gate));
        gate.finish(super::mode_silence::MONITOR, ticket, data);
    }
    fn render_inner(
        &mut self,
        data: &mut [f32],
        info: Option<&cpal::OutputCallbackInfo>,
        gate: Option<&super::mode_silence::Shared>,
    ) {
        let begin = self.timing.as_ref().map_or(0, |t| t.now_ns());
        data.fill(0.0);
        self.peak.sync(&self.peak_shared);
        if data.len() > self.input_buffer.len() {
            self.main_failed.store(true, Ordering::Release);
            return;
        }
        if self.main_failed.load(Ordering::Acquire) {
            return;
        }
        for _ in 0..32 {
            let Some(job) = self.jobs.try_pop() else {
                break;
            };
            match job {
                Job::Window(revision) => {
                    if let Some(timing) = &mut self.timing {
                        timing.complete_cohort_window(revision, true);
                    }
                }
                Job::Mode {
                    voice,
                    reverb,
                    revision,
                    talk,
                    frames,
                } => {
                    self.voice.start(voice, revision, 0, frames);
                    if talk {
                        self.reverb.set_transport(0.0, 1.0);
                    } else {
                        self.reverb.update(reverb);
                    }
                    self.shared.accepted.fetch_max(revision, Ordering::Release);
                }
            }
        }
        let generation = self.shared.generation.load(Ordering::Acquire);
        if self.generation != generation {
            self.reverb.reset();
            self.generation = generation;
        }
        let channels = self.shared.channels.load(Ordering::Acquire);
        let selected = [channels as u32 as usize, (channels >> 32) as usize];
        let input_gain = f32::from_bits(self.shared.input_gain.load(Ordering::Acquire));
        let target_gain = f32::from_bits(self.shared.output_gain.load(Ordering::Acquire));
        let muted = self.shared.muted.load(Ordering::Acquire);
        let measurement = self.shared.measurement_ticket();
        if self.shared.failed.load(Ordering::Acquire) {
            self.shared.finish_measurement_block(measurement, false);
        }
        let levels = self.levels.load(Ordering::Acquire);
        let trim = if levels >> 32 != 0 {
            0.0
        } else {
            f32::from_bits(levels as u32)
        };
        let skip = self.recovery.begin_block(
            self.input.occupied_len() / 2,
            data.len() / 2,
            self.diagnostics.max_burst(),
            muted || self.shared.measurement_blocked(),
        );
        if skip > 0 {
            if let Some(timing) = &self.timing {
                timing.invalidate_recovery();
            }
        }
        let skipped = self.input.skip(skip * 2) / 2;
        self.diagnostics.record_recovery(
            skipped,
            self.recovery.status(),
            self.recovery.target(),
            self.recovery.high(),
        );
        let consumed = super::queue_diagnostics::read_complete_frames(
            &mut self.input,
            &mut self.input_buffer[..data.len()],
            2,
        );
        let read = self.timing.as_ref().map_or(0, |t| t.now_ns());
        self.diagnostics.record_output(data.len() / 2, consumed);
        let frames = data.len() / 2;
        for (index, output) in data.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let pair = [
                self.input_buffer[index * 2],
                self.input_buffer[index * 2 + 1],
            ];
            let common = selected.map(|ch| {
                let value = pair.get(ch).copied().unwrap_or(0.0);
                if value.is_finite() {
                    (f64::from(value) * f64::from(input_gain))
                        .clamp(-f64::from(f32::MAX), f64::from(f32::MAX)) as f32
                } else {
                    0.0
                }
            });
            self.shared.offered.fetch_add(1, Ordering::Relaxed);
            let recovery_gain = self.recovery.next_gain();
            if !self.shared.failed.load(Ordering::Acquire)
                && !gate.is_some_and(|g| g.pause_sources())
            {
                if self.broadcast.vacant_len() >= 2 && self.recovery_gains.vacant_len() >= 1 {
                    // gainを先に公開し、PCMを読めるworkerには必ず同じframeの係数も届く。
                    let _ = self.recovery_gains.try_push(recovery_gain);
                    let _ = self.broadcast.try_push(common[0]);
                    let _ = self.broadcast.try_push(common[1]);
                } else {
                    self.shared.failed.store(true, Ordering::Release);
                    self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
            // 自分用のvoice状態は一度だけ進め、配信のNR/VSTへ触れない。
            let voice = self.voice.process(common);
            let rendered = self.reverb.process(voice, muted);
            if let Some((revision, _)) = self.voice.take_completed() {
                self.shared.completed.fetch_max(revision, Ordering::Release);
            }
            self.output_gain += (target_gain - self.output_gain) * 0.005;
            if !muted {
                for ch in 0..2 {
                    output[ch] = if rendered[ch].is_finite() {
                        (f64::from(rendered[ch])
                            * f64::from(self.output_gain)
                            * f64::from(trim)
                            * f64::from(recovery_gain))
                        .clamp(-f64::from(f32::MAX), f64::from(f32::MAX))
                            as f32
                    } else {
                        0.0
                    };
                }
            }
            let protected = self.peak.process([output[0], output[1]]);
            output[..2].copy_from_slice(&protected);
        }
        self.peak.report(&self.peak_shared, 1);
        self.shared.queued.store(
            (self.broadcast.occupied_len() / 2) as u64,
            Ordering::Relaxed,
        );
        if !self.recovery.active() {
            self.shared.acknowledge_unity(measurement);
        }
        if let Some(timing) = &mut self.timing {
            timing.record_context(
                consumed,
                frames,
                begin,
                read,
                info.map(|i| i.timestamp().callback),
                !muted && levels >> 32 == 0,
            );
        }
    }
}
pub struct Worker {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Worker {
    #[cfg(test)]
    pub fn start(
        process: impl FnMut(&mut [f32]) + Send + 'static,
        queue: Arc<HeapRb<f32>>,
        controls: Arc<Controls>,
        main_failed: Arc<AtomicBool>,
        frames: usize,
    ) -> Result<Self> {
        Self::start_gated(
            process,
            queue,
            controls,
            main_failed,
            frames,
            Arc::default(),
        )
    }
    pub(crate) fn start_gated(
        mut process: impl FnMut(&mut [f32]) + Send + 'static,
        queue: Arc<HeapRb<f32>>,
        controls: Arc<Controls>,
        main_failed: Arc<AtomicBool>,
        frames: usize,
        gate: Arc<super::mode_silence::Shared>,
    ) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let mut buffer = vec![0.0; frames * 2];
        let handle = std::thread::Builder::new()
            .name("broadcast-dsp".into())
            .spawn(move || {
                while !stopped.load(Ordering::Acquire)
                    && !main_failed.load(Ordering::Acquire)
                    && !controls.failed.load(Ordering::Acquire)
                {
                    if queue.occupied_len() < buffer.len() && !gate.drain_worker() {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                    process(&mut buffer);
                    if gate.pause_sources() {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
            })?;
        Ok(Self {
            stop,
            handle: Some(handle),
        })
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::builtin;
    use super::*;
    fn fixture() -> (
        Controller,
        CallbackOwner<Monitor>,
        AudioTx,
        Arc<HeapRb<f32>>,
        AudioRx,
        GainRx,
    ) {
        let (input, consumer) = HeapRb::new(8192).split();
        let queue = Arc::new(HeapRb::new(32768));
        let (producer, broadcast_consumer) = queue.clone().split();
        // worker用consumerはfixture中に保持し、senderの生存期間を再現する。
        let config = Config {
            device_id: Some("fixture".into()),
            split_processing: true,
            monitor_singing: Some(builtin::Config::default()),
            monitor_talk: Some(builtin::Config::default()),
            ..Config::default()
        };
        let (controller, renderer, gains) = Controller::prepare(
            consumer,
            producer,
            None,
            Arc::new(super::super::queue_diagnostics::QueueDiagnostics::new(
                "fixture".into(),
                48000,
                48000,
                2,
                2,
                8192,
            )),
            4096,
            &config,
            48_000,
            0.5,
            1.0,
            [1, 0],
            false,
            false,
            Arc::new(AtomicU64::new(1.0f32.to_bits() as u64)),
            Arc::new(AtomicBool::new(false)),
            None,
            1,
            Default::default(),
        )
        .unwrap();
        (
            controller,
            renderer,
            input,
            queue,
            broadcast_consumer,
            gains,
        )
    }
    #[test]
    fn mode_silence_monitor_acks_after_zero_output_and_stops_worker_input_before_drain() {
        use crate::audio_engine::mode_silence::{self, Request};
        let (_controller, mut renderer, mut input, queue, _consumer, _gains) = fixture();
        let mut barrier = mode_silence::Controller::default();
        let request = |finish| {
            if finish {
                Request::Finish { id: "test".into() }
            } else {
                Request::Begin { id: "test".into() }
            }
        };
        barrier
            .request(request(false), 1, true, true, true, false)
            .unwrap();
        for _ in 0..256 {
            input.try_push(0.2).unwrap();
            input.try_push(0.3).unwrap();
        }
        let mut output = [1.0; 256];
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| renderer.get_mut().render_gated(
                &mut output,
                None,
                &barrier.shared
            )),
            (0, 0)
        );
        assert_eq!(output, [0.0; 256]);
        assert!(queue.occupied_len() > 0);
        barrier
            .shared
            .finish(mode_silence::MAIN, barrier.shared.ticket(), &mut output);
        barrier
            .shared
            .finish(mode_silence::SINK, barrier.shared.ticket(), &mut output);
        barrier
            .request(request(true), 1, true, true, true, false)
            .unwrap();
        let queued = queue.occupied_len();
        renderer
            .get_mut()
            .render_gated(&mut output, None, &barrier.shared);
        assert_eq!(queue.occupied_len(), queued);
        assert!(!barrier.shared.drain_worker());
        barrier.shared.source_finished(mode_silence::INPUT);
        assert!(!barrier.shared.drain_worker());
        // 入力callbackの停止ACK後に残りのupstream PCMも破棄してからmonitorをACKする。
        renderer
            .get_mut()
            .render_gated(&mut output, None, &barrier.shared);
        assert_eq!(renderer.get_mut().input.occupied_len(), 0);
        assert!(barrier.shared.drain_worker());
    }
    #[test]
    fn common_channel_gain_runs_once_and_monitor_has_no_rt_allocation() {
        let (controller, mut renderer, mut input, _, _, _gains) = fixture();
        for _ in 0..128 {
            input.try_push(0.2).unwrap();
            input.try_push(-0.4).unwrap();
        }
        let mut output = [0.0; 256];
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| renderer
                .get_mut()
                .render(&mut output, None)),
            (0, 0)
        );
        assert!(output
            .as_chunks::<2>()
            .0
            .iter()
            .all(|frame| *frame == [-0.2, 0.1]));
        assert_eq!(controller.shared.offered.load(Ordering::Relaxed), 128);
        drop(renderer);
        drop(controller);
    }
    #[test]
    fn upstream_recovery_gain_stays_aligned_and_fades_both_outputs_once() {
        let (controller, mut renderer, mut input, _, mut audio, mut gains) = fixture();
        let mut output = [0.0; 256];
        let mut skips = 0;
        let mut faded = false;
        let mut previous_gain = 1.0;
        for _ in 0..120 {
            while input.occupied_len() < 4096 {
                input.try_push(0.2).unwrap();
                input.try_push(-0.4).unwrap();
            }
            assert_eq!(
                crate::vst_host::instance::allocation_counts(|| renderer
                    .get_mut()
                    .render(&mut output, None)),
                (0, 0)
            );
            if input.occupied_len() < 4096 - output.len() {
                skips += 1;
                assert_eq!(previous_gain, 0.0);
            }
            for frame in output.as_chunks::<2>().0.iter() {
                let gain = gains.try_pop().unwrap();
                let common = [audio.try_pop().unwrap(), audio.try_pop().unwrap()];
                // 録音用のPCMは変更せず、配信FX後に同じgainを一度だけ掛ける。
                assert_eq!(common, [-0.2, 0.1]);
                assert_eq!(*frame, common.map(|sample| sample * gain));
                faded |= gain < 1.0;
                previous_gain = gain;
            }
            assert!(gains.is_empty());
            assert!(audio.is_empty());
        }
        assert!(faded);
        assert_eq!(skips, 1);
        assert_eq!(renderer.get_mut().recovery.status(), 2);
        drop(renderer);
        drop(controller);
    }
    #[test]
    fn queued_old_unity_blocks_cannot_start_measurement_before_ack_frame_boundary() {
        let (mut controller, mut renderer, mut input, _, mut audio, mut gains) = fixture();
        let mut output = [0.0; 256];
        for _ in 0..40 {
            while input.occupied_len() < 4096 {
                input.try_push(0.2).unwrap();
                input.try_push(-0.4).unwrap();
            }
            renderer.get_mut().render(&mut output, None);
        }
        assert!(renderer.get_mut().recovery.active());
        controller.message(&AudioThreadMessage::SetLoudnessMeasurement(Some(7)));
        for _ in 0..8 {
            while input.occupied_len() < 4096 {
                input.try_push(0.2).unwrap();
                input.try_push(-0.4).unwrap();
            }
            renderer.get_mut().render(&mut output, None);
        }
        assert!(!controller.shared.failed.load(Ordering::Acquire));
        let ticket = controller.shared.measurement_ticket();
        assert!(controller.shared.measurement_ready(ticket));
        let boundary = controller.shared.unity_after.load(Ordering::Acquire);
        assert!(boundary > 40 * 128);
        let mut saw_fade = false;
        let mut started = false;
        for block in 0..48 {
            let mut unity = true;
            for _ in 0..128 {
                unity &= gains.try_pop().unwrap() == 1.0;
                audio.try_pop().unwrap();
                audio.try_pop().unwrap();
            }
            saw_fade |= !unity;
            let first = block * 128;
            let ready = controller.shared.measurement_ready_at(ticket, first) && unity;
            if first < boundary {
                assert!(!ready);
            }
            if ready {
                assert!(saw_fade);
                started = true;
            }
        }
        assert!(started);
        assert!(audio.is_empty() && gains.is_empty());
        drop(renderer);
        drop(controller);
    }
    #[test]
    fn measurement_reservation_waits_for_unity_and_stale_completion_cannot_release_it() {
        // 回復前、Down中、Silent到達時の各開始要求。
        for before in [0, 38, 41] {
            let (mut controller, mut renderer, mut input, _, mut audio, mut gains) = fixture();
            let mut output = [0.0; 256];
            for _ in 0..before {
                while input.occupied_len() < 4096 {
                    input.try_push(0.2).unwrap();
                    input.try_push(-0.4).unwrap();
                }
                renderer.get_mut().render(&mut output, None);
                audio.skip(audio.occupied_len());
                gains.skip(gains.occupied_len());
            }
            controller.message(&AudioThreadMessage::SetLoudnessMeasurement(Some(7)));
            let old = controller.shared.measurement_ticket();
            assert!(!controller.shared.measurement_ready(old));
            for _ in 0..60 {
                while input.occupied_len() < 4096 {
                    input.try_push(0.2).unwrap();
                    input.try_push(-0.4).unwrap();
                }
                assert_eq!(
                    crate::vst_host::instance::allocation_counts(|| renderer
                        .get_mut()
                        .render(&mut output, None)),
                    (0, 0)
                );
                assert_eq!(input.occupied_len(), 4096 - output.len());
                audio.skip(audio.occupied_len());
                gains.skip(gains.occupied_len());
            }
            let ready = controller.shared.measurement_ticket();
            assert!(controller.shared.measurement_ready(ready));
            controller.shared.finish_measurement_block(ready, true);
            assert!(controller.shared.measurement_blocked());
            controller.message(&AudioThreadMessage::StartAutoGainCapture(8));
            controller.shared.finish_measurement_block(ready, false);
            assert!(controller.shared.measurement_blocked());
            controller
                .shared
                .acknowledge_unity(controller.shared.measurement_ticket());
            // 完了・取消では最新の予約だけ解除し、その後は有限回復を再開できる。
            controller
                .shared
                .finish_measurement_block(controller.shared.measurement_ticket(), false);
            assert!(!controller.shared.measurement_blocked());
            for _ in 0..48 {
                while input.occupied_len() < 4096 {
                    input.try_push(0.2).unwrap();
                    input.try_push(-0.4).unwrap();
                }
                renderer.get_mut().render(&mut output, None);
                audio.skip(audio.occupied_len());
                gains.skip(gains.occupied_len());
            }
            assert!(
                renderer.get_mut().recovery.active() || renderer.get_mut().recovery.status() == 2
            );
            drop(renderer);
            drop(controller);
        }
    }
    #[test]
    fn broadcast_failure_does_not_silence_monitor_and_mute_has_priority() {
        let (mut controller, mut renderer, mut input, _, _, _gains) = fixture();
        controller.shared.failed.store(true, Ordering::Release);
        for _ in 0..256 {
            input.try_push(0.2).unwrap();
            input.try_push(-0.4).unwrap();
        }
        let mut output = [0.0; 256];
        renderer.get_mut().render(&mut output, None);
        assert!(output
            .as_chunks::<2>()
            .0
            .iter()
            .all(|frame| *frame == [-0.2, 0.1]));
        controller.message(&AudioThreadMessage::SetGlobalMute(true));
        renderer.get_mut().render(&mut output, None);
        assert_eq!(output, [0.0; 256]);
        drop(renderer);
        drop(controller);
    }
    #[test]
    fn mode_completion_is_separate_from_acceptance_and_old_acks_cannot_rewind() {
        let (mut controller, mut renderer, mut input, _, _, _gains) = fixture();
        controller.mode(Mode::Talk, 2).unwrap();
        assert_eq!(controller.shared.accepted.load(Ordering::Acquire), 1);
        let mut output = [0.0; 256];
        for _ in 0..8 {
            for _ in 0..128 {
                input.try_push(0.0).unwrap();
                input.try_push(0.0).unwrap();
            }
            renderer.get_mut().render(&mut output, None);
        }
        assert_eq!(controller.shared.accepted.load(Ordering::Acquire), 2);
        assert_eq!(controller.shared.completed.load(Ordering::Acquire), 2);
        controller.mode(Mode::Singing, 3).unwrap();
        renderer.get_mut().render(&mut output, None);
        assert_eq!(controller.shared.accepted.load(Ordering::Acquire), 3);
        assert_eq!(controller.shared.completed.load(Ordering::Acquire), 2);
        drop(renderer);
        drop(controller);
    }
    #[test]
    fn blocked_broadcast_worker_does_not_block_monitor_callback() {
        let (controller, mut renderer, mut input, queue, mut consumer, _gains) = fixture();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut first = true;
        let worker = Worker::start(
            move |_| {
                for _ in 0..256 {
                    let _ = consumer.try_pop();
                }
                if first {
                    first = false;
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
            },
            queue,
            controller.shared.clone(),
            Arc::new(AtomicBool::new(false)),
            128,
        )
        .unwrap();
        for _ in 0..128 {
            input.try_push(0.2).unwrap();
            input.try_push(-0.4).unwrap();
        }
        let mut output = [0.0; 256];
        renderer.get_mut().render(&mut output, None);
        started_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        for _ in 0..16 {
            for _ in 0..128 {
                input.try_push(0.2).unwrap();
                input.try_push(-0.4).unwrap();
            }
            assert_eq!(
                crate::vst_host::instance::allocation_counts(|| renderer
                    .get_mut()
                    .render(&mut output, None)),
                (0, 0)
            );
            assert!(output
                .as_chunks::<2>()
                .0
                .iter()
                .all(|frame| *frame == [-0.2, 0.1]));
        }
        release_tx.send(()).unwrap();
        drop(worker);
        drop(renderer);
        drop(controller);
    }
    #[test]
    fn monitor_preserves_original_input_cohort_and_acknowledges_its_own_window() {
        let (mut observer, input_timing, output_timing) =
            super::super::frame_timing::Observer::new("split-fixture".into(), 1, true);
        let mut input_timing = input_timing.unwrap();
        let (mut input, consumer) = HeapRb::new(8192).split();
        let (producer, _receiver) = HeapRb::new(8192).split();
        let config = Config {
            device_id: Some("fixture".into()),
            split_processing: true,
            monitor_singing: Some(builtin::Config::default()),
            monitor_talk: Some(builtin::Config::default()),
            ..Config::default()
        };
        let diagnostics = Arc::new(super::super::queue_diagnostics::QueueDiagnostics::new(
            "split-fixture".into(),
            48000,
            48000,
            2,
            2,
            8192,
        ));
        let (mut controller, mut renderer, _gains) = Controller::prepare(
            consumer,
            producer,
            output_timing,
            diagnostics,
            4096,
            &config,
            48000,
            1.0,
            1.0,
            [0, 1],
            false,
            false,
            Arc::new(AtomicU64::new(1.0f32.to_bits() as u64)),
            Arc::new(AtomicBool::new(false)),
            None,
            1,
            Default::default(),
        )
        .unwrap();
        let revision = observer.request_cohort_window().unwrap();
        controller.window(revision);
        let arrival = input_timing.now_ns();
        input_timing.record_span(128, arrival);
        input_timing.record_direct_emission(128, 128);
        input_timing.record(128, 128, arrival, None);
        for _ in 0..128 {
            input.try_push(0.1).unwrap();
            input.try_push(-0.1).unwrap();
        }
        let mut output = [0.0; 256];
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| renderer
                .get_mut()
                .render(&mut output, None)),
            (0, 0)
        );
        observer.drain();
        let snapshot = observer.cohort_snapshot().unwrap();
        assert_eq!(snapshot.completed_revision, revision.to_string());
        assert_eq!(snapshot.matched_frames, 128);
        assert!(snapshot.earliest_arrival_to_end.p50.is_some());
        drop(renderer);
        drop(controller);
        observer.seal();
    }
}

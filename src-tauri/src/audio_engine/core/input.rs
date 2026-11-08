//! 入力callbackから共通キューまでの処理。開始・出力callbackの所有と分ける。
use super::*;

pub(super) enum InputStream {
    Device(cpal::Stream),
    Process(crate::audio_engine::process_capture::Controller),
}
impl InputStream {
    pub(super) fn play(&self) -> Result<()> {
        match self {
            Self::Device(stream) => stream.play().map_err(Into::into),
            Self::Process(controller) => controller.play(),
        }
    }
    pub(super) fn failure_message(&self) -> Option<&'static str> {
        match self {
            Self::Device(_) => None,
            Self::Process(c) => c.failure_message(),
        }
    }
}

// 入力callbackが所有する状態。構築時に確保し、処理時は借用だけを行う。
pub(super) struct InputCallback {
    pub(super) scan_control: Arc<super::super::channel_scan::Control>,
    pub(super) rt_channel_scan: super::super::channel_scan::ChannelScan,
    pub(super) channel_prod: <HeapRb<super::super::channel_scan::Snapshot> as Split>::Prod,
    pub(super) channels: usize,
    pub(super) input_silence: Arc<crate::audio_engine::mode_silence::Shared>,
    pub(super) input_silence_reset: u64,
    pub(super) resampler: Option<crate::audio_engine::resampling::StreamResampler>,
    pub(super) input_timing: Option<crate::audio_engine::frame_timing::InputRecorder>,
    pub(super) input_process_failed: Arc<AtomicBool>,
    pub(super) input_resampling_failed: Arc<AtomicBool>,
    pub(super) input_queue_diagnostics: Arc<QueueDiagnostics>,
    pub(super) mmcss_set_in: Arc<AtomicBool>,
    pub(super) audio_prod: <Arc<HeapRb<f32>> as Split>::Prod,
    pub(super) batch_timing: bool,
    pub(super) input_callbacks: Arc<AtomicU64>,
}

impl InputCallback {
    pub(super) fn process(&mut self, data: &[f32], info: &cpal::InputCallbackInfo) {
        let Self {
            scan_control,
            rt_channel_scan,
            channel_prod,
            channels,
            input_silence,
            input_silence_reset,
            resampler,
            input_timing,
            input_process_failed,
            input_resampling_failed,
            input_queue_diagnostics,
            mmcss_set_in,
            audio_prod,
            batch_timing,
            input_callbacks,
        } = self;
        crate::audio_engine::processing_watch::note_callback(input_callbacks);
        let scan_gain = scan_control.sync(&mut *rt_channel_scan);
        if rt_channel_scan.enabled() {
            for frame in data.chunks_exact(*channels) {
                for (channel, sample) in frame.iter().enumerate() {
                    rt_channel_scan.observe(channel, *sample * scan_gain);
                }
            }
            rt_channel_scan.finish_block(data.len() / *channels, &mut *channel_prod);
        }
        if input_silence.pause_input(|| {
            if *input_silence_reset != input_silence.ticket() {
                if let Some(resampler) = &mut *resampler {
                    resampler.discard_history();
                }
                if let Some(timing) = &mut *input_timing {
                    timing.invalidate();
                }
                *input_silence_reset = input_silence.ticket();
            }
        }) {
            return;
        }
        let timing_arrival = input_timing.as_ref().map_or(0, |timing| timing.now_ns());
        let received_frames = data.len() / *channels;
        if let Some(timing) = &mut *input_timing {
            timing.record_span(received_frames, timing_arrival);
        }
        if input_process_failed.load(Ordering::Acquire) {
            input_queue_diagnostics.record_input(received_frames, 0, 0, 0, 0);
            return;
        }
        if !mmcss_set_in.load(Ordering::Relaxed) {
            // SAFETY: GetCurrentThreadの疑似ハンドルをこのcallbackスレッド内だけで優先度設定に使用する。
            unsafe {
                use windows::Win32::System::Threading::{
                    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
                    THREAD_PRIORITY_TIME_CRITICAL,
                };
                let priority = if time_critical_audio_threads_enabled() {
                    THREAD_PRIORITY_TIME_CRITICAL
                } else {
                    THREAD_PRIORITY_HIGHEST
                };
                let _ = SetThreadPriority(GetCurrentThread(), priority);
            }
            mmcss_set_in.store(true, Ordering::Relaxed);
        }

        // Push interleaved samples as full frames to preserve channel alignment.
        // 分割された出力でも、このコールバックの転送上限は1回だけ決める。
        let mut remaining_frames = None;
        let mut accepted_prefix = crate::audio_engine::frame_timing::AcceptedPrefix::default();
        let mut generated_frames = 0;
        let mut offered_frames = 0;
        let mut accepted_frames = 0;
        let mut max_observed_slots = 0;
        let mut push_frames =
            |samples: &[f32],
             in_channels: usize,
             cohort: Option<crate::audio_engine::resampling::CohortEmission>| {
                let pushed = queue_diagnostics::push_mapped_frames(
                    &mut *audio_prod,
                    samples,
                    in_channels,
                    in_channels,
                    &mut remaining_frames,
                );
                if let Some(timing) = &mut *input_timing {
                    if *batch_timing {
                        timing.record_emission(cohort, pushed.accepted);
                    } else {
                        timing.record_direct_emission(pushed.offered, pushed.accepted);
                    }
                }
                accepted_prefix.record(pushed.offered, pushed.accepted);
                generated_frames += pushed.offered;
                offered_frames += pushed.offered;
                accepted_frames += pushed.accepted;
                max_observed_slots = max_observed_slots.max(pushed.observed_slots);
            };

        // If resampler is active, process
        if let Some(res) = &mut *resampler {
            // We assume input data matches configured channels
            // エラーは固定サイズのenum。RT側で文字列化・ログ出力しない。
            res.process_realtime_observed(
                data,
                |output, cohort| push_frames(output, *channels, cohort),
                input_process_failed,
                input_resampling_failed,
            );
        } else {
            // Passthrough
            push_frames(data, *channels, None);
        }
        input_queue_diagnostics.record_input(
            received_frames,
            generated_frames,
            offered_frames,
            accepted_frames,
            max_observed_slots,
        );
        if let Some(timing) = &mut *input_timing {
            if *batch_timing
                && (!accepted_prefix.valid() || input_process_failed.load(Ordering::Acquire))
            {
                // 音声は既存経路のまま。生成prefixを保証できない観測だけを失効する。
                timing.invalidate();
            }
            timing.record(
                if *batch_timing {
                    generated_frames
                } else {
                    received_frames
                },
                accepted_frames,
                timing_arrival,
                Some(info.timestamp().callback),
            );
        }
    }
}

impl Engine {
    pub(super) fn validate_input_start(&self, command: &Command) -> Result<()> {
        let Command::Start {
            input_source,
            host,
            input,
            input_id,
            output_id,
            ..
        } = command
        else {
            return Ok(());
        };
        let new_source = input_source
            .as_ref()
            .is_some_and(|s| s.source != crate::input_source::Config::default());
        let current_source = self
            .input_source
            .as_ref()
            .is_some_and(|s| s.source != crate::input_source::Config::default());
        anyhow::ensure!(
            input_source.is_some() || !current_source,
            "入力形式を確認できません。入力元を明示して開始してください"
        );
        anyhow::ensure!(
            self.output_stream.is_none() || !(new_source || current_source),
            "音声を停止してから入力元・用途を変更してください"
        );
        anyhow::ensure!(
            !new_source || !self.live_modes.armed,
            "本番保護を解除してから入力を変更してください"
        );
        anyhow::ensure!(
            !new_source || !self.live_output_config.split_processing,
            "この入力は処理分離に未対応です。単一の処理経路を使ってください"
        );
        if let Some(source) = input_source {
            source.validate().map_err(anyhow::Error::msg)?;
            if matches!(
                source.source,
                crate::input_source::Config::ProcessLoopback(_)
            ) {
                anyhow::ensure!(host.eq_ignore_ascii_case("wasapi") && input.is_none() && input_id.is_none() && output_id.is_some(),
                    "アプリ入力はWASAPIの単独入力で使用してください。機器入力を同時に指定できません");
            }
        }
        Ok(())
    }

    pub(super) fn bind_noise_input(&mut self, identity: Option<String>) {
        if self.noise_input_identity != identity {
            if let Some(previous) = self.noise_input_identity.take() {
                // アプリを多数切り替えても、マイク側の結果を退避から追い出さない。
                if self.input_learning.len() >= 64 {
                    if let Some(key) = self
                        .input_learning
                        .keys()
                        .find(|k| k.starts_with("process:"))
                        .cloned()
                    {
                        self.input_learning.remove(&key);
                    }
                }
                self.input_learning
                    .insert(previous, self.noise_learning.clone());
            }
            self.noise_learning = identity
                .as_ref()
                .and_then(|id| self.input_learning.remove(id))
                .unwrap_or_else(|| Arc::new(NoiseLearningShared::new()));
            self.noise_measurement = noise_learning::Controller::default();
        }
        self.noise_input_identity = identity;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_learning_does_not_share_or_overwrite_the_microphone_result() {
        let mut engine = Engine::new();
        engine.bind_noise_input(Some("wasapi:microphone".into()));
        let microphone = engine.noise_learning.clone();
        microphone.accepted_rms_ppm.store(123, Ordering::Release);
        engine.bind_noise_input(Some("process:player".into()));
        assert!(!Arc::ptr_eq(&engine.noise_learning, &microphone));
        assert_eq!(
            engine
                .noise_learning
                .accepted_rms_ppm
                .load(Ordering::Acquire),
            0
        );
        engine
            .noise_learning
            .accepted_rms_ppm
            .store(456, Ordering::Release);
        assert_eq!(microphone.accepted_rms_ppm.load(Ordering::Acquire), 123);
        engine.bind_noise_input(Some("wasapi:microphone".into()));
        assert!(Arc::ptr_eq(&engine.noise_learning, &microphone));
        assert_eq!(
            engine
                .noise_learning
                .accepted_rms_ppm
                .load(Ordering::Acquire),
            123
        );
    }

    #[test]
    fn stream_cleanup_retains_learning_ownership_across_restart_and_input_changes() {
        let mut engine = Engine::new();
        engine.bind_noise_input(Some("wasapi:microphone".into()));
        let microphone = engine.noise_learning.clone();
        microphone.profile_rms_ppm.store(1_411, Ordering::Release);
        microphone.applied_mix_ppm.store(550_000, Ordering::Release);
        microphone.has_applied_mix.store(true, Ordering::Release);
        microphone.profile_valid.store(true, Ordering::Release);

        // 同一入力の停止・再開でも、値を捨てたり確認済みとして復活させたりしない。
        engine.clear_audio_resources();
        engine.bind_noise_input(Some("wasapi:microphone".into()));
        assert!(Arc::ptr_eq(&engine.noise_learning, &microphone));
        assert!(!microphone.profile_valid.load(Ordering::Acquire));
        assert_eq!(microphone.profile_rms(), 0.001411);
        assert_eq!(microphone.applied_mix(), 0.55);

        engine.clear_audio_resources();
        engine.bind_noise_input(Some("process:player".into()));
        let process = engine.noise_learning.clone();
        assert!(!Arc::ptr_eq(&process, &microphone));
        process.profile_rms_ppm.store(8_485, Ordering::Release);
        process.applied_mix_ppm.store(680_000, Ordering::Release);
        process.has_applied_mix.store(true, Ordering::Release);
        process.profile_valid.store(true, Ordering::Release);

        // 通常停止と開始失敗の双方が通る回収を繰り返しても、退避値を失わない。
        engine.clear_audio_resources();
        engine.clear_audio_resources();
        engine.bind_noise_input(Some("wasapi:microphone".into()));
        assert!(Arc::ptr_eq(&engine.noise_learning, &microphone));
        assert_eq!(engine.noise_learning.profile_rms(), 0.001411);
        assert_eq!(engine.noise_learning.applied_mix(), 0.55);
        assert!(engine
            .noise_learning
            .has_applied_mix
            .load(Ordering::Acquire));
        assert!(!engine.noise_learning.profile_valid.load(Ordering::Acquire));

        engine.clear_audio_resources();
        engine.bind_noise_input(Some("process:player".into()));
        assert!(Arc::ptr_eq(&engine.noise_learning, &process));
        assert_eq!(engine.noise_learning.profile_rms(), 0.008485);
        assert_eq!(engine.noise_learning.applied_mix(), 0.68);
        assert!(!engine.noise_learning.profile_valid.load(Ordering::Acquire));
    }
}

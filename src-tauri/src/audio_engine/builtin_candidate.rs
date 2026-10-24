//! 1worker・1保留jobだけの非RT候補生成。録音原本を変更しない。
#[cfg(test)]
use super::allocate_voice_check_buffers;
use super::{
    buffers::{allocate_candidate_buffers, candidate_capacity},
    VoiceCheckBuffers,
};
use crate::audio_engine::{
    builtin::{Config, Preset},
    singing::{Coefficients, SingingChain},
    singing_proposal::{self, Message, Proposal, Seed},
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub recording_id: u64,
    pub base_revision: String,
    pub state: String,
    pub config: Config,
    pub sample_rate: u32,
    pub source_frames: usize,
    pub rendered_frames: usize,
    pub algorithmic_latency_frames: u32,
    pub filter_phase: String,
    pub sample_peak: Option<f32>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<Proposal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_error: Option<Message>,
}
struct Job {
    id: String,
    buffers: Arc<VoiceCheckBuffers>,
    config: Config,
    cancel: Arc<AtomicBool>,
    proposal: Option<Seed>,
}
struct Finished {
    id: String,
    result: Result<(Arc<VoiceCheckBuffers>, f32), String>,
    proposal: Option<Proposal>,
    proposal_error: Option<Message>,
}
pub(crate) struct Worker {
    jobs: SyncSender<Job>,
    results: Receiver<Finished>,
}
impl Worker {
    fn new() -> Self {
        Self::with_renderer(|job| render(&job.buffers, &job.config, &job.cancel))
    }
    fn with_renderer(
        renderer: impl FnMut(&Job) -> Result<(Arc<VoiceCheckBuffers>, f32), String> + Send + 'static,
    ) -> Self {
        Self::with_delivery_hook(renderer, || {})
    }
    fn with_delivery_hook(
        mut renderer: impl FnMut(&Job) -> Result<(Arc<VoiceCheckBuffers>, f32), String> + Send + 'static,
        mut delivered: impl FnMut() + Send + 'static,
    ) -> Self {
        let (jobs, rx) = mpsc::sync_channel::<Job>(1);
        let (tx, results) = mpsc::sync_channel(2);
        std::thread::spawn(move || {
            while let Ok(mut job) = rx.recv() {
                let mut proposal = None;
                let mut proposal_error = None;
                let analysis = job.proposal.as_ref().map(|seed| {
                    job.buffers
                        .recording()
                        .ok_or_else(|| {
                            Message::new("proposal.unsealed", "録音の確定を待ってください。")
                        })
                        .and_then(|source| {
                            singing_proposal::analyze(
                                &job.id,
                                source.raw,
                                source.sample_rate_hz,
                                &job.config,
                                seed,
                                &job.cancel,
                            )
                        })
                });
                let result = match analysis {
                    Some(Err(error)) => {
                        let text = error.fallback_ja.clone();
                        proposal_error = Some(error);
                        Err(text)
                    }
                    Some(Ok(value)) => {
                        job.config = value.config.clone();
                        proposal = Some(value);
                        renderer(&job)
                    }
                    None => renderer(&job),
                };
                if job.proposal.is_some() && proposal_error.is_none() {
                    if let Err(error) = &result {
                        proposal_error = Some(Message::new("proposal.renderFailed", error));
                    }
                }
                // 非RT workerだけで待機する。receiver破棄時は保留結果もここで解放する。
                if tx
                    .send(Finished {
                        id: job.id,
                        result,
                        proposal,
                        proposal_error,
                    })
                    .is_err()
                {
                    break;
                }
                delivered();
            }
        });
        Self { jobs, results }
    }
}
pub(crate) struct Candidate {
    worker: Option<Worker>,
    pub snapshot: Option<Snapshot>,
    ready: Option<Arc<VoiceCheckBuffers>>,
    cancel: Option<Arc<AtomicBool>>,
    next_id: u64,
    audio_revision: u64,
    proposal_epoch: Option<String>,
    source: Option<Arc<VoiceCheckBuffers>>,
}
impl Candidate {
    pub(crate) fn new() -> Self {
        Self {
            worker: None,
            snapshot: None,
            ready: None,
            cancel: None,
            next_id: 0,
            audio_revision: 0,
            proposal_epoch: None,
            source: None,
        }
    }
    pub(crate) fn cancel(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.store(true, Ordering::Release);
        }
        self.ready = None;
        self.source = None;
        if let Some(snapshot) = &mut self.snapshot {
            snapshot.state = "cancelled".into();
        }
    }
    pub(crate) fn validate(&mut self, recording: Option<u64>, revision: &str, audio_revision: u64) {
        if self.snapshot.as_ref().is_some_and(|snapshot| {
            Some(snapshot.recording_id) != recording
                || snapshot.base_revision != revision
                || self.audio_revision != audio_revision
        }) {
            self.cancel();
        }
        if let Some(worker) = &self.worker {
            while let Ok(finished) = worker.results.try_recv() {
                let Some(snapshot) = &mut self.snapshot else {
                    continue;
                };
                if snapshot.id != finished.id || snapshot.state != "preparing" {
                    continue;
                }
                match finished.result {
                    Ok((buffers, peak)) => {
                        snapshot.rendered_frames =
                            buffers.recording().expect("封印済み候補").frames;
                        self.ready = Some(buffers);
                        snapshot.state = "ready".into();
                        snapshot.sample_peak = Some(peak);
                        if let Some(proposal) = finished.proposal {
                            snapshot.config = proposal.config.clone();
                            snapshot.proposal = Some(proposal);
                        }
                    }
                    Err(error) => {
                        snapshot.state = "failed".into();
                        snapshot.error = Some(error);
                        snapshot.proposal_error = finished.proposal_error;
                    }
                }
            }
        }
    }
    pub(crate) fn prepare(
        &mut self,
        buffers: Arc<VoiceCheckBuffers>,
        recording_id: u64,
        revision: String,
        audio_revision: u64,
        config: Config,
    ) -> Result<(), String> {
        self.prepare_inner(
            buffers,
            (recording_id, revision),
            audio_revision,
            config,
            None,
        )
    }
    pub(crate) fn prepare_proposal(
        &mut self,
        buffers: Arc<VoiceCheckBuffers>,
        seed: Seed,
        audio_revision: u64,
        config: Config,
    ) -> Result<(), String> {
        self.prepare_inner(
            buffers,
            (seed.recording_id, seed.base_revision.clone()),
            audio_revision,
            config,
            Some(seed),
        )
    }
    fn prepare_inner(
        &mut self,
        buffers: Arc<VoiceCheckBuffers>,
        binding: (u64, String),
        audio_revision: u64,
        config: Config,
        proposal: Option<Seed>,
    ) -> Result<(), String> {
        let (recording_id, revision) = binding;
        let config = config.normalize()?;
        let recording = buffers
            .recording()
            .ok_or("録音の停止がまだ完了していません")?;
        // 提案は解析・希望選択後の最終設定でrender容量を確認する。手動候補は従来どおり。
        if proposal.is_none() {
            render_frames(recording.frames, recording.sample_rate_hz, &config)?;
        }
        let (sample_rate, source_frames) = (recording.sample_rate_hz, recording.frames);
        self.cancel();
        self.next_id = self.next_id.checked_add(1).ok_or("候補IDの上限です")?;
        let id = format!("candidate-{}-{recording_id}", self.next_id);
        let cancel = Arc::new(AtomicBool::new(false));
        let source = buffers.clone();
        let proposal_epoch = proposal.as_ref().map(|seed| seed.epoch.clone());
        let worker = self.worker.get_or_insert_with(Worker::new);
        worker
            .jobs
            .try_send(Job {
                id: id.clone(),
                buffers,
                config: config.clone(),
                cancel: cancel.clone(),
                proposal,
            })
            .map_err(|_| "前の候補を停止中です。少し待って再試行してください")?;
        self.snapshot = Some(Snapshot {
            id,
            recording_id,
            base_revision: revision,
            state: "preparing".into(),
            config,
            sample_rate,
            source_frames,
            rendered_frames: 0,
            algorithmic_latency_frames: 0,
            filter_phase: "minimumPhase".into(),
            sample_peak: None,
            error: None,
            proposal: None,
            proposal_error: None,
        });
        self.cancel = Some(cancel);
        self.audio_revision = audio_revision;
        self.proposal_epoch = proposal_epoch;
        self.source = Some(source);
        Ok(())
    }
    pub(crate) fn proposal_epoch(&self) -> Option<&str> {
        self.proposal_epoch.as_deref()
    }
    pub(crate) fn source_matches(&self, buffers: &Arc<VoiceCheckBuffers>) -> bool {
        self.source
            .as_ref()
            .is_some_and(|source| Arc::ptr_eq(source, buffers))
    }
    pub(crate) fn buffers(&self, id: &str) -> Result<Arc<VoiceCheckBuffers>, String> {
        if !self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.id == id && snapshot.state == "ready")
        {
            return Err("候補の準備が完了していないか期限が切れました".into());
        }
        self.ready
            .clone()
            .ok_or_else(|| "候補データがありません".into())
    }
}
impl Drop for Candidate {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub(crate) fn render_frames(source: usize, rate: u32, config: &Config) -> Result<usize, String> {
    let tail = config.reverb.unwrap_or_default().tail_frames(rate)?;
    let frames = source.checked_add(tail).ok_or("候補frame数が範囲外です")?;
    if source == 0 {
        return Err("録音が空です".into());
    }
    candidate_capacity(frames, rate)?;
    Ok(frames)
}

fn render(
    buffers: &VoiceCheckBuffers,
    config: &Config,
    cancel: &AtomicBool,
) -> Result<(Arc<VoiceCheckBuffers>, f32), String> {
    let recording = buffers.recording().ok_or("録音が未確定です")?;
    let rate = recording.sample_rate_hz;
    let total_frames = render_frames(recording.frames, rate, config)?;
    if cancel.load(Ordering::Acquire) {
        return Err("候補生成を中止しました".into());
    }
    let output = Arc::new(allocate_candidate_buffers(total_frames, rate)?);
    let mut writer = output
        .claim_writer()
        .ok_or("候補バッファを準備できません")?;
    let mut singing = SingingChain::new(
        Coefficients::prepare(config.singing.unwrap_or_default(), rate)?,
        true,
    );
    let mut legacy = crate::audio_engine::core::dsp::RtBuiltInVoiceChain::new(rate);
    let mut reverb =
        crate::audio_engine::reverb::Reverb::new(config.reverb.unwrap_or_default(), rate)?;
    let fade_frames = if total_frames > recording.frames {
        ((rate as usize * 20) / 1000)
            .min(total_frames - recording.frames)
            .max(1)
    } else {
        0
    };
    let mut peak = 0.0f32;
    for index in 0..total_frames {
        let raw = if index < recording.frames {
            [recording.raw[index * 2], recording.raw[index * 2 + 1]]
        } else {
            [0.0; 2]
        };
        if index % 256 == 0 && cancel.load(Ordering::Acquire) {
            return Err("候補生成を中止しました".into());
        }
        if !raw.iter().all(|sample| sample.is_finite()) {
            return Err("録音に不正な値があるため候補を生成できません".into());
        }
        let processed = if !config.active {
            [raw[0], raw[1]]
        } else if config.preset == Preset::Singing {
            singing.process([raw[0], raw[1]], [raw[0], raw[1]])
        } else {
            let (l, r) = legacy.process_sample(raw[0], raw[1], config.preset, config.amount);
            [l, r]
        };
        let mut processed = reverb.process(processed, false);
        if fade_frames > 0 && index >= total_frames - fade_frames {
            let gain = (total_frames - 1 - index) as f32 / fade_frames as f32;
            processed = processed.map(|sample| sample * gain);
        }
        writer.write_raw(index as u64, raw[0], raw[1]);
        writer.write_processed(index as u64, processed[0], processed[1]);
        peak = peak.max(processed[0].abs()).max(processed[1].abs());
    }
    if cancel.load(Ordering::Acquire) {
        return Err("候補生成を中止しました".into());
    }
    writer.seal(total_frames as u64);
    if output
        .recording()
        .is_none_or(|recording| recording.frames != total_frames)
    {
        return Err("候補の長さを確定できません".into());
    }
    Ok((output, peak))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recording() -> Arc<VoiceCheckBuffers> {
        let buffers = Arc::new(allocate_voice_check_buffers(500, 48_000));
        let mut writer = buffers.claim_writer().unwrap();
        for i in 0..1024 {
            let sample = (i as f32 * 0.1).sin() * 0.2;
            writer.write_raw(i, sample, -sample);
            writer.write_processed(i, 0.7, 0.7);
        }
        writer.seal(1024);
        buffers
    }
    #[test]
    fn reverb_only_candidate_extends_exact_thirty_second_raw_with_tail_and_rejects_budget_overflow()
    {
        let source_frames = 30 * 8_000;
        let source = Arc::new(allocate_voice_check_buffers(30_000, 8_000));
        let mut writer = source.claim_writer().unwrap();
        writer.write_raw((source_frames - 1) as u64, 0.5, -0.5);
        writer.seal(source_frames as u64);
        let params = crate::audio_engine::reverb::ReverbParams {
            enabled: true,
            decay_seconds: 0.3,
            ..Default::default()
        };
        let config = Config {
            reverb: Some(params),
            ..Default::default()
        };
        assert!(!config.active); // 残響だけONでも旧Broadcastは動かない。
        let total_frames = render_frames(source_frames, 8_000, &config).unwrap();
        assert!(total_frames > source.capacity_frames);
        let (output, _) = render(&source, &config, &AtomicBool::new(false)).unwrap();
        let rendered = output.recording().unwrap();
        assert_eq!(output.capacity_frames, total_frames);
        assert_eq!(rendered.frames, total_frames);
        assert_eq!(rendered.sample_rate_hz, 8_000);
        assert_eq!(
            &rendered.raw[..source_frames * 2],
            source.recording().unwrap().raw
        );
        assert!(rendered.raw[source_frames * 2..]
            .iter()
            .all(|sample| *sample == 0.0));
        assert_eq!(rendered.processed[(source_frames - 1) * 2], 0.5);
        assert!(rendered.processed[source_frames * 2..]
            .iter()
            .any(|sample| sample.abs() > 0.0));
        assert_eq!(&rendered.processed[total_frames * 2 - 2..], &[0.0; 2]);
        assert_eq!(source.recording().unwrap().frames, source_frames);
        assert!(render(&source, &config, &AtomicBool::new(true)).is_err());
        let max_frames = 64 * 1024 * 1024 / 16;
        assert!(candidate_capacity(max_frames, 192_000).is_ok());
        assert!(candidate_capacity(max_frames + 1, 192_000).is_err());
        assert!(render_frames(192_000 * 30, 192_000, &config).is_err());
        assert!(render_frames(usize::MAX, 192_000, &config).is_err());
        assert!(render_frames(8_000, 384_000, &config).is_err());
    }

    #[test]
    fn full_results_queue_delivers_latest_completion_after_two_cancelled_jobs() {
        use std::time::Duration;
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (delivered_tx, delivered_rx) = mpsc::channel();
        let worker = Worker::with_delivery_hook(
            move |job| {
                entered_tx.send(job.id.clone()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                render(&job.buffers, &job.config, &job.cancel)
            },
            move || delivered_tx.send(()).unwrap(),
        );
        let make_job = |id: &str, cancel: Arc<AtomicBool>| Job {
            id: id.into(),
            buffers: recording(),
            config: Config::default(),
            cancel,
            proposal: None,
        };
        let first_cancel = Arc::new(AtomicBool::new(false));
        let second_cancel = Arc::new(AtomicBool::new(false));
        worker
            .jobs
            .try_send(make_job("1", first_cancel.clone()))
            .unwrap();
        assert_eq!(
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "1"
        );
        worker
            .jobs
            .try_send(make_job("2", second_cancel.clone()))
            .unwrap();
        // prepare3冒頭のdrain時点にはまだ結果がない。
        assert!(worker.results.try_recv().is_err());
        first_cancel.store(true, Ordering::Release);
        release_tx.send(()).unwrap();
        assert_eq!(
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "2"
        );
        worker
            .jobs
            .try_send(make_job("3", Arc::new(AtomicBool::new(false))))
            .unwrap();
        second_cancel.store(true, Ordering::Release);
        release_tx.send(()).unwrap();
        // job3開始時点で取消済み1/2の結果が容量2を埋めている。
        assert_eq!(
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "3"
        );
        delivered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        delivered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        release_tx.send(()).unwrap();
        // 3件目は満杯キューへ配送中。try_sendで破棄すればここで完了してしまう。
        assert!(matches!(
            delivered_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        for id in ["1", "2", "3"] {
            let finished = worker.results.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(finished.id, id);
            assert_eq!(finished.result.is_ok(), id == "3");
        }
        delivered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn offline_render_uses_only_sealed_raw_preserves_original_and_cancellation() {
        let buffers = recording();
        let before = buffers.recording().unwrap().raw.to_vec();
        let config = Config {
            active: true,
            preset: Preset::Singing,
            amount: 0.7,
            singing: None,
            reverb: None,
        }
        .normalize()
        .unwrap();
        let (rendered, peak) = render(&buffers, &config, &AtomicBool::new(false)).unwrap();
        assert!(peak.is_finite() && peak > 0.0);
        let output = rendered.recording().unwrap();
        assert_eq!(output.raw, before);
        assert_eq!(output.frames, 1024);
        assert_eq!(output.sample_rate_hz, 48_000);
        assert_ne!(output.processed, buffers.recording().unwrap().processed);
        assert_eq!(buffers.recording().unwrap().raw, before);
        assert!(render(&buffers, &config, &AtomicBool::new(true)).is_err());
        let unfinished = Arc::new(allocate_voice_check_buffers(500, 48_000));
        assert!(render(&unfinished, &config, &AtomicBool::new(false)).is_err());
    }
    #[test]
    fn bounded_worker_results_are_tied_to_recording_revision_and_cancel() {
        let mut candidate = Candidate::new();
        let config = Config {
            reverb: Some(crate::audio_engine::reverb::ReverbParams {
                enabled: true,
                decay_seconds: 0.3,
                ..Default::default()
            }),
            ..Default::default()
        };
        candidate
            .prepare(recording(), 1, "7".into(), 9, config)
            .unwrap();
        for _ in 0..100 {
            candidate.validate(Some(1), "7", 9);
            if candidate.snapshot.as_ref().unwrap().state != "preparing" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(candidate.snapshot.as_ref().unwrap().state, "ready");
        let id = candidate.snapshot.as_ref().unwrap().id.clone();
        let rendered = candidate.buffers(&id).unwrap();
        let snapshot = candidate.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.source_frames, 1024);
        assert!(snapshot.rendered_frames > snapshot.source_frames);
        assert_eq!(
            rendered.recording().unwrap().frames,
            snapshot.rendered_frames
        );
        candidate.validate(Some(1), "8", 9);
        assert!(candidate.buffers(&id).is_err());
        candidate
            .prepare(recording(), 2, "8".into(), 10, Config::default())
            .unwrap();
        let id = candidate.snapshot.as_ref().unwrap().id.clone();
        candidate.cancel();
        for _ in 0..5 {
            candidate.validate(Some(2), "8", 10);
            std::thread::yield_now();
        }
        assert_eq!(candidate.snapshot.as_ref().unwrap().state, "cancelled");
        assert!(candidate.buffers(&id).is_err());
    }
    #[test]
    fn proposal_late_success_after_cancel_cannot_publish_or_replace_latest_job() {
        use std::time::Duration;
        let source = Arc::new(allocate_voice_check_buffers(4000, 8000));
        let mut writer = source.claim_writer().unwrap();
        for frame in 0..32000 {
            let value = 0.2 * (std::f32::consts::TAU * 220.0 * frame as f32 / 8000.0).sin();
            writer.write_raw(frame, value, -value);
            writer.write_processed(frame, 0.0, 0.0);
        }
        writer.seal(32000);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let mut candidate = Candidate::new();
        candidate.worker = Some(Worker::with_delivery_hook(
            move |job| {
                entered_tx.send(job.id.clone()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                // 取消を見落として成功したworkerまで、制御側が古い結果として破棄する。
                render(&job.buffers, &job.config, &AtomicBool::new(false))
            },
            move || done_tx.send(()).unwrap(),
        ));
        let seed = |recording_id| Seed {
            preferences: None,
            preferences_revision: None,
            epoch: "engine".into(),
            recording_id,
            base_revision: "1".into(),
        };
        candidate
            .prepare_proposal(source.clone(), seed(1), 7, Config::default())
            .unwrap();
        let old = entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        candidate.cancel();
        candidate
            .prepare_proposal(source, seed(2), 7, Config::default())
            .unwrap();
        release_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let latest = entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_ne!(old, latest);
        candidate.validate(Some(2), "1", 7);
        let snapshot = candidate.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.id, latest);
        assert_eq!(snapshot.state, "preparing");
        assert!(snapshot.proposal.is_none());
        release_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        candidate.validate(Some(2), "1", 7);
        let snapshot = candidate.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.state, "ready");
        assert_eq!(snapshot.proposal.as_ref().unwrap().recording_id, 2);
    }
}

#[cfg(test)]
mod preference_worker_tests {
    use super::*;
    #[test]
    fn proposal_preferences_worker_renders_only_selected_config_and_preserves_sealed_raw_and_tail()
    {
        let source = Arc::new(allocate_voice_check_buffers(4000, 8000));
        let mut writer = source.claim_writer().unwrap();
        for i in 0..24000 {
            let x = (i as f32 * 0.31).sin() * 0.1;
            writer.write_raw(i, x, -x);
            writer.write_processed(i, 0.8, 0.8);
        }
        writer.seal(24000);
        let mut candidate = Candidate::new();
        let preferences = singing_proposal::Preferences {
            reverb: singing_proposal::ReverbWish::Short,
            ..Default::default()
        };
        candidate
            .prepare_proposal(
                source.clone(),
                Seed {
                    epoch: "builtin".into(),
                    recording_id: 1,
                    base_revision: "3".into(),
                    preferences: Some(preferences.clone()),
                    preferences_revision: Some(5),
                },
                7,
                Config::default(),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            candidate.validate(Some(1), "3", 7);
            if candidate.snapshot.as_ref().unwrap().state != "preparing" {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        let s = candidate.snapshot.as_ref().unwrap();
        assert_eq!(s.state, "ready", "{:?}", s.error);
        let p = s.proposal.as_ref().unwrap();
        assert_eq!(p.rule_version, singing_proposal::RULE_VERSION_V2);
        assert_eq!(p.preferences, Some(preferences));
        assert_eq!(p.preferences_revision, Some(5));
        assert_eq!(s.config, p.config);
        let ready = candidate.buffers(&s.id).unwrap();
        let rendered = ready.recording().unwrap();
        let raw = source.recording().unwrap();
        assert_eq!(&rendered.raw[..raw.raw.len()], raw.raw);
        assert!(rendered.raw[raw.raw.len()..].iter().all(|v| *v == 0.0));
        assert_eq!(raw.processed[0], 0.8);
        assert_eq!(
            rendered.frames,
            render_frames(raw.frames, 8000, &p.config).unwrap()
        );
        assert!(rendered.frames > raw.frames);
        assert!(
            f64::from(s.sample_peak.unwrap())
                <= p.evaluation.as_ref().unwrap().final_peak_before_tail_fade
        );
        assert_eq!(rendered.processed.last(), Some(&0.0));
    }
}

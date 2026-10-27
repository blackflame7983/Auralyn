//! 主出力と独立した、封印済み録音のWASAPI試聴。録音・主出力の共有stateは書かない。
use super::VoiceCheckBuffers;
use crate::audio_engine::{auto_gain::PreviewDevice, auto_gain_preview};
use anyhow::{anyhow, ensure, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Raw,
    Processed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub source: Source,
    pub loop_playback: bool,
    pub level_match: bool,
}
impl Options {
    fn bits(&self) -> u32 {
        u32::from(self.source == Source::Processed)
            | (u32::from(self.loop_playback) << 1)
            | (u32::from(self.level_match) << 2)
    }
}
impl Default for Options {
    fn default() -> Self {
        Self {
            source: Source::Processed,
            loop_playback: true,
            level_match: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Open,
    Status,
    Devices,
    Start {
        recording_id: u64,
        device_id: String,
        #[serde(default)]
        candidate_id: Option<String>,
        #[serde(flatten)]
        options: Options,
    },
    Update {
        #[serde(flatten)]
        options: Options,
    },
    PrepareNoise {
        recording_id: u64,
        expected_basis: String,
        variant: crate::audio_engine::noise_candidate::Variant,
    },
    ApplyNoise {
        candidate_id: String,
        expected_basis: String,
    },
    UndoNoise {
        token: String,
    },
    PrepareCandidate {
        recording_id: u64,
        expected_revision: String,
        config: crate::audio_engine::builtin::Config,
    },
    PrepareProposal {
        #[serde(default)]
        rule_version: Option<String>,
        #[serde(default)]
        preferences: Option<crate::audio_engine::singing_proposal::Preferences>,
        #[serde(default)]
        preferences_revision: Option<u64>,
        recording_id: u64,
        builtin_epoch: String,
        expected_revision: String,
    },
    CandidateStatus {
        candidate_id: String,
    },
    CancelCandidate {
        candidate_id: String,
    },
    Stop,
    Close,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub client_id: String,
    pub session_id: u64,
    pub operation_id: u64,
    pub epoch: Option<String>,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCondition {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub muted: bool,
    pub gain: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub recording_id: u64,
    pub revision: u64,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub host: String,
    pub input_channels: [usize; 2],
    pub input_gain: f32,
    pub noise_enabled: bool,
    pub noise_mode: String,
    pub noise_strength: f32,
    pub voice_guard: bool,
    pub built_in_enabled: bool,
    pub built_in_preset: String,
    pub built_in_amount: f32,
    #[serde(default)]
    pub singing: Option<crate::audio_engine::singing::SingingParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverb: Option<crate::audio_engine::reverb::ReverbParams>,
    pub global_bypass: bool,
    pub plugins: Vec<PluginCondition>,
    pub changed_during_recording: bool,
    pub raw_tap: String,
    pub processed_tap: String,
    pub vst_parameters_verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub noise_basis: String,
    #[serde(default)]
    pub noise_undo_token: Option<String>,
    #[serde(default)]
    pub noise_settings: Option<crate::audio_engine::noise_candidate::Config>,
    #[serde(default)]
    pub noise_pending: bool,
    pub candidate: Option<crate::audio_engine::voice_check::candidate::Snapshot>,
    pub epoch: String,
    pub session_id: u64,
    pub operation_id: u64,
    pub recording_id: Option<u64>,
    pub state: String,
    pub position_ms: u32,
    pub duration_ms: u32,
    pub source: Source,
    pub loop_playback: bool,
    pub level_match: bool,
    pub level_match_available: bool,
    pub metadata: Option<Metadata>,
    pub recording_stale: bool,
    pub devices: Vec<PreviewDevice>,
    pub error: Option<String>,
    pub owner: Option<String>,
    pub conflict: Option<String>,
    pub level_match_attenuation_db: [f32; 2],
    pub safety_attenuation_db: f32,
}

#[derive(Clone)]
pub(in crate::audio_engine) struct Context {
    pub noise: crate::audio_engine::noise_candidate::Config,
    pub noise_basis: String,
    pub noise_undo_token: Option<String>,
    pub noise_pending: bool,
    pub builtin_revision: String,
    pub builtin_epoch: String,
    pub builtin_config: crate::audio_engine::builtin::Config,
    pub builtin_pending: bool,
    pub buffers: Option<Arc<VoiceCheckBuffers>>,
    pub metadata: Option<Metadata>,
    pub main_device: Option<String>,
    pub main_running: bool,
    pub busy: bool,
    pub auto_gain_active: bool,
    pub current_revision: u64,
}

fn proposal_source(context: &Context) -> Result<&Arc<VoiceCheckBuffers>> {
    ensure!(
        !context.busy && !context.builtin_pending,
        "録音・通常再生・内蔵設定の反映が完了してから提案を作成してください"
    );
    let metadata = context
        .metadata
        .as_ref()
        .ok_or_else(|| anyhow!("先に録音してください"))?;
    ensure!(
        !metadata.changed_during_recording && metadata.revision == context.current_revision,
        "録音時の条件が変わりました。録音し直してください"
    );
    ensure!(
        metadata.raw_tap == "post_input_gain_and_channel_selection_pre_fx",
        "録音の解析位置を確認できません"
    );
    let buffers = context
        .buffers
        .as_ref()
        .ok_or_else(|| anyhow!("録音データがありません"))?;
    let recording = buffers
        .recording()
        .ok_or_else(|| anyhow!("録音の停止がまだ完了していません"))?;
    ensure!(
        recording.frames > 0 && recording.sample_rate_hz == metadata.sample_rate,
        "録音の条件を確認できません"
    );
    Ok(buffers)
}

struct Cursor {
    session: u64,
    operation: u64,
    closed: bool,
    preferences_revision: u64,
}
struct Sessions {
    epoch: String,
    clients: HashMap<String, Cursor>,
    current: Option<(String, u64)>,
}
impl Sessions {
    fn new() -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            epoch: format!("{}-{stamp}", std::process::id()),
            clients: HashMap::new(),
            current: None,
        }
    }
    // UIランタイムごとのclientIdを使い、無制限の終了済みsession蓄積を避ける。
    fn open(&mut self, request: &Request) -> Result<()> {
        validate_request(request)?;
        if let Some(cursor) = self.clients.get(&request.client_id) {
            ensure!(
                request.session_id > cursor.session
                    || (request.session_id == cursor.session && !cursor.closed),
                "試聴セッションは終了しています"
            );
            if request.session_id == cursor.session {
                ensure!(
                    self.current.as_ref() == Some(&(request.client_id.clone(), request.session_id)),
                    "別の試聴セッションが開いています"
                );
                return Ok(());
            }
        } else {
            ensure!(
                self.clients.len() < 16,
                "試聴画面の数が上限です。アプリを開き直してください"
            );
        }
        self.clients.insert(
            request.client_id.clone(),
            Cursor {
                session: request.session_id,
                operation: request.operation_id,
                closed: false,
                preferences_revision: 0,
            },
        );
        self.current = Some((request.client_id.clone(), request.session_id));
        Ok(())
    }
    fn check(&mut self, request: &Request, mutate: bool) -> Result<()> {
        ensure!(
            request.epoch.as_deref() == Some(self.epoch.as_str()),
            "音声エンジンが変わりました。試聴画面を開き直してください"
        );
        ensure!(
            self.current.as_ref() == Some(&(request.client_id.clone(), request.session_id)),
            "試聴セッションは失効しています"
        );
        let cursor = self
            .clients
            .get_mut(&request.client_id)
            .ok_or_else(|| anyhow!("試聴画面を開き直してください"))?;
        ensure!(
            !cursor.closed && cursor.session == request.session_id,
            "試聴セッションは終了しています"
        );
        if mutate {
            ensure!(request.operation_id > cursor.operation, "古い試聴操作です");
            if let Action::PrepareProposal {
                preferences_revision: Some(revision),
                ..
            } = &request.action
            {
                ensure!(
                    *revision >= cursor.preferences_revision,
                    "古い希望の操作です"
                );
                cursor.preferences_revision = *revision;
            }
            cursor.operation = request.operation_id;
        }
        Ok(())
    }
    fn close(&mut self, request: &Request) -> Result<bool> {
        validate_request(request)?;
        // open応答前のClose(None)だけを特例にし、旧engineのCloseは新sessionへ触れない。
        ensure!(
            request
                .epoch
                .as_deref()
                .is_none_or(|epoch| epoch == self.epoch),
            "音声エンジンが変わりました。古い試聴画面の終了要求は適用しません"
        );
        if let Some(cursor) = self.clients.get_mut(&request.client_id) {
            if request.session_id < cursor.session {
                return Ok(false);
            }
            if request.session_id == cursor.session && request.operation_id < cursor.operation {
                return Ok(false);
            }
            *cursor = Cursor {
                session: request.session_id,
                operation: request.operation_id,
                closed: true,
                preferences_revision: 0,
            };
        } else {
            ensure!(self.clients.len() < 16, "試聴画面の数が上限です");
            self.clients.insert(
                request.client_id.clone(),
                Cursor {
                    session: request.session_id,
                    operation: request.operation_id,
                    closed: true,
                    preferences_revision: 0,
                },
            );
        }
        let current = self.current.as_ref().is_some_and(|(client, session)| {
            client == &request.client_id && *session <= request.session_id
        });
        if current {
            self.current = None;
        }
        Ok(current)
    }
    fn invalidate(&mut self) {
        if let Some((client, _)) = self.current.take() {
            if let Some(cursor) = self.clients.get_mut(&client) {
                cursor.closed = true;
            }
        }
    }
}

fn validate_request(request: &Request) -> Result<()> {
    const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;
    ensure!(
        !request.client_id.is_empty()
            && request.client_id.len() <= 128
            && request
                .client_id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"-_:".contains(&ch))
            && (1..=MAX_SAFE_ID).contains(&request.session_id)
            && request.operation_id <= MAX_SAFE_ID
            && (matches!(request.action, Action::Status | Action::Devices)
                || request.operation_id > 0)
            && request
                .epoch
                .as_ref()
                .is_none_or(|epoch| epoch.len() <= 128),
        "試聴要求の識別情報が不正です"
    );
    if let Action::Start { device_id, .. } = &request.action {
        ensure!(
            !device_id.is_empty()
                && device_id.len() <= 4096
                && !device_id.chars().any(char::is_control),
            "試聴先の識別情報が不正です"
        );
    }
    match &request.action {
        Action::Start {
            recording_id,
            candidate_id,
            ..
        } => {
            ensure!((1..=MAX_SAFE_ID).contains(recording_id), "録音IDが不正です");
            ensure!(
                candidate_id
                    .as_ref()
                    .is_none_or(|id| !id.is_empty() && id.len() <= 128),
                "候補IDが不正です"
            );
        }
        Action::PrepareNoise {
            recording_id,
            expected_basis,
            ..
        } => {
            ensure!(
                (1..=MAX_SAFE_ID).contains(recording_id)
                    && !expected_basis.is_empty()
                    && expected_basis.len() <= 4096,
                "NR比較の識別情報が不正です"
            );
        }
        Action::ApplyNoise {
            candidate_id,
            expected_basis,
        } => {
            ensure!(
                !candidate_id.is_empty()
                    && candidate_id.len() <= 128
                    && !expected_basis.is_empty()
                    && expected_basis.len() <= 4096,
                "NR採用の識別情報が不正です"
            );
        }
        Action::UndoNoise { token } => {
            ensure!(
                !token.is_empty() && token.len() <= 128,
                "NR復元の識別情報が不正です"
            );
        }
        Action::PrepareCandidate {
            recording_id,
            expected_revision,
            config,
        } => {
            ensure!((1..=MAX_SAFE_ID).contains(recording_id), "録音IDが不正です");
            ensure!(
                !expected_revision.is_empty()
                    && expected_revision.len() <= 32
                    && expected_revision.bytes().all(|ch| ch.is_ascii_digit()),
                "内蔵処理revisionが不正です"
            );
            config.clone().normalize().map_err(|error| anyhow!(error))?;
        }
        Action::CandidateStatus { candidate_id } | Action::CancelCandidate { candidate_id } => {
            ensure!(
                !candidate_id.is_empty() && candidate_id.len() <= 128,
                "候補IDが不正です"
            );
        }
        Action::PrepareProposal {
            rule_version,
            preferences,
            preferences_revision,
            recording_id,
            builtin_epoch,
            expected_revision,
        } => {
            ensure!(
                (preferences.is_none() && preferences_revision.is_none() && rule_version.is_none())
                    || (rule_version.as_deref()
                        == Some(crate::audio_engine::singing_proposal::RULE_VERSION_V2)
                        && preferences.is_some()
                        && preferences_revision.is_some_and(|v| (1..=MAX_SAFE_ID).contains(&v))),
                "希望の世代が不正です"
            );
            ensure!((1..=MAX_SAFE_ID).contains(recording_id), "録音IDが不正です");
            ensure!(
                !builtin_epoch.is_empty()
                    && builtin_epoch.len() <= 128
                    && !builtin_epoch.chars().any(char::is_control),
                "内蔵処理epochが不正です"
            );
            ensure!(
                !expected_revision.is_empty()
                    && expected_revision.len() <= 32
                    && expected_revision.bytes().all(|v| v.is_ascii_digit()),
                "内蔵処理revisionが不正です"
            );
        }
        _ => {}
    }
    Ok(())
}

struct Controls {
    options: AtomicU32,
    active: AtomicBool,
    stopping: AtomicBool,
    failed: AtomicBool,
    position: AtomicU64,
    gains: [AtomicU32; 2],
}
impl Controls {
    fn new(options: &Options) -> Self {
        Self {
            options: AtomicU32::new(options.bits()),
            active: AtomicBool::new(true),
            stopping: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            position: AtomicU64::new(0),
            gains: [
                AtomicU32::new(1.0f32.to_bits()),
                AtomicU32::new(1.0f32.to_bits()),
            ],
        }
    }
}

fn comparison_gains(raw: &[f32], processed: &[f32]) -> Result<([f32; 2], f32, bool)> {
    ensure!(
        raw.len() == processed.len() && !raw.is_empty(),
        "録音が空か、加工前後の長さが一致していません"
    );
    let mut energy = [0.0_f64; 2];
    let mut peak = 0.0_f32;
    for (index, samples) in [raw, processed].into_iter().enumerate() {
        for &sample in samples {
            ensure!(
                sample.is_finite(),
                "録音に扱えない値があります。録り直してください"
            );
            energy[index] += (sample as f64).powi(2);
            peak = peak.max(sample.abs());
        }
    }
    let rms = energy.map(|sum| (sum / raw.len() as f64).sqrt());
    let available = rms.iter().all(|&rms| rms >= 1.0e-6);
    let gain = if available {
        let target = rms[0].min(rms[1]);
        rms.map(|rms| (target / rms) as f32)
    } else {
        [1.0; 2]
    };
    // 試聴だけに共通の安全減衰を適用し、原音の過大ピークをそのまま再生しない。
    Ok((gain, (0.9 / peak.max(0.9)).min(1.0), available))
}

struct Renderer {
    position: usize,
    blend: f32,
    gains: [f32; 2],
    stop_gain: f32,
    ramp: usize,
}
impl Renderer {
    fn new(options: &Options, rate: u32, frames: usize) -> Self {
        Self {
            position: 0,
            blend: f32::from(options.source == Source::Processed),
            gains: [1.0; 2],
            stop_gain: 1.0,
            ramp: (rate as usize / 200).max(1).min((frames / 2).max(1)),
        }
    }
    fn render(
        &mut self,
        output: &mut [f32],
        channels: usize,
        sources: [&[f32]; 2],
        matching: [f32; 2],
        safety: f32,
        controls: &Controls,
    ) {
        let [raw, processed] = sources;
        output.fill(0.0);
        if channels < 2 || !controls.active.load(Ordering::Acquire) {
            return;
        }
        let frames = raw.len() / 2;
        let bits = controls.options.load(Ordering::Acquire);
        let desired_blend = (bits & 1) as f32;
        let targets = if bits & 4 != 0 { matching } else { [1.0; 2] };
        let step = 1.0 / self.ramp as f32;
        for frame in output.chunks_exact_mut(channels) {
            if self.position >= frames {
                if bits & 2 != 0 && frames > 0 {
                    self.position = 0;
                } else {
                    controls.active.store(false, Ordering::Release);
                    break;
                }
            }
            if controls.stopping.load(Ordering::Acquire) {
                self.stop_gain = (self.stop_gain - step).max(0.0);
            }
            if self.stop_gain == 0.0 {
                controls.active.store(false, Ordering::Release);
                break;
            }
            self.blend += (desired_blend - self.blend).clamp(-step, step);
            for (gain, target) in self.gains.iter_mut().zip(targets) {
                *gain += (target - *gain).clamp(-step, step);
            }
            let envelope = (self.position as f32 / self.ramp as f32)
                .min(1.0)
                .min((frames - self.position) as f32 / self.ramp as f32)
                * self.stop_gain
                * safety;
            for (ch, sample) in frame.iter_mut().take(2).enumerate() {
                let index = self.position * 2 + ch;
                *sample = (raw[index] * self.gains[0] * (1.0 - self.blend)
                    + processed[index] * self.gains[1] * self.blend)
                    * envelope;
            }
            self.position += 1;
        }
        controls
            .position
            .store(self.position as u64, Ordering::Release);
        for (shared, gain) in controls.gains.iter().zip(self.gains) {
            shared.store(gain.to_bits(), Ordering::Release);
        }
    }
}

struct Preview {
    // streamを先に破棄し、callbackのArcを回収するまで録音・制御の最後の参照を保持する。
    _stream: Option<cpal::Stream>,
    _buffers: Arc<VoiceCheckBuffers>,
    controls: Arc<Controls>,
    stop_started: Option<Instant>,
}
impl Preview {
    fn start(
        device: &str,
        buffers: Arc<VoiceCheckBuffers>,
        options: &Options,
        main_device: Option<&str>,
    ) -> Result<(Self, bool)> {
        let recording = buffers
            .recording()
            .ok_or_else(|| anyhow!("録音の停止がまだ完了していません"))?;
        let (matching, safety, available) = comparison_gains(recording.raw, recording.processed)?;
        ensure!(
            !options.level_match || available,
            "無音または音が少ないため試聴音量を合わせられません"
        );
        let (device, config) =
            auto_gain_preview::output_device(device, recording.sample_rate_hz, main_device)?;
        let mut renderer = Renderer::new(options, recording.sample_rate_hz, recording.frames);
        let controls = Arc::new(Controls::new(options));
        let callback_controls = controls.clone();
        let error_controls = controls.clone();
        let callback_buffers = buffers.clone();
        let channels = config.channels as usize;
        let stream = auto_gain_preview::preview_stage(
            device.build_output_stream(
                &config,
                move |output: &mut [f32], _| {
                    if let Some(recording) = callback_buffers.recording() {
                        renderer.render(
                            output,
                            channels,
                            [recording.raw, recording.processed],
                            matching,
                            safety,
                            &callback_controls,
                        );
                    } else {
                        output.fill(0.0);
                    }
                },
                move |_| {
                    error_controls.failed.store(true, Ordering::Release);
                    error_controls.active.store(false, Ordering::Release);
                },
                None,
            ),
            "試聴先の出力ストリームを作成できません",
        )?;
        auto_gain_preview::preview_stage(stream.play(), "試聴先の再生を開始できません")?;
        Ok((
            Self {
                _stream: Some(stream),
                _buffers: buffers,
                controls,
                stop_started: None,
            },
            available,
        ))
    }
}
impl Drop for Preview {
    fn drop(&mut self) {
        self.controls.active.store(false, Ordering::Release);
    }
}

pub(in crate::audio_engine) struct Controller {
    candidate: crate::audio_engine::voice_check::candidate::Candidate,
    active_candidate: Option<String>,
    sessions: Sessions,
    preview: Option<Preview>,
    options: Options,
    available: bool,
    state: String,
    error: Option<String>,
    position: u64,
    matching: [f32; 2],
    safety: f32,
    prepared_recording: Option<u64>,
}
impl Controller {
    pub(in crate::audio_engine) fn new() -> Self {
        Self {
            candidate: crate::audio_engine::voice_check::candidate::Candidate::new(),
            active_candidate: None,
            sessions: Sessions::new(),
            preview: None,
            options: Options::default(),
            available: false,
            state: "idle".into(),
            error: None,
            position: 0,
            matching: [1.0; 2],
            safety: 1.0,
            prepared_recording: None,
        }
    }
    pub(in crate::audio_engine) fn active(&self) -> bool {
        self.preview.is_some()
    }
    pub(in crate::audio_engine) fn interrupt(&mut self, invalidate: bool) {
        self.preview = None;
        self.active_candidate = None;
        self.candidate.cancel();
        self.state = "stopped".into();
        self.position = 0;
        if invalidate {
            self.sessions.invalidate();
            self.state = "closed".into();
        }
    }
    pub(in crate::audio_engine) fn invalidate_candidate(&mut self) {
        if self.active_candidate.take().is_some() {
            self.preview = None;
            self.state = "stopped".into();
            self.position = 0;
        }
        self.candidate.cancel();
    }
    /// Coreが同じdispatch内でこのwitnessを照合し、続けてBuiltin CASを行う。
    pub(in crate::audio_engine) fn proposal_config(
        &mut self,
        id: &str,
        recording_id: u64,
        epoch: &str,
        expected_revision: &str,
        context: &Context,
    ) -> Result<crate::audio_engine::builtin::Config> {
        ensure!(!id.is_empty() && id.len() <= 128, "提案IDが不正です");
        let valid = proposal_source(context).is_ok()
            && context.builtin_epoch == epoch
            && context.builtin_revision == expected_revision
            && context
                .metadata
                .as_ref()
                .is_some_and(|m| m.recording_id == recording_id)
            && context
                .buffers
                .as_ref()
                .is_some_and(|buffers| self.candidate.source_matches(buffers))
            && self.candidate.proposal_epoch() == Some(epoch);
        if !valid {
            self.invalidate_candidate();
            return Err(anyhow!(
                "録音または設定が変わりました。提案を作成し直してください"
            ));
        }
        self.candidate.validate(
            Some(recording_id),
            expected_revision,
            context.current_revision,
        );
        let snapshot = self
            .candidate
            .snapshot
            .as_ref()
            .ok_or_else(|| anyhow!("提案がありません"))?;
        let proposal = snapshot
            .proposal
            .as_ref()
            .ok_or_else(|| anyhow!("提案の準備が完了していません"))?;
        ensure!(
            snapshot.id == id
                && snapshot.state == "ready"
                && proposal.id == id
                && proposal.recording_id == recording_id
                && proposal.epoch == epoch
                && proposal.base_revision == expected_revision,
            "提案の期限が切れました"
        );
        Ok(proposal.config.clone())
    }
    pub(in crate::audio_engine) fn poll(&mut self, main_running: bool) {
        if !main_running && self.preview.is_some() {
            self.interrupt(true);
            return;
        }
        if let Some(preview) = &self.preview {
            self.position = preview.controls.position.load(Ordering::Acquire);
            let timeout = preview
                .stop_started
                .is_some_and(|time| time.elapsed() > Duration::from_millis(500));
            if preview.controls.failed.load(Ordering::Acquire) || timeout {
                self.error = Some(
                    if timeout {
                        "試聴先の停止応答を確認できなかったため、試聴出力を閉じました"
                    } else {
                        "試聴先との接続が失われました。試聴先を選び直してください"
                    }
                    .into(),
                );
                self.state = "failed".into();
                self.preview = None;
            } else if !preview.controls.active.load(Ordering::Acquire) {
                self.state = "stopped".into();
                self.preview = None;
            }
        }
    }
    fn snapshot(
        &self,
        request: &Request,
        context: &Context,
        devices: Vec<PreviewDevice>,
    ) -> Snapshot {
        // 停止後も選択中の候補全長を保持する。取消後は原音へ戻す。
        let candidate_buffers = self
            .active_candidate
            .as_deref()
            .and_then(|id| self.candidate.buffers(id).ok());
        let recording = candidate_buffers
            .as_ref()
            .or(context.buffers.as_ref())
            .and_then(|buffers| buffers.recording());
        let rate = recording
            .as_ref()
            .map_or(1, |recording| recording.sample_rate_hz.max(1));
        let gains = self.preview.as_ref().map_or(
            if self.options.level_match {
                self.matching
            } else {
                [1.0; 2]
            },
            |preview| {
                preview
                    .controls
                    .gains
                    .each_ref()
                    .map(|gain| f32::from_bits(gain.load(Ordering::Acquire)))
            },
        );
        Snapshot {
            noise_basis: context.noise_basis.clone(),
            noise_settings: Some(context.noise.clone()),
            noise_pending: context.noise_pending,
            noise_undo_token: context.noise_undo_token.clone(),
            candidate: self.candidate.snapshot.clone(),
            epoch: self.sessions.epoch.clone(),
            session_id: request.session_id,
            operation_id: self
                .sessions
                .clients
                .get(&request.client_id)
                .map_or(0, |cursor| cursor.operation),
            recording_id: context
                .metadata
                .as_ref()
                .map(|metadata| metadata.recording_id),
            state: self.state.clone(),
            position_ms: (self.position * 1000 / rate as u64) as u32,
            duration_ms: recording.as_ref().map_or(0, |recording| {
                (recording.frames as u64 * 1000 / rate as u64) as u32
            }),
            source: self.options.source,
            loop_playback: self.options.loop_playback,
            level_match: self.options.level_match,
            level_match_available: self.available,
            metadata: context.metadata.clone(),
            recording_stale: context
                .metadata
                .as_ref()
                .is_some_and(|metadata| metadata.revision != context.current_revision),
            devices,
            error: self.error.clone(),
            owner: if self.active() {
                Some("voice_check".into())
            } else if context.auto_gain_active {
                Some("auto_gain".into())
            } else {
                None
            },
            conflict: if context.busy {
                Some(
                    if context.auto_gain_active {
                        "音量調整の録音・聞き比べが使用中です"
                    } else {
                        "ボイスチェックの録音または通常再生が使用中です"
                    }
                    .into(),
                )
            } else {
                None
            },
            level_match_attenuation_db: gains.map(|gain| 20.0 * gain.max(1.0e-12).log10()),
            safety_attenuation_db: 20.0 * self.safety.max(1.0e-12).log10(),
        }
    }
    pub(in crate::audio_engine) fn command(
        &mut self,
        request: Request,
        context: Context,
    ) -> Result<Snapshot> {
        validate_request(&request)?;
        // 厳密な録音条件は新提案だけに適用し、従来の手動A/Bの契約を変えない。
        if self.candidate.proposal_epoch().is_some_and(|epoch| {
            epoch != context.builtin_epoch
                || proposal_source(&context).is_err()
                || context
                    .buffers
                    .as_ref()
                    .is_none_or(|buffers| !self.candidate.source_matches(buffers))
        }) {
            self.invalidate_candidate();
        }
        self.candidate.validate(
            context
                .metadata
                .as_ref()
                .map(|metadata| metadata.recording_id),
            if self
                .candidate
                .snapshot
                .as_ref()
                .is_some_and(|s| s.noise.is_some())
            {
                &context.noise_basis
            } else {
                &context.builtin_revision
            },
            context.current_revision,
        );
        if self
            .active_candidate
            .as_ref()
            .is_some_and(|id| self.candidate.buffers(id).is_err())
        {
            self.invalidate_candidate();
        }
        self.poll(context.main_running);
        if let (Some(metadata), Some(buffers)) = (&context.metadata, &context.buffers) {
            if self.prepared_recording != Some(metadata.recording_id) {
                self.available = false;
                self.matching = [1.0; 2];
                self.safety = 1.0;
                if let Some(recording) = buffers.recording() {
                    let (matching, safety, available) =
                        comparison_gains(recording.raw, recording.processed)
                            .unwrap_or(([1.0; 2], 1.0, false));
                    self.matching = matching;
                    self.safety = safety;
                    self.available = available;
                    self.prepared_recording = Some(metadata.recording_id);
                } else {
                    self.available = false;
                }
            }
        }
        if matches!(request.action, Action::Close) {
            if self.sessions.close(&request)? {
                self.interrupt(false);
                self.state = "closed".into();
            }
            return Ok(self.snapshot(&request, &context, Vec::new()));
        }
        if matches!(request.action, Action::Open) {
            let previous = self.sessions.current.clone();
            self.sessions.open(&request)?;
            if previous != self.sessions.current {
                self.interrupt(false);
                self.state = "idle".into();
                self.error = None;
                self.options = Options::default();
            }
        } else {
            self.sessions.check(
                &request,
                !matches!(
                    request.action,
                    Action::Status | Action::Devices | Action::CandidateStatus { .. }
                ),
            )?;
        }
        let mut devices = Vec::new();
        match &request.action {
            Action::PrepareNoise {
                recording_id,
                expected_basis,
                variant,
            } => {
                let buffers = proposal_source(&context)?;
                ensure!(
                    self.preview.is_none()
                        && !context.noise_pending
                        && expected_basis == &context.noise_basis
                        && !expected_basis.is_empty(),
                    "試聴を停止し、現在のNR条件を取り直してください"
                );
                ensure!(
                    context
                        .metadata
                        .as_ref()
                        .is_some_and(|m| m.recording_id == *recording_id),
                    "録音が変わりました"
                );
                self.invalidate_candidate();
                self.candidate
                    .prepare_noise(
                        buffers.clone(),
                        *recording_id,
                        expected_basis.clone(),
                        context.current_revision,
                        context.noise.variant(*variant),
                    )
                    .map_err(|e| anyhow!(e))?;
            }
            Action::ApplyNoise {
                candidate_id,
                expected_basis,
            } => {
                proposal_source(&context)?;
                ensure!(
                    self.preview.is_none()
                        && !context.noise_pending
                        && expected_basis == &context.noise_basis,
                    "試聴を停止し、現在の条件を確認してください"
                );
                ensure!(
                    context
                        .buffers
                        .as_ref()
                        .is_some_and(|b| self.candidate.source_matches(b)),
                    "録音が変わりました"
                );
                ensure!(
                    self.candidate
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| s.id == *candidate_id
                            && s.state == "ready"
                            && s.noise.is_some()),
                    "NR候補が準備されていません"
                );
            }
            Action::UndoNoise { token } => {
                ensure!(
                    !context.busy
                        && !context.noise_pending
                        && self.preview.is_none()
                        && context.noise_undo_token.as_ref() == Some(token),
                    "復元条件が変わったか、試聴が使用中です"
                );
            }
            Action::PrepareProposal {
                rule_version: _,
                preferences,
                preferences_revision,
                recording_id,
                builtin_epoch,
                expected_revision,
            } => {
                let buffers = proposal_source(&context)?;
                ensure!(
                    builtin_epoch == &context.builtin_epoch
                        && expected_revision == &context.builtin_revision,
                    "内蔵設定が変わりました。現在値を取得し直してください"
                );
                ensure!(
                    context
                        .metadata
                        .as_ref()
                        .is_some_and(|m| m.recording_id == *recording_id),
                    "録音が変わりました"
                );
                // 準備だけで試聴streamや通常音声の設定を作らない。
                ensure!(
                    self.preview.is_none(),
                    "試聴を停止してから提案を作成してください"
                );
                self.invalidate_candidate();
                self.candidate
                    .prepare_proposal(
                        buffers.clone(),
                        crate::audio_engine::singing_proposal::Seed {
                            preferences: preferences.clone(),
                            preferences_revision: *preferences_revision,
                            epoch: builtin_epoch.clone(),
                            recording_id: *recording_id,
                            base_revision: expected_revision.clone(),
                        },
                        context.current_revision,
                        context.builtin_config.clone(),
                    )
                    .map_err(|error| anyhow!(error))?;
            }
            Action::PrepareCandidate {
                recording_id,
                expected_revision,
                config,
            } => {
                ensure!(
                    !context.busy,
                    "録音・通常再生を停止してから候補を生成してください"
                );
                ensure!(
                    expected_revision == &context.builtin_revision,
                    "内蔵設定が変わりました。現在値を取得し直してください"
                );
                ensure!(
                    context
                        .metadata
                        .as_ref()
                        .is_some_and(|metadata| metadata.recording_id == *recording_id),
                    "録音が変わりました"
                );
                self.invalidate_candidate();
                self.candidate
                    .prepare(
                        context
                            .buffers
                            .clone()
                            .ok_or_else(|| anyhow!("先に録音してください"))?,
                        *recording_id,
                        expected_revision.clone(),
                        context.current_revision,
                        config.clone(),
                    )
                    .map_err(|error| anyhow!(error))?;
            }
            Action::CandidateStatus { candidate_id } => {
                ensure!(
                    self.candidate
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.id == *candidate_id),
                    "古い候補です"
                );
            }
            Action::CancelCandidate { candidate_id } => {
                ensure!(
                    self.candidate
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.id == *candidate_id),
                    "古い候補です"
                );
                self.invalidate_candidate();
            }
            Action::Devices => devices = auto_gain_preview::devices()?,
            Action::Start {
                recording_id,
                device_id,
                candidate_id,
                options,
            } => {
                ensure!(
                    context.main_running,
                    "通常の音声が停止しています。設定を確認してから試聴してください"
                );
                ensure!(
                    !context.busy,
                    "別の録音・聞き比べを停止してから試聴してください"
                );
                ensure!(
                    self.preview.is_none(),
                    "再生中の設定変更は切替操作を使ってください"
                );
                ensure!(
                    context
                        .metadata
                        .as_ref()
                        .is_some_and(|metadata| metadata.recording_id == *recording_id),
                    "録音が変わりました。最新の録音を選んでください"
                );
                let buffers = if let Some(id) = candidate_id {
                    self.candidate.buffers(id).map_err(|error| anyhow!(error))?
                } else {
                    context
                        .buffers
                        .clone()
                        .ok_or_else(|| anyhow!("先に録音してください"))?
                };
                if let Some(recording) = buffers.recording() {
                    let (matching, safety, available) =
                        comparison_gains(recording.raw, recording.processed)?;
                    self.matching = matching;
                    self.safety = safety;
                    self.available = available;
                }
                match Preview::start(device_id, buffers, options, context.main_device.as_deref()) {
                    Ok((preview, available)) => {
                        self.preview = Some(preview);
                        self.active_candidate = candidate_id.clone();
                        self.available = available;
                        self.options = options.clone();
                        self.state = "playing".into();
                        self.error = None;
                        self.position = 0;
                    }
                    Err(error) => {
                        self.error = Some(error.to_string());
                        self.state = "failed".into();
                        return Err(error);
                    }
                }
            }
            Action::Update { options } => {
                ensure!(
                    !options.level_match || self.available,
                    "無音または音が少ないため試聴音量を合わせられません"
                );
                let preview = self
                    .preview
                    .as_ref()
                    .ok_or_else(|| anyhow!("試聴は停止しています"))?;
                ensure!(self.state == "playing", "試聴の停止中です");
                preview
                    .controls
                    .options
                    .store(options.bits(), Ordering::Release);
                self.options = options.clone();
            }
            Action::Stop => {
                if let Some(preview) = &mut self.preview {
                    preview.controls.stopping.store(true, Ordering::Release);
                    preview.stop_started = Some(Instant::now());
                    self.state = "stopping".into();
                } else {
                    self.state = "stopped".into();
                }
            }
            _ => {}
        }
        Ok(self.snapshot(&request, &context, devices))
    }
}

#[cfg(test)]
pub(in crate::audio_engine) mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    fn request(session: u64, operation: u64, action: Action) -> Request {
        Request {
            client_id: "window".into(),
            session_id: session,
            operation_id: operation,
            epoch: None,
            action,
        }
    }

    fn recorded_context() -> Context {
        let buffers = Arc::new(super::super::allocate_voice_check_buffers(500, 8_000));
        let mut writer = buffers.claim_writer().unwrap();
        for frame in 0..8 {
            writer.write_raw(frame, 0.2, -0.2);
            writer.write_processed(frame, 0.4, -0.4);
        }
        writer.seal(8);
        Context {
            noise: Default::default(),
            noise_basis: "noise-fixture".into(),
            noise_undo_token: None,
            noise_pending: false,
            builtin_revision: "1".into(),
            builtin_epoch: "builtin-test".into(),
            builtin_config: Default::default(),
            builtin_pending: false,
            buffers: Some(buffers),
            main_device: Some("main-output".into()),
            main_running: true,
            busy: false,
            auto_gain_active: false,
            current_revision: 2,
            metadata: Some(Metadata {
                recording_id: 1,
                revision: 1,
                sample_rate: 8_000,
                buffer_size: 128,
                host: "WASAPI".into(),
                input_channels: [0, 1],
                input_gain: 1.0,
                noise_enabled: false,
                noise_mode: "low".into(),
                noise_strength: 0.6,
                voice_guard: true,
                built_in_enabled: false,
                built_in_preset: "broadcast".into(),
                built_in_amount: 0.5,
                singing: None,
                reverb: None,
                global_bypass: false,
                plugins: Vec::new(),
                changed_during_recording: true,
                raw_tap: "post_input_gain_and_channel_selection_pre_fx".into(),
                processed_tap: "post_fx_pre_output_gain_and_global_mute".into(),
                vst_parameters_verified: false,
            }),
        }
    }

    pub(in crate::audio_engine) fn proposal_context() -> Context {
        let mut context = recorded_context();
        let buffers = Arc::new(super::super::allocate_voice_check_buffers(4000, 8000));
        let mut writer = buffers.claim_writer().unwrap();
        for frame in 0..32000 {
            let amp = if (frame / 4000) % 2 == 0 { 0.05 } else { 0.3 };
            let sample = amp * (std::f32::consts::TAU * 220.0 * frame as f32 / 8000.0).sin();
            writer.write_raw(frame, sample, -sample);
            writer.write_processed(frame, 0.0, 0.0);
        }
        writer.seal(32000);
        context.buffers = Some(buffers);
        let metadata = context.metadata.as_mut().unwrap();
        metadata.revision = context.current_revision;
        metadata.changed_during_recording = false;
        context
    }

    fn proposal_request(epoch: &str) -> Request {
        let mut req = request(
            1,
            2,
            Action::PrepareProposal {
                rule_version: None,
                preferences: None,
                preferences_revision: None,
                recording_id: 1,
                builtin_epoch: "builtin-test".into(),
                expected_revision: "1".into(),
            },
        );
        req.epoch = Some(epoch.into());
        req
    }
    fn await_proposal(controller: &mut Controller, context: &Context, epoch: &str) -> Snapshot {
        for _ in 0..1000 {
            let mut req = request(1, 2, Action::Status);
            req.epoch = Some(epoch.into());
            let snapshot = controller.command(req, context.clone()).unwrap();
            if snapshot
                .candidate
                .as_ref()
                .is_some_and(|c| c.state != "preparing")
            {
                return snapshot;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("提案workerの完了待機が期限切れ");
    }
    #[test]
    fn noise_candidate_requires_current_source_basis_and_pending_free_controls() {
        for invalid in 0..6 {
            let mut controller = Controller::new();
            let mut context = proposal_context();
            let opened = controller
                .command(request(1, 1, Action::Open), context.clone())
                .unwrap();
            match invalid {
                0 => context.metadata.as_mut().unwrap().changed_during_recording = true,
                1 => context.metadata.as_mut().unwrap().revision -= 1,
                2 => context.noise_pending = true,
                3 => context.busy = true,
                4 => context.noise_basis = "changed".into(),
                _ => context.metadata.as_mut().unwrap().recording_id = 2,
            }
            let mut req = request(
                1,
                2,
                Action::PrepareNoise {
                    recording_id: 1,
                    expected_basis: "noise-fixture".into(),
                    variant: crate::audio_engine::noise_candidate::Variant::Weaker,
                },
            );
            req.epoch = Some(opened.epoch);
            assert!(controller.command(req, context).is_err());
            assert!(controller.candidate.snapshot.is_none());
        }
    }
    #[test]
    fn noise_candidate_apply_and_undo_are_bound_to_session_source_and_basis() {
        let mut controller = Controller::new();
        let mut context = proposal_context();
        let original = context.noise.clone();
        let opened = controller
            .command(request(1, 1, Action::Open), context.clone())
            .unwrap();
        let mut prepare = request(
            1,
            2,
            Action::PrepareNoise {
                recording_id: 1,
                expected_basis: context.noise_basis.clone(),
                variant: crate::audio_engine::noise_candidate::Variant::Stronger,
            },
        );
        prepare.epoch = Some(opened.epoch.clone());
        controller.command(prepare, context.clone()).unwrap();
        let ready = await_proposal(&mut controller, &context, &opened.epoch);
        let candidate = ready.candidate.unwrap();
        assert_eq!(candidate.state, "ready");
        assert!(candidate.noise.as_ref().unwrap().enabled);
        assert_eq!(context.noise, original); // validation and rendering never apply to the live state
        let mut apply = request(
            1,
            3,
            Action::ApplyNoise {
                candidate_id: candidate.id,
                expected_basis: context.noise_basis.clone(),
            },
        );
        apply.epoch = Some(opened.epoch.clone());
        assert!(controller.command(apply.clone(), context.clone()).is_ok());
        context.noise_basis = "later-edit".into();
        apply.operation_id += 1;
        assert!(controller.command(apply, context.clone()).is_err());
        context.noise_undo_token = Some("current-token".into());
        let mut undo = request(
            1,
            5,
            Action::UndoNoise {
                token: "old-token".into(),
            },
        );
        undo.epoch = Some(opened.epoch);
        assert!(controller.command(undo.clone(), context.clone()).is_err());
        undo.operation_id += 1;
        undo.action = Action::UndoNoise {
            token: "current-token".into(),
        };
        assert!(controller.command(undo, context).is_ok());
    }
    #[test]
    fn proposal_rejects_recording_conditions_without_changing_manual_candidate_contract() {
        for kind in 0..6 {
            let mut controller = Controller::new();
            let mut context = proposal_context();
            let opened = controller
                .command(request(1, 1, Action::Open), context.clone())
                .unwrap();
            match kind {
                0 => context.metadata.as_mut().unwrap().changed_during_recording = true,
                1 => context.metadata.as_mut().unwrap().revision -= 1,
                2 => context.metadata.as_mut().unwrap().recording_id = 2,
                3 => context.builtin_pending = true,
                4 => context.busy = true,
                _ => context.builtin_epoch = "old".into(),
            }
            assert!(controller
                .command(proposal_request(&opened.epoch), context)
                .is_err());
            assert!(controller.preview.is_none());
            assert!(controller.candidate.snapshot.is_none());
        }
        // 既存の手動A/Bは、古い録音条件でも従来どおり候補を準備できる。
        let mut controller = Controller::new();
        let context = recorded_context();
        let opened = controller
            .command(request(1, 1, Action::Open), context.clone())
            .unwrap();
        let mut req = request(
            1,
            2,
            Action::PrepareCandidate {
                recording_id: 1,
                expected_revision: "1".into(),
                config: Default::default(),
            },
        );
        req.epoch = Some(opened.epoch);
        assert!(controller.command(req, context).is_ok());
    }
    #[test]
    fn proposal_recording_only_change_and_changed_metadata_cannot_adopt_late_results() {
        for kind in 0..4 {
            let mut controller = Controller::new();
            let mut context = proposal_context();
            let opened = controller
                .command(request(1, 1, Action::Open), context.clone())
                .unwrap();
            controller
                .command(proposal_request(&opened.epoch), context.clone())
                .unwrap();
            match kind {
                0 => context.metadata.as_mut().unwrap().recording_id = 2,
                1 => context.metadata.as_mut().unwrap().changed_during_recording = true,
                2 => context.buffers = proposal_context().buffers,
                _ => context.current_revision += 1,
            }
            let snapshot = await_proposal(&mut controller, &context, &opened.epoch);
            assert_eq!(snapshot.candidate.unwrap().state, "cancelled");
            assert!(controller
                .proposal_config("candidate-1-1", 1, "builtin-test", "1", &context)
                .is_err());
        }
    }
    #[test]
    fn proposal_is_read_only_and_close_before_apply_rejects() {
        let mut controller = Controller::new();
        let context = proposal_context();
        let before = context
            .buffers
            .as_ref()
            .unwrap()
            .recording()
            .unwrap()
            .raw
            .to_vec();
        let opened = controller
            .command(request(1, 1, Action::Open), context.clone())
            .unwrap();
        controller
            .command(proposal_request(&opened.epoch), context.clone())
            .unwrap();
        let snapshot = await_proposal(&mut controller, &context, &opened.epoch);
        let candidate = snapshot.candidate.unwrap();
        assert_eq!(candidate.state, "ready");
        assert!(candidate.proposal.is_some());
        assert!(controller.preview.is_none());
        assert_eq!(
            context.buffers.as_ref().unwrap().recording().unwrap().raw,
            before
        );
        let mut close = request(1, 3, Action::Close);
        close.epoch = Some(opened.epoch);
        controller.command(close, context.clone()).unwrap();
        assert!(controller
            .proposal_config(&candidate.id, 1, "builtin-test", "1", &context)
            .is_err());
    }

    fn mock_preview(controller: &mut Controller, controls: Arc<Controls>) {
        // 実機streamを作らず、callback通知と制御側寿命の境界だけを注入する。
        controller.preview = Some(Preview {
            _stream: None,
            _buffers: recorded_context().buffers.unwrap(),
            controls,
            stop_started: None,
        });
        controller.state = "playing".into();
    }

    #[test]
    fn candidate_tail_duration_survives_stop_and_cancel_returns_to_original_timeline() {
        let mut controller = Controller::new();
        let context = recorded_context();
        let opened = controller
            .command(request(1, 1, Action::Open), recorded_context())
            .unwrap();
        controller
            .candidate
            .prepare(
                context.buffers.clone().unwrap(),
                1,
                "1".into(),
                2,
                crate::audio_engine::builtin::Config {
                    reverb: Some(crate::audio_engine::reverb::ReverbParams {
                        enabled: true,
                        decay_seconds: 0.3,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            controller.candidate.validate(Some(1), "1", 2);
            if controller.candidate.snapshot.as_ref().unwrap().state != "preparing" {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        let candidate = controller.candidate.snapshot.as_ref().unwrap().clone();
        assert_eq!(candidate.state, "ready");
        let buffers = controller.candidate.buffers(&candidate.id).unwrap();
        let controls = Arc::new(Controls::new(&Options::default()));
        controls.position.store(4_000, Ordering::Release); // 原音8framesを越えたtail区間。
        controller.preview = Some(Preview {
            _stream: None,
            _buffers: buffers,
            controls: controls.clone(),
            stop_started: None,
        });
        controller.active_candidate = Some(candidate.id.clone());
        controller.state = "playing".into();
        controller.poll(true);
        let status = controller.snapshot(&request(1, 2, Action::Status), &context, Vec::new());
        assert_eq!(status.position_ms, 500);
        assert_eq!(
            status.duration_ms,
            (candidate.rendered_frames * 1000 / 8_000) as u32
        );
        assert!(status.position_ms <= status.duration_ms);
        controls.active.store(false, Ordering::Release);
        controller.poll(true);
        let stopped = controller.snapshot(&request(1, 2, Action::Status), &context, Vec::new());
        assert_eq!(stopped.state, "stopped");
        assert_eq!(stopped.duration_ms, status.duration_ms);
        assert_eq!(stopped.position_ms, status.position_ms);
        let mut cancel = request(
            1,
            2,
            Action::CancelCandidate {
                candidate_id: candidate.id,
            },
        );
        cancel.epoch = Some(opened.epoch);
        let cancelled = controller.command(cancel, context).unwrap();
        assert_eq!(cancelled.duration_ms, 1);
        assert_eq!(cancelled.position_ms, 0);
    }

    #[test]
    fn readonly_poll_does_not_supersede_pending_intent_and_inputs_are_bounded() {
        let mut sessions = Sessions::new();
        sessions.open(&request(1, 1, Action::Open)).unwrap();
        let mut status = request(1, 99, Action::Status);
        status.epoch = Some(sessions.epoch.clone());
        sessions.check(&status, false).unwrap();
        let mut start = request(1, 2, Action::Stop);
        start.epoch = status.epoch;
        sessions.check(&start, true).unwrap();
        for client in ["", "name with spaces", &"a".repeat(129)] {
            let mut invalid = request(2, 1, Action::Open);
            invalid.client_id = client.into();
            assert!(validate_request(&invalid).is_err());
        }
        let mut invalid = request(1, 1, Action::Open);
        invalid.session_id = 9_007_199_254_740_992;
        assert!(validate_request(&invalid).is_err());
        for index in 1..16 {
            let mut other = request(1, 1, Action::Open);
            other.client_id = format!("window-{index}");
            sessions.open(&other).unwrap();
        }
        let mut overflow = request(1, 1, Action::Open);
        overflow.client_id = "extra-window".into();
        assert!(sessions.open(&overflow).is_err());
        assert_eq!(sessions.clients.len(), 16);
    }

    #[test]
    fn status_exposes_recording_conditions_and_conflict_and_never_changes_recording() {
        let mut controller = Controller::new();
        let context = recorded_context();
        let original = context.buffers.as_ref().unwrap().clone();
        let snapshot = controller
            .command(request(1, 1, Action::Open), context)
            .unwrap();
        assert!(snapshot.recording_stale);
        assert!(snapshot.level_match_available);
        assert_eq!(snapshot.duration_ms, 1);
        let metadata = snapshot.metadata.unwrap();
        assert!(metadata.changed_during_recording);
        assert!(!metadata.vst_parameters_verified);
        assert!(metadata.processed_tap.contains("pre_output_gain"));
        let mut context = recorded_context();
        context.busy = true;
        context.auto_gain_active = true;
        let mut status = request(1, 99, Action::Status);
        status.epoch = Some(snapshot.epoch.clone());
        let snapshot = controller.command(status, context).unwrap();
        assert_eq!(snapshot.owner.as_deref(), Some("auto_gain"));
        let mut start = request(
            1,
            2,
            Action::Start {
                candidate_id: None,
                recording_id: 1,
                device_id: "main-output".into(),
                options: Options::default(),
            },
        );
        start.epoch = Some(snapshot.epoch);
        let mut context = recorded_context();
        context.busy = true;
        context.auto_gain_active = true;
        assert!(controller
            .command(start, context)
            .unwrap_err()
            .to_string()
            .contains("別の録音"));
        assert!(controller.preview.is_none());
        let recording = original.recording().unwrap();
        assert_eq!(recording.raw, [0.2, -0.2].repeat(8));
        assert_eq!(recording.processed, [0.4, -0.4].repeat(8));
    }

    #[test]
    fn stop_failure_main_stop_and_old_update_cannot_restart_a_stream() {
        let mut controller = Controller::new();
        let snapshot = controller
            .command(request(1, 1, Action::Open), recorded_context())
            .unwrap();
        let controls = Arc::new(Controls::new(&Options::default()));
        mock_preview(&mut controller, controls.clone());
        let mut stop = request(1, 2, Action::Stop);
        stop.epoch = Some(snapshot.epoch.clone());
        assert_eq!(
            controller.command(stop, recorded_context()).unwrap().state,
            "stopping"
        );
        controller.preview.as_mut().unwrap().stop_started =
            Some(Instant::now() - Duration::from_secs(1));
        controller.poll(true);
        assert_eq!(controller.state, "failed");
        assert!(!controller.active());
        assert!(!controls.active.load(Ordering::Acquire));
        let controls = Arc::new(Controls::new(&Options::default()));
        mock_preview(&mut controller, controls.clone());
        controls.failed.store(true, Ordering::Release);
        controller.poll(true);
        assert_eq!(controller.state, "failed");
        mock_preview(
            &mut controller,
            Arc::new(Controls::new(&Options::default())),
        );
        controller.poll(false);
        assert_eq!(controller.state, "closed");
        let mut update = request(
            1,
            3,
            Action::Update {
                options: Options::default(),
            },
        );
        update.epoch = Some(snapshot.epoch);
        assert!(controller.command(update, recorded_context()).is_err());
        assert!(!controller.active());
    }

    #[test]
    fn pending_legacy_play_and_stop_reject_separate_start_until_callback_ack() {
        let shared = super::super::VoiceCheckShared::new();
        let mut controller = Controller::new();
        let snapshot = controller
            .command(request(1, 1, Action::Open), recorded_context())
            .unwrap();
        let play = shared.reserve_transport();
        let stop = shared.reserve_transport();
        for (operation, ack) in [(2, None), (3, Some(play))] {
            if let Some(revision) = ack {
                shared.acknowledge_transport(revision);
            }
            let mut context = recorded_context();
            context.busy = shared.transport_busy();
            let mut start = request(
                1,
                operation,
                Action::Start {
                    candidate_id: None,
                    recording_id: 1,
                    device_id: "unused".into(),
                    options: Options::default(),
                },
            );
            start.epoch = Some(snapshot.epoch.clone());
            assert!(controller
                .command(start, context)
                .unwrap_err()
                .to_string()
                .contains("別の録音"));
            assert!(!controller.active());
        }
        shared.acknowledge_transport(stop);
        assert!(!shared.transport_busy());
    }

    #[test]
    fn close_from_previous_epoch_cannot_stop_or_tombstone_reopened_session() {
        let mut controller = Controller::new();
        let snapshot = controller
            .command(request(1, 1, Action::Open), recorded_context())
            .unwrap();
        let controls = Arc::new(Controls::new(&Options::default()));
        mock_preview(&mut controller, controls.clone());
        let mut close = request(1, 9, Action::Close);
        close.epoch = Some("previous-engine".into());
        assert!(controller.command(close, recorded_context()).is_err());
        assert!(controller.active());
        assert!(controls.active.load(Ordering::Acquire));
        let mut update = request(
            1,
            2,
            Action::Update {
                options: Options::default(),
            },
        );
        update.epoch = Some(snapshot.epoch);
        assert!(controller.command(update, recorded_context()).is_ok());
        let close = request(1, 10, Action::Close);
        assert_eq!(
            controller.command(close, recorded_context()).unwrap().state,
            "closed"
        );
        assert!(!controller.active());
    }

    #[test]
    fn empty_and_short_recordings_loop_and_finish_without_nonfinite_values_or_allocations() {
        for frames in [0, 1, 2, 3, 17] {
            let raw = vec![0.25; frames * 2];
            let processed = vec![-0.5; frames * 2];
            for looping in [false, true] {
                let options = Options {
                    loop_playback: looping,
                    ..Options::default()
                };
                let controls = Controls::new(&options);
                let mut renderer = Renderer::new(&options, 48_000, frames);
                let mut output = [0.0; 84];
                assert_eq!(
                    allocation_counts(|| renderer.render(
                        &mut output,
                        4,
                        [&raw, &processed],
                        [1.0, 0.5],
                        1.0,
                        &controls
                    )),
                    (0, 0)
                );
                assert!(output.iter().all(|sample| sample.is_finite()));
                assert!(output
                    .chunks_exact(4)
                    .all(|frame| frame[2] == 0.0 && frame[3] == 0.0));
                if !looping || frames == 0 {
                    assert!(!controls.active.load(Ordering::Acquire));
                }
            }
        }
    }

    #[test]
    fn typed_protocol_has_flat_camel_case_payload_and_rejects_invalid_sources() {
        let mut start = request(
            1,
            2,
            Action::Start {
                candidate_id: None,
                recording_id: 3,
                device_id: "headphones".into(),
                options: Options::default(),
            },
        );
        start.epoch = Some("epoch".into());
        let value = serde_json::to_value(&start).unwrap();
        assert_eq!(value["recordingId"], 3);
        assert_eq!(value["source"], "processed");
        assert_eq!(value["loopPlayback"], true);
        assert_eq!(value["sessionId"], 1);
        let decoded: Request = serde_json::from_value(value.clone()).unwrap();
        assert!(matches!(decoded.action, Action::Start { .. }));
        let mut invalid = value;
        invalid["source"] = serde_json::json!("other");
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }
    #[test]
    fn close_before_open_and_old_session_operations_cannot_resurrect_or_stop_new_preview() {
        let mut sessions = Sessions::new();
        sessions.close(&request(1, 3, Action::Close)).unwrap();
        assert!(sessions.open(&request(1, 1, Action::Open)).is_err());
        sessions.open(&request(2, 1, Action::Open)).unwrap();
        assert!(!sessions.close(&request(1, 9, Action::Close)).unwrap());
        let mut update = request(2, 3, Action::Stop);
        update.epoch = Some(sessions.epoch.clone());
        sessions.check(&update, true).unwrap();
        update.operation_id = 2;
        assert!(sessions.check(&update, true).is_err());
        update.operation_id = 4;
        update.epoch = Some("old-engine".into());
        assert!(sessions.check(&update, true).is_err());
    }
    #[test]
    fn matching_only_attenuates_and_handles_antiphase_silence_and_invalid_data() {
        let (gains, safety, available) = comparison_gains(&[0.2, -0.2], &[0.4, -0.4]).unwrap();
        assert!(available);
        assert_eq!(gains, [1.0, 0.5]);
        assert_eq!(safety, 1.0);
        assert!(!comparison_gains(&[0.0; 2], &[0.4; 2]).unwrap().2);
        assert!(comparison_gains(&[f32::NAN; 2], &[0.4; 2]).is_err());
        assert_eq!(comparison_gains(&[2.0; 2], &[4.0; 2]).unwrap().1, 0.225);
    }
    #[test]
    fn ab_switch_keeps_one_cursor_and_loop_stop_and_render_allocate_nothing() {
        let raw: Vec<_> = (0..64)
            .flat_map(|frame| [frame as f32 / 100.0; 2])
            .collect();
        let processed: Vec<_> = raw.iter().map(|sample| -*sample).collect();
        let mut options = Options {
            source: Source::Raw,
            loop_playback: true,
            level_match: false,
        };
        let controls = Controls::new(&options);
        let mut renderer = Renderer::new(&options, 400, 64);
        let mut output = [0.0; 16];
        assert_eq!(
            allocation_counts(|| renderer.render(
                &mut output,
                2,
                [&raw, &processed],
                [1.0; 2],
                1.0,
                &controls
            )),
            (0, 0)
        );
        assert_eq!(renderer.position, 8);
        options.source = Source::Processed;
        controls.options.store(options.bits(), Ordering::Release);
        renderer.render(&mut output, 2, [&raw, &processed], [1.0; 2], 1.0, &controls);
        assert_eq!(renderer.position, 16);
        assert_eq!(output[14], -0.15);
        for _ in 0..10 {
            renderer.render(&mut output, 2, [&raw, &processed], [1.0; 2], 1.0, &controls);
        }
        assert!(controls.active.load(Ordering::Acquire));
        controls.stopping.store(true, Ordering::Release);
        assert_eq!(
            allocation_counts(|| renderer.render(
                &mut output,
                2,
                [&raw, &processed],
                [1.0; 2],
                1.0,
                &controls
            )),
            (0, 0)
        );
        assert!(!controls.active.load(Ordering::Acquire));
        renderer.render(&mut output, 2, [&raw, &processed], [1.0; 2], 1.0, &controls);
        assert_eq!(output, [0.0; 16]);
    }
}

#[cfg(test)]
mod preference_protocol_tests {
    use super::*;
    fn request(operation: u64, revision: u64) -> Request {
        Request {
            client_id: "prefs".into(),
            session_id: 1,
            operation_id: operation,
            epoch: None,
            action: Action::PrepareProposal {
                rule_version: Some(crate::audio_engine::singing_proposal::RULE_VERSION_V2.into()),
                preferences: Some(Default::default()),
                preferences_revision: Some(revision),
                recording_id: 1,
                builtin_epoch: "builtin".into(),
                expected_revision: "4".into(),
            },
        }
    }
    #[test]
    fn proposal_preference_wire_requires_complete_known_version_and_monotonic_session_revision() {
        let good = request(2, 2);
        assert!(validate_request(&good).is_ok());
        for key in ["ruleVersion", "preferences", "preferencesRevision"] {
            let mut value = serde_json::to_value(&good).unwrap();
            value.as_object_mut().unwrap().remove(key);
            let parsed: Request = serde_json::from_value(value).unwrap();
            assert!(validate_request(&parsed).is_err());
        }
        let mut unknown = serde_json::to_value(&good).unwrap();
        unknown["ruleVersion"] = "future".into();
        let unknown: Request = serde_json::from_value(unknown).unwrap();
        assert!(validate_request(&unknown).is_err());
        let mut old = serde_json::to_value(&good).unwrap();
        for key in ["ruleVersion", "preferences", "preferencesRevision"] {
            old.as_object_mut().unwrap().remove(key);
        }
        let old: Request = serde_json::from_value(old).unwrap();
        assert!(validate_request(&old).is_ok());
        let mut sessions = Sessions::new();
        let mut open = request(1, 1);
        open.action = Action::Open;
        sessions.open(&open).unwrap();
        let mut good = good;
        good.epoch = Some(sessions.epoch.clone());
        sessions.check(&good, true).unwrap();
        let mut equal = request(3, 2);
        equal.epoch = good.epoch.clone();
        sessions.check(&equal, true).unwrap();
        let mut stale = request(4, 1);
        stale.epoch = good.epoch.clone();
        assert!(sessions.check(&stale, true).is_err());
        assert_eq!(sessions.clients["prefs"].operation, 3);
        stale.epoch = Some("old-engine".into());
        assert!(sessions.check(&stale, true).is_err());
    }
}

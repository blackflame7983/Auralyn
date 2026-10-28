//! 本番用の内蔵処理だけを保持する。VST/device/NR/gain/muteを変更しない。
use super::{
    builtin::{Config, Preset},
    reverb, singing,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Singing,
    Talk,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definitions {
    pub schema_version: u32,
    pub version: String,
    pub singing: Option<Config>,
    pub talk: Option<Config>,
}
impl Default for Definitions {
    fn default() -> Self {
        Self {
            schema_version: 1,
            version: "1".into(),
            singing: None,
            talk: None,
        }
    }
}
impl Definitions {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.schema_version != 1
            || self
                .version
                .parse::<u64>()
                .ok()
                .is_none_or(|version| version == 0)
        {
            return Err("本番モードの保存形式を確認してください".into());
        }
        self.singing = self.singing.map(Config::normalize).transpose()?;
        self.talk = self.talk.map(Config::normalize).transpose()?;
        if self
            .talk
            .as_ref()
            .is_some_and(|config| config.reverb.is_some_and(|p| p.enabled))
        {
            return Err(
                "雑談モードは新しい残響を送らないため、残響をOFFにして保存してください".into(),
            );
        }
        Ok(self)
    }
    pub(crate) fn config(&self, mode: Mode) -> Result<Config, String> {
        match mode {
            Mode::Singing => &self.singing,
            Mode::Talk => &self.talk,
        }
        .clone()
        .ok_or_else(|| "本番モードが未割当です。先に内蔵設定を保存してください".into())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub client_id: String,
    pub sequence: u64,
    pub expected_epoch: String,
}
#[derive(Default)]
pub(crate) struct Intents(Vec<(String, u64)>);
impl Intents {
    pub(crate) fn accept(&mut self, intent: &Intent) -> Result<(), String> {
        if intent.expected_epoch.is_empty()
            || intent.expected_epoch.len() > 128
            || intent.client_id.is_empty()
            || intent.client_id.len() > 128
            || !intent
                .client_id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"-_:".contains(&ch))
            || !(1..=9_007_199_254_740_991).contains(&intent.sequence)
        {
            return Err("本番操作の識別情報が不正です".into());
        }
        if let Some((_, previous)) = self
            .0
            .iter_mut()
            .find(|(client, _)| client == &intent.client_id)
        {
            if intent.sequence <= *previous {
                return Err("古い本番操作を拒否しました。現在値を確認してください".into());
            }
            *previous = intent.sequence;
            return Ok(());
        }
        if self.0.len() == 16 {
            return Err("本番操作clientの上限です。アプリを再起動してください".into());
        }
        self.0.push((intent.client_id.clone(), intent.sequence));
        Ok(())
    }
}
impl Request {
    pub(crate) fn intent(&self) -> Option<&Intent> {
        match self {
            Self::SingingOn { intent }
            | Self::TalkOn { intent }
            | Self::Arm { intent }
            | Self::Disarm { intent } => Some(intent),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Snapshot,
    Save {
        expected_version: String,
        singing: Option<Config>,
        talk: Option<Config>,
    },
    SingingOn {
        intent: Intent,
    },
    TalkOn {
        intent: Intent,
    },
    Arm {
        intent: Intent,
    },
    Disarm {
        intent: Intent,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub running: bool,
    pub revision: String,
    pub accepted_revision: String,
    pub completed_revision: String,
    pub target: Option<Mode>,
    pub applied: Option<Mode>,
    pub phase: String,
    pub armed: bool,
    pub natural_tail: bool,
    pub definitions: Definitions,
    pub error: Option<String>,
}
#[derive(Default)]
pub(crate) struct Shared {
    pub accepted: AtomicU64,
    pub completed: AtomicU64,
}
#[derive(Clone)]
pub(crate) struct Job {
    pub revision: u64,
    pub mode: Mode,
    pub config: Config,
}
pub(crate) struct Controller {
    pub definitions: Definitions,
    pub armed: bool,
    pub bound: Option<StartSpec>,
    pub intents: Intents,
    pub shared: Arc<Shared>,
    revision: u64,
    target: Option<Mode>,
    applied: Option<Mode>,
    desired: Option<Config>,
    in_flight: Option<Job>,
    completed: u64,
}
impl Controller {
    pub(crate) fn new() -> Self {
        Self {
            definitions: Definitions::default(),
            armed: false,
            bound: None,
            intents: Intents::default(),
            shared: Arc::new(Shared::default()),
            revision: 1,
            target: None,
            applied: None,
            desired: None,
            in_flight: None,
            completed: 0,
        }
    }
    pub(crate) fn accept_request(&mut self, request: &Request, epoch: &str) -> Result<(), String> {
        if let Some(intent) = request.intent() {
            if intent.expected_epoch != epoch {
                return Err("古い音声世代の本番操作を拒否しました".into());
            }
            self.intents.accept(intent)?;
        }
        Ok(())
    }
    pub(crate) fn configure(
        &mut self,
        definitions: Definitions,
        armed: bool,
    ) -> Result<(), String> {
        if self.in_flight.is_some() {
            return Err("切替完了後に本番モードを保存してください".into());
        }
        let definitions = definitions.validate()?;
        if self.definitions.version != definitions.version {
            self.custom();
        }
        self.definitions = definitions;
        self.armed = armed;
        Ok(())
    }
    pub(crate) fn select(&mut self, mode: Mode) -> Result<Option<Config>, String> {
        let config = self.definitions.config(mode)?;
        if self.target == Some(mode) && self.desired.as_ref() == Some(&config) {
            return Ok(None);
        }
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("本番モードの操作上限です")?;
        self.target = Some(mode);
        self.desired = Some(config.clone());
        Ok(Some(config))
    }
    pub(crate) fn custom(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.target = None;
        self.applied = None;
        self.desired = None;
        self.in_flight = None;
    }
    pub(crate) fn stop(&mut self) {
        self.in_flight = None;
        self.applied = None;
        self.completed = 0;
    }
    pub(crate) fn start(&mut self) -> u64 {
        self.in_flight = self
            .target
            .zip(self.desired.clone())
            .map(|(mode, config)| Job {
                revision: self.revision,
                mode,
                config,
            });
        self.applied = None;
        self.completed = 0;
        self.shared.accepted.store(0, Ordering::Release);
        self.shared.completed.store(0, Ordering::Release);
        self.revision
    }
    pub(crate) fn next(&mut self, running: bool) -> Option<Job> {
        if let Some(job) = &self.in_flight {
            if self.shared.completed.load(Ordering::Acquire) == job.revision {
                self.applied = Some(job.mode);
                self.completed = job.revision;
                self.in_flight = None;
            }
        }
        if !running || self.in_flight.is_some() || self.completed == self.revision {
            return None;
        }
        let job = Job {
            revision: self.revision,
            mode: self.target?,
            config: self.desired.clone()?,
        };
        self.in_flight = Some(job.clone());
        Some(job)
    }
    pub(crate) fn snapshot(&self, epoch: String, running: bool) -> Snapshot {
        Snapshot {
            epoch,
            running,
            revision: self.revision.to_string(),
            accepted_revision: self.shared.accepted.load(Ordering::Acquire).to_string(),
            completed_revision: self.completed.to_string(),
            target: self.target,
            applied: self.applied,
            phase: if self.target.is_none() {
                "custom"
            } else if !running {
                "stopped"
            } else if self.completed == self.revision {
                "settled"
            } else if self.shared.accepted.load(Ordering::Acquire) == self.revision {
                "transitioning"
            } else {
                "queued"
            }
            .into(),
            armed: self.armed,
            natural_tail: running && self.target == Some(Mode::Talk),
            definitions: self.definitions.clone(),
            error: None,
        }
    }
}

// 状態は固定サイズで、係数はcontrol側で構築する。旧通常設定経路の式を保つ。
pub struct Voice {
    active: bool,
    preset: Preset,
    amount: f32,
    legacy: super::core::dsp::RtBuiltInVoiceChain,
    singing: singing::SingingChain,
}
impl Voice {
    pub(crate) fn prepare(config: &Config, rate: u32) -> Result<Self, String> {
        Ok(Self {
            active: config.active,
            preset: config.preset,
            amount: config.amount,
            legacy: super::core::dsp::RtBuiltInVoiceChain::new(rate.min(192_000)),
            singing: singing::SingingChain::new(
                singing::Coefficients::prepare(config.singing.unwrap_or_default(), rate)?,
                config.active && config.preset == Preset::Singing,
            ),
        })
    }
    fn update(
        &mut self,
        active: bool,
        preset: Preset,
        amount: f32,
        coefficients: singing::Coefficients,
    ) {
        self.active = active;
        self.preset = preset;
        self.amount = amount;
        self.singing
            .update(coefficients, active && preset == Preset::Singing);
    }
    fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let base = if self.active && self.preset != Preset::Singing {
            let (l, r) = self
                .legacy
                .process_sample(input[0], input[1], self.preset, self.amount);
            [l, r]
        } else {
            input
        };
        if self.singing.active() {
            self.singing.process(input, base)
        } else {
            base
        }
    }
}
struct Transition {
    voice: Voice,
    revision: u64,
    builtin_revision: u64,
    frame: u32,
    frames: u32,
}
pub(crate) struct RtVoice {
    current: Voice,
    transition: Option<Transition>,
    done: Option<(u64, u64)>,
}
impl RtVoice {
    pub(crate) fn new(current: Voice) -> Self {
        Self {
            current,
            transition: None,
            done: None,
        }
    }
    pub(crate) fn update_normal(
        &mut self,
        active: bool,
        preset: Preset,
        amount: f32,
        coefficients: singing::Coefficients,
    ) {
        self.transition = None;
        self.done = None;
        self.current.update(active, preset, amount, coefficients);
    }
    pub(crate) fn start(
        &mut self,
        voice: Voice,
        revision: u64,
        builtin_revision: u64,
        frames: u32,
    ) {
        self.transition = Some(Transition {
            voice,
            revision,
            builtin_revision,
            frame: 0,
            frames: frames.max(1),
        });
    }
    pub(crate) fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let base = self.current.process(input);
        let Some(transition) = &mut self.transition else {
            return base;
        };
        let target = transition.voice.process(input);
        transition.frame += 1;
        let mix = transition.frame as f32 / transition.frames as f32;
        let output = std::array::from_fn(|ch| {
            ((1.0 - mix) as f64 * base[ch] as f64 + mix as f64 * target[ch] as f64)
                .clamp(-(f32::MAX as f64), f32::MAX as f64) as f32
        });
        if transition.frame == transition.frames {
            let transition = self.transition.take().expect("実行中の遷移");
            self.done = Some((transition.revision, transition.builtin_revision));
            self.current = transition.voice;
        }
        output
    }
    pub(crate) fn take_completed(&mut self) -> Option<(u64, u64)> {
        self.done.take()
    }
}

pub(crate) fn reverb_coefficients(
    config: &Config,
    rate: u32,
) -> Result<reverb::Coefficients, String> {
    reverb::Coefficients::prepare(config.reverb.unwrap_or_default(), rate)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StartSpec {
    pub host: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub input_id: Option<String>,
    pub output_id: Option<String>,
    pub rate: Option<u32>,
    pub buffer: Option<u32>,
}
impl StartSpec {
    pub(crate) fn concrete(&self) -> bool {
        self.input.as_ref().is_some_and(|s| !s.is_empty())
            && self.output.as_ref().is_some_and(|s| !s.is_empty())
            && self.rate.is_some_and(|r| r > 0)
            && self.buffer.is_some_and(|b| b > 0)
    }
    pub(crate) fn from_command(command: &crate::ipc::Command) -> Option<Self> {
        if let crate::ipc::Command::Start {
            host,
            input,
            output,
            input_id,
            output_id,
            sample_rate,
            buffer_size,
            ..
        } = command
        {
            Some(Self {
                host: host.clone(),
                input: input.clone(),
                output: output.clone(),
                input_id: input_id.clone(),
                output_id: output_id.clone(),
                rate: *sample_rate,
                buffer: *buffer_size,
            })
        } else {
            None
        }
    }
}
pub(crate) const PROTECTED: &str = "本番保護中はデバイス変更・スキャン・ラック／プロファイル置換はできません。停止・ミュートは利用できます。変更する場合は本番保護を解除してください";
pub(crate) fn guard(
    armed: bool,
    bound: Option<&StartSpec>,
    command: &crate::ipc::Command,
) -> Result<(), String> {
    use crate::ipc::Command;
    if !armed {
        return Ok(());
    }
    let blocked = match command {
        Command::Start {
            initial_controls, ..
        } => {
            initial_controls.is_some()
                || StartSpec::from_command(command)
                    .is_none_or(|requested| !requested.concrete() || bound != Some(&requested))
        }
        Command::BeginDeviceScan
        | Command::LoadPlugin { .. }
        | Command::RestorePlugin { .. }
        | Command::RestoreSessionPlugin { .. }
        | Command::UnloadPlugin { .. }
        | Command::ReorderPlugins { .. }
        | Command::SetPluginState { .. } => true,
        _ => false,
    };
    if blocked {
        Err(PROTECTED.into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn definitions() -> Definitions {
        Definitions {
            singing: Some(Config {
                active: true,
                preset: Preset::Singing,
                reverb: Some(reverb::ReverbParams {
                    enabled: true,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            talk: Some(Config::default()),
            ..Default::default()
        }
    }
    #[test]
    fn live_modes_protection_intents_are_epoch_and_sequence_checked_in_engine() {
        let mut controller = Controller::new();
        let make = |sequence, epoch: &str| Intent {
            client_id: "ui".into(),
            sequence,
            expected_epoch: epoch.into(),
        };
        controller
            .accept_request(
                &Request::Arm {
                    intent: make(2, "current"),
                },
                "current",
            )
            .unwrap();
        assert!(controller
            .accept_request(
                &Request::Disarm {
                    intent: make(1, "current")
                },
                "current"
            )
            .is_err());
        controller
            .accept_request(
                &Request::Disarm {
                    intent: make(3, "current"),
                },
                "current",
            )
            .unwrap();
        for request in [
            Request::Arm {
                intent: make(99, "old"),
            },
            Request::Disarm {
                intent: make(100, "old"),
            },
        ] {
            assert!(controller.accept_request(&request, "current").is_err());
        }
        controller
            .accept_request(
                &Request::Arm {
                    intent: make(4, "current"),
                },
                "current",
            )
            .unwrap();
    }

    #[test]
    fn live_modes_idempotence_latest_one_old_ack_custom_stop_and_start_are_separate() {
        let mut controller = Controller::new();
        assert!(controller.select(Mode::Singing).is_err());
        controller.configure(definitions(), false).unwrap();
        assert!(controller.select(Mode::Singing).unwrap().is_some());
        let revision = controller.revision;
        assert!(controller.select(Mode::Singing).unwrap().is_none());
        assert_eq!(controller.revision, revision);
        let first = controller.next(true).unwrap();
        for mode in [Mode::Talk, Mode::Singing, Mode::Talk] {
            controller.select(mode).unwrap();
            assert!(controller.next(true).is_none());
        }
        let latest = controller.revision;
        controller
            .shared
            .accepted
            .store(first.revision, Ordering::Release);
        assert_eq!(controller.snapshot("epoch".into(), true).phase, "queued");
        controller
            .shared
            .completed
            .store(first.revision - 1, Ordering::Release);
        assert!(controller.next(true).is_none());
        controller
            .shared
            .completed
            .store(first.revision, Ordering::Release);
        let last = controller.next(true).unwrap();
        assert_eq!(last.mode, Mode::Talk);
        assert_eq!(last.revision, latest);
        controller
            .shared
            .completed
            .store(first.revision, Ordering::Release);
        assert!(controller.next(true).is_none());
        assert_eq!(controller.target, Some(Mode::Talk));
        controller.custom();
        controller
            .shared
            .completed
            .store(last.revision, Ordering::Release);
        assert!(controller.next(true).is_none());
        assert_eq!(controller.snapshot("epoch".into(), true).phase, "custom");
        controller.select(Mode::Singing).unwrap();
        controller.stop();
        assert_eq!(controller.snapshot("epoch".into(), false).phase, "stopped");
        assert!(controller.next(false).is_none());
        let first_callback_revision = controller.start();
        assert_eq!(
            controller.snapshot("new-epoch".into(), true).phase,
            "queued"
        );
        controller
            .shared
            .accepted
            .store(first_callback_revision, Ordering::Release);
        controller
            .shared
            .completed
            .store(first_callback_revision, Ordering::Release);
        assert!(controller.next(true).is_none());
        assert_eq!(
            controller.snapshot("new-epoch".into(), true).phase,
            "settled"
        );
    }
    #[test]
    fn live_modes_voice_crossfade_is_convex_finite_and_has_no_rt_allocations_or_drops() {
        use crate::dsp_verification_allocator::allocation_counts;
        for rate in [44_100, 48_000, 96_000, 192_000, 384_000] {
            let definitions = definitions();
            let dry = Config::default();
            let mut live = RtVoice::new(Voice::prepare(&dry, rate).unwrap());
            let target = Voice::prepare(definitions.singing.as_ref().unwrap(), rate).unwrap();
            let mut expected = Voice::prepare(definitions.singing.as_ref().unwrap(), rate).unwrap();
            let frames = rate / 50;
            assert_eq!(
                allocation_counts(|| {
                    live.start(target, 7, 9, frames);
                    for i in 0..frames {
                        let input = [(i as f32 * 0.1).sin() * 0.3, -0.1];
                        let to = expected.process(input);
                        let mix = (i + 1) as f32 / frames as f32;
                        let actual = live.process(input);
                        for ch in 0..2 {
                            assert!(actual[ch].is_finite());
                            assert!(
                                (actual[ch]
                                    - (input[ch] as f64 * (1.0 - mix) as f64
                                        + to[ch] as f64 * mix as f64)
                                        as f32)
                                    .abs()
                                    < 1e-7
                            );
                        }
                        if i + 1 < frames {
                            assert!(live.take_completed().is_none());
                        }
                    }
                    assert_eq!(live.take_completed(), Some((7, 9)));
                    assert_eq!(live.process([0.1; 2]), expected.process([0.1; 2]));
                }),
                (0, 0)
            );
        }
        for preset in [Preset::Broadcast, Preset::Warm, Preset::Bright] {
            let config = Config {
                active: true,
                preset,
                ..Default::default()
            };
            let mut voice = Voice::prepare(&config, 48_000).unwrap();
            let mut legacy = super::super::core::dsp::RtBuiltInVoiceChain::new(48_000);
            for i in 0..4096 {
                let x = (i as f32 * 0.07).sin() * 0.3;
                let expected = legacy.process_sample(x, -x, preset, 0.7);
                assert_eq!(voice.process([x, -x]), [expected.0, expected.1]);
            }
        }
    }
    #[test]
    fn live_modes_definitions_and_client_intents_are_bounded_and_no_profile_fields_can_leak() {
        let mut definitions = definitions();
        definitions.talk.as_mut().unwrap().reverb = Some(reverb::ReverbParams {
            enabled: true,
            ..Default::default()
        });
        assert!(definitions.validate().is_err());
        assert!(serde_json::from_str::<Definitions>(
            r#"{"schemaVersion":1,"version":"1","singing":null,"talk":null,"device":"bad"}"#
        )
        .is_err());
        let mut intents = Intents::default();
        let mut intent = Intent {
            client_id: "ui".into(),
            sequence: 2,
            expected_epoch: "epoch".into(),
        };
        intents.accept(&intent).unwrap();
        intent.sequence = 1;
        assert!(intents.accept(&intent).is_err());
        intent.sequence = 3;
        intents.accept(&intent).unwrap();
        for i in 0..15 {
            intents
                .accept(&Intent {
                    client_id: format!("client-{i}"),
                    ..intent.clone()
                })
                .unwrap();
        }
        assert!(intents
            .accept(&Intent {
                client_id: "overflow".into(),
                ..intent
            })
            .is_err());
    }
    #[test]
    fn live_modes_protection_blocks_pre_start_changes_but_allows_exact_recovery_stop_and_mute() {
        use crate::ipc::Command;
        let start = Command::Start {
            host: "ASIO".into(),
            input: Some("input".into()),
            output: Some("output".into()),
            input_id: None,
            output_id: None,
            sample_rate: Some(96_000),
            buffer_size: Some(512),
            initial_controls: None,
        };
        let bound = StartSpec::from_command(&start).unwrap();
        assert!(guard(true, Some(&bound), &start).is_ok());
        for command in [
            Command::BeginDeviceScan,
            Command::LoadPlugin { path: "x".into() },
            Command::UnloadPlugin { id: "x".into() },
            Command::ReorderPlugins { order: vec![] },
            Command::Start {
                host: "ASIO".into(),
                input: None,
                output: Some("output".into()),
                input_id: None,
                output_id: None,
                sample_rate: Some(96_000),
                buffer_size: Some(512),
                initial_controls: None,
            },
        ] {
            assert!(guard(true, Some(&bound), &command).is_err());
        }
        for command in [
            Command::Stop,
            Command::SetGlobalMute { active: true },
            Command::CancelDeviceScan { token: 1 },
        ] {
            assert!(guard(true, Some(&bound), &command).is_ok());
        }
    }
}

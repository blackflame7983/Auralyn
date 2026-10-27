//! NRの時間対応と経路切替。履歴領域はprepareで確保し、処理/resetでは確保しない。
use super::dsp::{
    finite_audio_sample, noise_reduction_mix_from_mode, NoiseGeometry, RtNoiseReducer,
};
use super::NoiseControlMode;

#[derive(Clone, Copy)]
pub(super) struct Settings {
    pub enabled: bool,
    pub mode: NoiseControlMode,
    pub strength: f32,
    pub voice_guard: bool,
}

#[derive(Clone, Copy)]
pub(super) struct Analysis {
    pub speech: bool,
    pub profile_rms: Option<f32>,
    pub learned_mix: f32,
}

#[derive(Clone, Copy, Default)]
struct MixFrame {
    dry: [f32; 2],
    wet: f32,
    protect_voice: bool,
}

struct Ramp {
    value: f32,
    target: f32,
    step: f32,
    remaining: usize,
    length: usize,
}

impl Ramp {
    fn new(value: f32, length: usize) -> Self {
        Self {
            value,
            target: value,
            step: 0.0,
            remaining: 0,
            length,
        }
    }

    fn reset(&mut self, value: f32) {
        self.value = value;
        self.target = value;
        self.step = 0.0;
        self.remaining = 0;
    }

    fn target(&mut self, target: f32) {
        if self.target == target {
            return;
        }
        self.target = target;
        self.step = (target - self.value) / self.length as f32;
        self.remaining = self.length;
    }

    fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.value = if self.remaining == 0 {
                self.target
            } else {
                self.value + self.step
            };
        }
        self.value
    }
}

struct AlignedMix {
    history: Vec<MixFrame>,
    position: usize,
    filled: usize,
    wet: Ramp,
    initialized: bool,
}

impl AlignedMix {
    fn new(delay: usize, ramp_samples: usize) -> Self {
        Self {
            history: vec![MixFrame::default(); delay],
            position: 0,
            filled: 0,
            wet: Ramp::new(0.0, ramp_samples),
            initialized: false,
        }
    }

    fn reset(&mut self) {
        self.history.fill(MixFrame::default());
        self.position = 0;
        self.filled = 0;
        self.wet.reset(0.0);
        self.initialized = false;
    }

    fn process(&mut self, input: MixFrame, wet_audio: [f32; 2]) -> Option<[f32; 2]> {
        let delayed = self.history[self.position];
        self.history[self.position] = input;
        self.position = (self.position + 1) % self.history.len();
        if self.filled < self.history.len() {
            self.filled += 1;
            return None;
        }
        if !self.initialized {
            self.wet.reset(delayed.wet);
            self.initialized = true;
        }
        self.wet.target(delayed.wet);
        let mut wet = self.wet.next();
        // 発声保護の上限を平滑化のために超えない。解除側は短いランプで戻す。
        if delayed.protect_voice && wet > delayed.wet {
            wet = delayed.wet;
            self.wet.reset(wet);
        }
        Some(std::array::from_fn(|ch| {
            delayed.dry[ch] * (1.0 - wet) + wet_audio[ch] * wet
        }))
    }
}

pub(super) struct RtNoiseControl {
    reducer: RtNoiseReducer,
    settings: Settings,
    frame: MixFrame,
    gate_threshold: Option<f32>,
    aligned: AlignedMix,
    path_enabled: bool,
    warming: bool,
    gain: Ramp,
}

impl RtNoiseControl {
    pub(super) fn prepare(rate: u32, settings: Settings) -> Option<Self> {
        let geometry = NoiseGeometry::checked(rate)?;
        // RNNoiseの前フレームを合成する窓処理Nと、収集後に先頭を返す待ちN-1。
        // 信号対応の基準値であり、フィルターの周波数別位相や機器の遅延ではない。
        let delay = geometry.frames * 2 - 1;
        let ramp_samples = ((rate as usize + 100) / 200).max(1); // 約5ms
        let mut reducer = RtNoiseReducer::prepare(rate)?;
        reducer.set_enabled(true);
        Some(Self {
            reducer,
            settings,
            frame: MixFrame::default(),
            gate_threshold: None,
            aligned: AlignedMix::new(delay, ramp_samples),
            path_enabled: settings.enabled,
            warming: settings.enabled,
            gain: Ramp::new(if settings.enabled { 0.0 } else { 1.0 }, ramp_samples),
        })
    }

    pub(super) fn configure(&mut self, settings: Settings) {
        self.settings = settings;
    }

    pub(super) fn begin_block(&mut self, analysis: Analysis) {
        let base = noise_reduction_mix_from_mode(self.settings.mode, self.settings.strength);
        let protected = analysis.speech && self.settings.voice_guard;
        let wet = match self.settings.mode {
            NoiseControlMode::Smart if analysis.profile_rms.is_some() => {
                (base * 0.55 + analysis.learned_mix * 0.45).clamp(0.0, 1.0)
            }
            NoiseControlMode::Venue if protected => (base * 0.72).clamp(0.0, 1.0),
            NoiseControlMode::Venue => (base * 1.06).clamp(0.0, 1.0),
            _ => base,
        };
        self.frame.wet = if protected { wet.min(0.82) } else { wet };
        self.frame.protect_voice = protected;
        self.gate_threshold = analysis
            .profile_rms
            .filter(|_| {
                !analysis.speech
                    && matches!(
                        self.settings.mode,
                        NoiseControlMode::Smart | NoiseControlMode::Venue
                    )
            })
            .map(|rms| (rms * 2.2).max(0.004));
    }

    /// mute境界や再開で、以前の原音・判定・NR出力を再生しない。
    pub(super) fn reset_state(&mut self) {
        self.reducer.reset_state();
        self.aligned.reset();
        self.path_enabled = self.settings.enabled;
        self.warming = self.path_enabled;
        self.gain.reset(if self.path_enabled { 0.0 } else { 1.0 });
    }

    pub(super) fn process_sample(&mut self, left: f32, right: f32) -> [f32; 2] {
        let input = [finite_audio_sample(left), finite_audio_sample(right)];
        if self.path_enabled != self.settings.enabled {
            self.gain.target(0.0);
            if self.gain.value == 0.0 {
                self.reset_state();
                self.gain.reset(0.0);
            }
        }
        let audio = if self.path_enabled {
            let mut frame = self.frame;
            let gated = self
                .gate_threshold
                .is_some_and(|threshold| input[0].abs().max(input[1].abs()) < threshold);
            frame.dry = input.map(|x| if gated { x * 0.72 } else { x });
            let wet = self.reducer.process_sample(frame.dry[0], frame.dry[1]);
            match self.aligned.process(frame, [wet.0, wet.1]) {
                Some(audio) => {
                    self.warming = false;
                    audio
                }
                None => [0.0; 2],
            }
        } else {
            input
        };
        if self.path_enabled == self.settings.enabled && !self.warming {
            self.gain.target(1.0);
        }
        let gain = self.gain.next();
        audio.map(|x| x * gain)
    }
}

#[cfg(test)]
#[path = "noise_control_tests.rs"]
mod tests;

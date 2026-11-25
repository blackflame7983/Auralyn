use crate::ipc::{MeterLevels, StageReductions};

/// ノイズ低減の段に入った音（遅れをそろえた原音）と出た音の2乗和。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct NoiseEnergy {
    pub before: f32,
    pub after: f32,
    /// 和に含めたフレーム数。左右を1フレームとして数える。
    pub frames: u32,
}

/// 出力 callback が1ブロックごとに送る計測。固定長で、送信は確保もロックもしない。
/// 段が働いていない値は `None` にし、UI が推測で埋めないようにする。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct MeterBlock {
    pub input: [f32; 2],
    pub output: [f32; 2],
    pub processed: Option<[f32; 2]>,
    pub noise: Option<NoiseEnergy>,
    pub voice_gain: Option<f32>,
    pub peak_gain: Option<f32>,
    pub speech: Option<bool>,
}

/// 原音の平均の2乗がこれ未満（約 -70 dBFS）のときは、ノイズ低減の比を出さない。
/// 無音どうしの比は、処理の効きではなく数値の端数になるため。
const NOISE_FLOOR_POWER: f64 = 1.0e-7;

/// 送信周期のあいだに受け取ったピークの最大値と、無音の連続を省く状態。
/// 音声を止めたときと開始のときに初期化し、前の音声の値を次の開始へ持ち越さない（#824）。
#[derive(Debug, Default)]
pub(super) struct MeterAccumulator {
    input: [f32; 2],
    output: [f32; 2],
    processed: Option<[f32; 2]>,
    noise_before: f64,
    noise_after: f64,
    noise_frames: u64,
    voice_gain: Option<f32>,
    peak_gain: Option<f32>,
    speech: Option<bool>,
    updates: u32,
    last_was_zero: bool,
}

fn max_pair(current: &mut [f32; 2], next: [f32; 2]) {
    for (current, next) in current.iter_mut().zip(next) {
        *current = current.max(next);
    }
}

fn min_option(current: Option<f32>, next: Option<f32>) -> Option<f32> {
    match (current, next) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

fn gain_db(gain: Option<f32>) -> Option<f32> {
    gain.map(|gain| 20.0 * gain.clamp(1.0e-6, 1.0).log10())
}

impl MeterAccumulator {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    pub(super) fn push(&mut self, block: &MeterBlock) {
        self.updates = self.updates.saturating_add(1);
        max_pair(&mut self.input, block.input);
        max_pair(&mut self.output, block.output);
        if let Some(next) = block.processed {
            max_pair(self.processed.get_or_insert([0.0; 2]), next);
        }
        if let Some(noise) = block.noise {
            self.noise_before += f64::from(noise.before);
            self.noise_after += f64::from(noise.after);
            self.noise_frames += u64::from(noise.frames);
        }
        self.voice_gain = min_option(self.voice_gain, block.voice_gain);
        self.peak_gain = min_option(self.peak_gain, block.peak_gain);
        if let Some(speech) = block.speech {
            self.speech = Some(self.speech.unwrap_or(false) || speech);
        }
    }

    pub(super) fn has_updates(&self) -> bool {
        self.updates > 0
    }

    fn noise_db(&self) -> Option<f32> {
        // 左右の2チャンネル分の和なので、1サンプルあたりの平均は 2 倍のフレーム数で割る。
        let power = self.noise_before / (self.noise_frames as f64 * 2.0);
        (self.noise_frames > 0 && power >= NOISE_FLOOR_POWER)
            .then(|| (10.0 * (self.noise_after.max(1.0e-20) / self.noise_before).log10()) as f32)
    }

    /// 周期の終わりに、たまった値を返して空にする。無音が続くときは最初の1回だけ返す。
    pub(super) fn take(&mut self) -> Option<MeterLevels> {
        let input = self.input.map(|value| value.clamp(0.0, 10.0));
        let output = self.output.map(|value| value.clamp(0.0, 10.0));
        let processed = self
            .processed
            .map(|pair| pair.map(|value| value.clamp(0.0, 10.0)));
        let reduction_db = StageReductions {
            noise: self.noise_db(),
            voice: gain_db(self.voice_gain),
            peak: gain_db(self.peak_gain),
        };
        let speech = self.speech;
        let is_zero = input
            .iter()
            .chain(output.iter())
            .chain(processed.iter().flatten())
            .all(|value| *value == 0.0);
        let send = !is_zero || !self.last_was_zero;
        let last_was_zero = is_zero;
        *self = Self {
            last_was_zero,
            ..Self::default()
        };
        send.then_some(MeterLevels {
            input,
            output,
            processed,
            reduction_db,
            speech,
        })
    }

    /// 音声データが届かないときに、ゼロを1回だけ返す。
    pub(super) fn idle(&mut self) -> Option<MeterLevels> {
        if self.last_was_zero {
            return None;
        }
        self.last_was_zero = true;
        Some(MeterLevels::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(value: f32) -> MeterBlock {
        MeterBlock {
            input: [value; 2],
            output: [value; 2],
            ..MeterBlock::default()
        }
    }

    fn noise(before: f32, after: f32, frames: u32) -> Option<NoiseEnergy> {
        Some(NoiseEnergy {
            before,
            after,
            frames,
        })
    }

    #[test]
    fn take_sums_noise_energy_and_keeps_the_strongest_gain_reduction() {
        let mut meter = MeterAccumulator::default();
        meter.push(&MeterBlock {
            processed: Some([0.1, 0.3]),
            noise: noise(0.5, 0.05, 256),
            voice_gain: Some(0.5),
            speech: Some(false),
            ..levels(0.4)
        });
        meter.push(&MeterBlock {
            processed: Some([0.2, 0.1]),
            noise: noise(0.5, 0.0, 256),
            voice_gain: Some(0.9),
            peak_gain: Some(1.0),
            speech: Some(true),
            ..levels(0.4)
        });
        let sent = meter.take().expect("音がある周期は送る");
        assert_eq!(sent.processed, Some([0.2, 0.3]));
        // 2乗和の比 0.05 / 1.0 は -13 dB。ブロックごとの比の最小ではない。
        let noise_db = sent.reduction_db.noise.expect("原音が床より大きい");
        assert!((noise_db - -13.0103).abs() < 1.0e-3, "{noise_db}");
        let voice_db = sent.reduction_db.voice.expect("声を整えるが働いた");
        assert!((voice_db - -6.0206).abs() < 1.0e-3, "{voice_db}");
        assert_eq!(sent.reduction_db.peak, Some(0.0));
        assert_eq!(sent.speech, Some(true));
        // 次の周期へ持ち越さない。
        meter.push(&levels(0.4));
        let next = meter.take().expect("音がある周期は送る");
        assert_eq!(next.processed, None);
        assert!(next.reduction_db.is_empty());
        assert_eq!(next.speech, None);
    }

    #[test]
    fn noise_reduction_below_the_floor_or_without_frames_is_not_reported() {
        let mut meter = MeterAccumulator::default();
        // 平均の2乗 1e-8（約 -80 dBFS）は床より小さい。
        meter.push(&MeterBlock {
            noise: noise(2.0e-8 * 100.0, 0.0, 100),
            ..levels(0.01)
        });
        assert_eq!(meter.take().and_then(|l| l.reduction_db.noise), None);
        meter.push(&MeterBlock {
            noise: noise(0.0, 0.0, 0),
            ..levels(0.01)
        });
        assert_eq!(meter.take().and_then(|l| l.reduction_db.noise), None);
    }

    #[test]
    fn processed_signal_alone_keeps_the_period_from_being_skipped_as_silence() {
        let mut meter = MeterAccumulator::default();
        meter.push(&levels(0.0));
        assert!(meter.take().is_some());
        meter.push(&MeterBlock {
            processed: Some([0.2, 0.2]),
            ..levels(0.0)
        });
        assert_eq!(meter.take().and_then(|l| l.processed), Some([0.2, 0.2]));
    }

    #[test]
    fn take_keeps_peak_and_suppresses_repeated_zero() {
        let mut meter = MeterAccumulator::default();
        meter.push(&levels(0.2));
        meter.push(&levels(0.5));
        assert_eq!(meter.take().map(|l| l.input), Some([0.5; 2]));
        meter.push(&levels(0.0));
        assert!(meter.take().is_some());
        meter.push(&levels(0.0));
        assert!(meter.take().is_none());
        assert!(meter.idle().is_none());
    }

    /// 無音が続いてゼロの送信を省いている状態で、前の音声のピークも残っているとする。
    fn silent_with_pending_peak(engine: &mut super::super::Engine) {
        engine.meter.push(&levels(0.0));
        assert!(engine.meter.take().is_some());
        engine.meter.push(&levels(0.0));
        assert!(engine.meter.take().is_none());
        engine.meter.push(&levels(0.9));
    }

    fn assert_fresh(engine: &mut super::super::Engine) {
        // 前の音声の 0.9 を送らず、無音で始めても最初のゼロを1回送る。
        engine.meter.push(&levels(0.0));
        assert_eq!(engine.meter.take().map(|l| l.output), Some([0.0; 2]));
    }

    #[test]
    fn starting_a_stream_does_not_carry_previous_meter_state() {
        let mut engine = super::super::Engine::new();
        silent_with_pending_peak(&mut engine);
        let _producer = engine.prepare_meter_channel();
        assert!(engine.level_rx.is_some());
        assert_fresh(&mut engine);
    }

    #[test]
    fn stopping_a_stream_does_not_carry_previous_meter_state() {
        let mut engine = super::super::Engine::new();
        silent_with_pending_peak(&mut engine);
        engine.clear_audio_resources();
        assert!(engine.level_rx.is_none());
        assert_fresh(&mut engine);
    }
}

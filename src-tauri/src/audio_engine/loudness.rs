//! 最終出力の短時間（3秒）K-weighted loudnessと4倍補間ピーク。
//! 固定配列のみを使い、音声コールバックで割当・ロック・IPCを行わない。
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct LoudnessReading {
    pub id: u64,
    pub ready: bool,
    pub silent: bool,
    pub supported: bool,
    pub short_term_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}
impl Biquad {
    fn sample(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        // 発話後の無音で極小値が残り、非正規化数の演算コストが増えるのを防ぐ。
        // 測定器の内部状態だけを丸め、出力音声には触れない（約−600dB以下）。
        if self.z.iter().all(|z| z.abs() < 1e-30) {
            self.z = [0.0; 2];
        }
        y
    }
}

// ITU-R BS.1770-5 Annex 2 の4相・12タップ。係数の和の利得は1。
const FIR: [[f64; 4]; 12] = [
    [
        0.001708984375,
        -0.0291748046875,
        -0.0189208984375,
        -0.00830078125,
    ],
    [0.010986328125, 0.029296875, 0.0330810546875, 0.014892578125],
    [
        -0.0196533203125,
        -0.0517578125,
        -0.0582275390625,
        -0.026611328125,
    ],
    [0.033203125, 0.089111328125, 0.1015625, 0.047607421875],
    [
        -0.0594482421875,
        -0.16650390625,
        -0.2003173828125,
        -0.102294921875,
    ],
    [
        0.1373291015625,
        0.465087890625,
        0.77978515625,
        0.97216796875,
    ],
    [
        0.97216796875,
        0.77978515625,
        0.465087890625,
        0.1373291015625,
    ],
    [
        -0.102294921875,
        -0.2003173828125,
        -0.16650390625,
        -0.0594482421875,
    ],
    [0.047607421875, 0.1015625, 0.089111328125, 0.033203125],
    [
        -0.026611328125,
        -0.0582275390625,
        -0.0517578125,
        -0.0196533203125,
    ],
    [0.014892578125, 0.0330810546875, 0.029296875, 0.010986328125],
    [
        -0.00830078125,
        -0.0189208984375,
        -0.0291748046875,
        0.001708984375,
    ],
];

pub struct LoudnessMeter {
    filters: [[Biquad; 2]; 2],
    delay: [[f64; 12]; 2],
    delay_index: usize,
    energies: [f64; 30],
    peaks: [f64; 30],
    block_index: usize,
    blocks: usize,
    frames_per_block: usize,
    frames: usize,
    energy: f64,
    peak: f64,
    pub id: Option<u64>,
    supported: bool,
}

impl LoudnessMeter {
    pub fn new(rate: u32) -> Self {
        let fs = rate.max(8000) as f64;
        // BS.1770 K-weighting。48kHz以外への係数変換はlibebur128の式に従う。
        let k = (std::f64::consts::PI * 1681.974450955533 / fs).tan();
        let q = 0.7071752369554196;
        let vh = 10.0f64.powf(3.999843853973347 / 20.0);
        let vb = vh.powf(0.4996667741545416);
        let a0 = 1.0 + k / q + k * k;
        let shelf = Biquad {
            b: [
                (vh + vb * k / q + k * k) / a0,
                2.0 * (k * k - vh) / a0,
                (vh - vb * k / q + k * k) / a0,
            ],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            z: [0.0; 2],
        };
        let k = (std::f64::consts::PI * 38.13547087602444 / fs).tan();
        let q = 0.5003270373238773;
        let a0 = 1.0 + k / q + k * k;
        let high_pass = Biquad {
            b: [1.0, -2.0, 1.0],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            z: [0.0; 2],
        };
        Self {
            filters: [[shelf, high_pass]; 2],
            delay: [[0.0; 12]; 2],
            delay_index: 0,
            energies: [0.0; 30],
            peaks: [0.0; 30],
            block_index: 0,
            blocks: 0,
            frames_per_block: (rate as usize / 10).max(1),
            frames: 0,
            energy: 0.0,
            peak: 0.0,
            id: None,
            supported: (44100..=192000).contains(&rate),
        }
    }

    pub fn reset(&mut self, id: Option<u64>) {
        for channel in &mut self.filters {
            for f in channel {
                f.z = [0.0; 2];
            }
        }
        self.delay = [[0.0; 12]; 2];
        self.delay_index = 0;
        self.energies.fill(0.0);
        self.peaks.fill(0.0);
        self.block_index = 0;
        self.blocks = 0;
        self.frames = 0;
        self.energy = 0.0;
        self.peak = 0.0;
        self.id = id;
    }

    /// デバイスへ渡す、ゲイン・ミュート・チャンネル選択後のサンプルのみを渡す。
    pub fn sample(&mut self, stereo: [f32; 2]) -> Option<LoudnessReading> {
        let id = self.id?;
        if stereo.iter().any(|x| !x.is_finite()) {
            self.reset(Some(id));
            return Some(self.reading());
        }
        if self.supported {
            for (ch, x) in stereo.into_iter().enumerate() {
                let x = x as f64;
                let y = self.filters[ch][0].sample(x);
                let y = self.filters[ch][1].sample(y);
                self.energy += y * y;
                self.delay[ch][self.delay_index] = x;
                self.peak = self.peak.max(x.abs());
                for phase in 0..4 {
                    let mut v = 0.0;
                    for (tap, coeff) in FIR.iter().enumerate() {
                        v += coeff[phase] * self.delay[ch][(self.delay_index + 12 - tap) % 12];
                    }
                    self.peak = self.peak.max(v.abs());
                }
            }
            self.delay_index = (self.delay_index + 1) % 12;
        }
        self.frames += 1;
        if self.frames < self.frames_per_block {
            return None;
        }
        self.energies[self.block_index] = self.energy / self.frames as f64;
        self.peaks[self.block_index] = self.peak;
        self.block_index = (self.block_index + 1) % 30;
        self.blocks = (self.blocks + 1).min(30);
        self.frames = 0;
        self.energy = 0.0;
        self.peak = 0.0;
        Some(self.reading())
    }

    fn reading(&self) -> LoudnessReading {
        let active = self.energies.iter().filter(|e| **e > 1e-6).count();
        let recent = (0..4)
            .map(|i| self.energies[(self.block_index + 29 - i) % 30])
            .sum::<f64>()
            / 4.0;
        let silent = recent < 1e-6;
        let ready = self.supported && self.blocks == 30 && active >= 10 && !silent;
        let energy = self.energies.iter().sum::<f64>() / 30.0;
        let peak = self.peaks.iter().copied().fold(0.0f64, f64::max);
        LoudnessReading {
            id: self.id.unwrap_or(0),
            ready,
            silent,
            supported: self.supported,
            short_term_lufs: if ready {
                Some(-0.691 + 10.0 * energy.log10())
            } else {
                None
            },
            true_peak_dbtp: if peak > 0.0 {
                Some(20.0 * peak.log10())
            } else {
                None
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_overload_has_peak_before_loudness_is_ready() {
        let mut m = LoudnessMeter::new(48000);
        m.reset(Some(9));
        let mut overload = false;
        for i in 0..48000 * 4 {
            let x = if i < 24000 {
                0.99 * (std::f32::consts::FRAC_PI_2 * i as f32 + std::f32::consts::FRAC_PI_4).sin()
            } else {
                0.0
            };
            if let Some(r) = m.sample([x; 2]) {
                assert!(!r.ready);
                assert!(r.short_term_lufs.is_none());
                overload |= r.true_peak_dbtp.is_some_and(|peak| peak > -1.0);
            }
        }
        assert!(overload);
        assert!(m.reading().true_peak_dbtp.is_none());
    }
    #[test]
    fn speech_tail_does_not_leave_subnormal_filter_state() {
        let mut m = LoudnessMeter::new(48000);
        m.reset(Some(1));
        m.sample([0.1; 2]);
        for _ in 0..48000 * 4 {
            m.sample([0.0; 2]);
        }
        assert!(m.filters.iter().flatten().all(|f| f.z == [0.0; 2]));
        assert!(m.reading().silent);
        assert!(!m.reading().ready);
    }
    #[test]
    fn mixed_frequency_stereo_matches_ffmpeg_reference() {
        let mut m = LoudnessMeter::new(48000);
        m.reset(Some(1));
        let mut r = None;
        // FFmpeg ebur128=peak=true、同じ80/800/6000Hz合成波4秒:
        // 最後のS=-20.3 LUFS、true peak=-15.1 dBFS（表示精度0.1dB）。
        for i in 0..192000 {
            let t = i as f64 / 48000.0;
            let x = (0.03 * (2.0 * std::f64::consts::PI * 80.0 * t).sin()
                + 0.1 * (2.0 * std::f64::consts::PI * 800.0 * t).sin()
                + 0.05 * (2.0 * std::f64::consts::PI * 6000.0 * t).sin())
                as f32;
            r = m.sample([x, x * 0.5]).or(r);
        }
        let r = r.unwrap();
        assert!((r.short_term_lufs.unwrap() + 20.3).abs() < 0.1, "{r:?}");
        assert!((r.true_peak_dbtp.unwrap() + 15.1).abs() < 0.3, "{r:?}");
    }
    #[test]
    fn processing_and_reset_do_not_allocate_or_free() {
        let mut m = LoudnessMeter::new(48000);
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            m.reset(Some(3));
            for _ in 0..48000 {
                std::hint::black_box(m.sample([0.02, -0.02]));
            }
            m.reset(None);
        });
        assert_eq!(counts, (0, 0));
    }
    fn sine(rate: u32, amp: f32) -> LoudnessReading {
        let mut m = LoudnessMeter::new(rate);
        m.reset(Some(42));
        let mut r = None;
        for i in 0..rate * 4 {
            let x = amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / rate as f32).sin();
            r = m.sample([x, x]).or(r);
        }
        r.expect("100ms updates")
    }
    #[test]
    fn calibrated_stereo_sine_and_gain_across_rates() {
        for rate in [44100, 48000, 96000, 192000] {
            // 1kHz stereo, peak -23dBFS: K補正後は約-23LUFS（monoは約-26）。
            let a = sine(rate, 10f32.powf(-23.0 / 20.0));
            assert!(a.ready);
            assert!(
                (a.short_term_lufs.unwrap() + 23.0).abs() < 0.12,
                "rate {rate}: {a:?}"
            );
            let b = sine(rate, 10f32.powf(-17.0 / 20.0));
            assert!((b.short_term_lufs.unwrap() - a.short_term_lufs.unwrap() - 6.0).abs() < 0.02);
            assert!((a.true_peak_dbtp.unwrap() + 23.0).abs() < 0.3);
        }
    }
    #[test]
    fn silence_warmup_reset_and_invalid_samples_are_not_ready() {
        let mut m = LoudnessMeter::new(48000);
        m.reset(Some(1));
        for _ in 0..48000 * 4 {
            if let Some(r) = m.sample([0.0; 2]) {
                assert!(!r.ready);
                assert!(r.short_term_lufs.is_none());
            }
        }
        for _ in 0..48000 * 2 {
            if let Some(r) = m.sample([0.1, -0.1]) {
                assert!(!r.ready);
            }
        }
        m.reset(Some(2));
        assert!(!m.reading().ready);
        assert_eq!(m.reading().id, 2);
        assert!(!m.sample([f32::NAN, 0.0]).unwrap().ready);
        m.reset(None);
        assert!(m.sample([1.0; 2]).is_none());
        assert!(!LoudnessMeter::new(8000).reading().supported);
    }
    #[test]
    fn interpolated_peak_detects_intersample_overload() {
        let mut m = LoudnessMeter::new(48000);
        m.reset(Some(1));
        let mut r = None;
        // fs/4、位相π/4ではサンプルピークより補間ピークが約3dB大きい。
        for i in 0..4800 {
            let x =
                0.9 * (std::f32::consts::FRAC_PI_2 * i as f32 + std::f32::consts::FRAC_PI_4).sin();
            r = m.sample([x, x]).or(r);
        }
        assert!(r.unwrap().true_peak_dbtp.unwrap() > -1.2);
    }
}

use std::f32::consts::PI;

/// テストトーンの安全上限（dBFS）
pub const TEST_TONE_MAX_DBFS: f32 = -12.0;
/// テストトーンのデフォルトレベル（dBFS）
pub const TEST_TONE_DEFAULT_DBFS: f32 = -20.0;

pub fn clamp_level_db(level_db: f32) -> f32 {
    let db = if level_db == 0.0 {
        TEST_TONE_DEFAULT_DBFS
    } else {
        level_db
    };
    db.min(TEST_TONE_MAX_DBFS)
}

pub fn dbfs_to_amplitude(dbfs: f32) -> f32 {
    10.0_f32.powf(dbfs / 20.0)
}

pub fn magnitude_to_db(mag: f32) -> f32 {
    if mag <= 1e-10 {
        -120.0
    } else {
        20.0 * mag.log10()
    }
}

/// Goertzel アルゴリズムで単一周波数の振幅を推定
pub fn goertzel_magnitude(samples: &[f32], sample_rate_hz: u32, target_freq_hz: f32) -> f32 {
    if samples.is_empty() || sample_rate_hz == 0 || target_freq_hz <= 0.0 {
        return 0.0;
    }
    let n = samples.len();
    let k = (0.5 + (n as f64 * target_freq_hz as f64) / sample_rate_hz as f64).floor();
    let w = (2.0 * std::f64::consts::PI * k) / n as f64;
    let coeff = 2.0 * w.cos();
    let mut s1 = 0.0f64;
    let mut s2 = 0.0f64;
    for &sample in samples {
        let x = sample as f64;
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    (power.max(0.0) / n as f64).sqrt() as f32
}

/// 目標周波数の検出（閾値は dBFS）
pub fn goertzel_detect(
    samples: &[f32],
    sample_rate_hz: u32,
    target_freq_hz: f32,
    threshold_db: f32,
) -> (bool, f32) {
    let mag = goertzel_magnitude(samples, sample_rate_hz, target_freq_hz);
    let level_db = magnitude_to_db(mag);
    (level_db >= threshold_db, level_db)
}

/// RT コールバック専用のテストトーン生成（アロケーション / ロック禁止）
pub struct RtTestTone {
    active: bool,
    phase: f32,
    phase_inc: f32,
    amplitude: f32,
    remaining_frames: u64,
    fade_samples: usize,
    fade_samples_left: usize,
    gain: f32,
    gain_target: f32,
    sample_rate_hz: u32,
}

impl RtTestTone {
    pub fn new(sample_rate_hz: u32) -> Self {
        let fade_samples = ((sample_rate_hz as f64 * 0.005).round() as usize).max(1);
        Self {
            active: false,
            phase: 0.0,
            phase_inc: 0.0,
            amplitude: 0.0,
            remaining_frames: 0,
            fade_samples,
            fade_samples_left: 0,
            gain: 0.0,
            gain_target: 0.0,
            sample_rate_hz,
        }
    }

    fn begin_fade_to(&mut self, target: f32) {
        self.gain_target = target.clamp(0.0, 1.0);
        self.fade_samples_left = self.fade_samples;
    }

    fn update_fade(&mut self) -> f32 {
        if self.fade_samples_left > 0 {
            let step =
                (self.gain_target - self.gain) / self.fade_samples_left as f32;
            self.gain += step;
            self.fade_samples_left -= 1;
        } else {
            self.gain = self.gain_target;
            if self.gain <= 0.0001 && self.gain_target <= 0.0001 {
                self.active = false;
                self.remaining_frames = 0;
            }
        }
        self.gain.clamp(0.0, 1.0)
    }

    pub fn start(&mut self, freq_hz: f32, duration_ms: u32, level_db: f32) {
        let level_db = clamp_level_db(level_db);
        let amplitude = dbfs_to_amplitude(level_db);
        let sr = self.sample_rate_hz.max(8_000) as f32;
        self.phase_inc = 2.0 * PI * freq_hz / sr;
        self.amplitude = amplitude;
        self.remaining_frames =
            ((duration_ms as u64 * self.sample_rate_hz as u64) / 1000).max(1);
        self.phase = 0.0;
        self.active = true;
        self.gain = 0.0;
        self.begin_fade_to(1.0);
    }

    pub fn stop(&mut self) {
        if self.active || self.gain > 0.0001 {
            self.begin_fade_to(0.0);
        }
        self.remaining_frames = 0;
    }

    pub fn is_active(&self) -> bool {
        self.active || self.gain > 0.0001 || self.gain_target > 0.0001
    }

    pub fn sample(&mut self) -> (f32, f32) {
        if !self.is_active() {
            return (0.0, 0.0);
        }

        let gain = self.update_fade();
        if gain <= 0.00001 {
            return (0.0, 0.0);
        }

        let s = self.phase.sin() * self.amplitude * gain;
        self.phase += self.phase_inc;
        if self.phase >= 2.0 * PI {
            self.phase -= 2.0 * PI;
        }

        if self.active && self.remaining_frames > 0 {
            self.remaining_frames -= 1;
            if self.remaining_frames == 0 {
                self.begin_fade_to(0.0);
            }
        }

        (s, s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gen_sine(freq_hz: f32, sample_rate: u32, duration_ms: u32, amplitude: f32) -> Vec<f32> {
        let n = (sample_rate as u64 * duration_ms as u64 / 1000) as usize;
        let mut out = Vec::with_capacity(n);
        let inc = 2.0 * PI * freq_hz / sample_rate as f32;
        let mut phase = 0.0f32;
        for _ in 0..n {
            out.push(phase.sin() * amplitude);
            phase += inc;
            if phase >= 2.0 * PI {
                phase -= 2.0 * PI;
            }
        }
        out
    }

    #[test]
    fn goertzel_detects_synthetic_sine() {
        let sr = 48_000u32;
        let amp = dbfs_to_amplitude(-20.0);
        let samples = gen_sine(1000.0, sr, 200, amp);
        let (detected, level_db) = goertzel_detect(&samples, sr, 1000.0, -50.0);
        assert!(detected, "level_db={level_db}");
        assert!(level_db > -40.0);
    }

    #[test]
    fn goertzel_rejects_silence() {
        let samples = vec![0.0f32; 4800];
        let (detected, _) = goertzel_detect(&samples, 48_000, 1000.0, -50.0);
        assert!(!detected);
    }

    #[test]
    fn goertzel_rejects_wrong_frequency() {
        let sr = 48_000u32;
        let amp = dbfs_to_amplitude(-20.0);
        let samples = gen_sine(440.0, sr, 200, amp);
        let (detected, _) = goertzel_detect(&samples, sr, 1000.0, -50.0);
        assert!(!detected);
    }

    #[test]
    fn level_db_clamped_to_max() {
        assert!(clamp_level_db(0.0) <= TEST_TONE_MAX_DBFS);
        assert!(clamp_level_db(0.0) >= TEST_TONE_DEFAULT_DBFS - 0.1);
        assert_eq!(clamp_level_db(-6.0), TEST_TONE_MAX_DBFS);
    }
}

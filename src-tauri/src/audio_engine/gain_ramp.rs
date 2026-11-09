//! 音量の途中変更を、現在値から20 msでつなぐ無割当の線形ランプ。
pub(crate) struct GainRamp {
    current: f32,
    target: f32,
    increment: f32,
    remaining: u32,
    samples: u32,
}

impl GainRamp {
    pub(crate) fn new(initial: f32, rate_hz: u32) -> Self {
        Self {
            current: initial,
            target: initial,
            increment: 0.0,
            remaining: 0,
            samples: (rate_hz as f32 * 0.020).round().max(1.0) as u32,
        }
    }

    pub(crate) fn set_target(&mut self, target: f32) {
        if !target.is_finite() || target == self.target {
            return;
        }
        self.target = target;
        self.increment = (target - self.current) / self.samples as f32;
        self.remaining = self.samples;
    }

    pub(crate) fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.current += self.increment;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            }
        }
        self.current
    }

    pub(crate) fn jump(&mut self, target: f32) {
        if target.is_finite() {
            self.current = target;
            self.target = target;
            self.increment = 0.0;
            self.remaining = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim479_retarget_is_bounded_exact_and_ignores_nonfinite_targets() {
        for rate in [0, 1, 8_000, 44_100, 48_000, 96_000, 192_000] {
            let mut ramp = GainRamp::new(1.0, rate);
            let n = ramp.samples;
            ramp.set_target(0.2);
            let mut previous = 1.0;
            let mut worst = 0.0f32;
            for index in 0..n + n / 3 {
                if index == n / 3 {
                    ramp.set_target(0.8);
                }
                // 同じ目標の再送や無効値で、進行中のランプを再開始しない。
                for target in [ramp.target, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
                    ramp.set_target(target);
                }
                let value = ramp.next();
                worst = worst.max((value - previous).abs());
                assert!((value - previous).abs() <= 1.0 / n as f32 + 2.0e-5);
                previous = value;
            }
            assert_eq!(previous, 0.8);
            assert_eq!(ramp.next(), 0.8);
            assert_eq!(ramp.remaining, 0);
            eprintln!("trim479 gain {rate} Hz: max_step={worst:.9}");
            ramp.set_target(0.0);
            ramp.next();
            ramp.jump(0.6);
            assert_eq!(ramp.next(), 0.6);
            assert_eq!(ramp.remaining, 0);
        }
    }
}

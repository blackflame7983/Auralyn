//! 右の列のメーターの読み。`src/hooks/useMeterLevels.ts` と `src/lib/outputVerdict.ts` の規則を写したもの。
//! 描画から独立させ、時刻を引数で受けて試験できるようにする。

use std::time::{Duration, Instant};

/// 最後のレベルから、更新が止まったとみなすまで（`METER_TIMEOUT_MS`）。
pub const TIMEOUT: Duration = Duration::from_millis(1000);
/// ピークを保持する長さ。保持が切れたら 0.9 倍ずつ下げる。
const PEAK_HOLD: Duration = Duration::from_millis(2000);
/// 黄色の境目と「大きすぎ」の境目（−6 dBFS）。
const LOUD_DB: f32 = -6.0;
/// これ未満の平滑化値を「小さめ」とする（−30 dBFS）。
const QUIET_DB: f32 = -30.0;
/// 目盛りの下端。−60〜0 dBFS を 0〜1 に dB 等間隔で写す（DESIGN.md 10.6）。
const FLOOR_DB: f32 = -60.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Waiting,
    Live,
    Silent,
    Stale,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Low,
    Ok,
    High,
}

#[derive(Clone, Debug)]
pub struct Meter {
    state: State,
    target: [f32; 2],
    levels: [f32; 2],
    peak: [f32; 2],
    received_at: Option<Instant>,
    peak_at: Instant,
}

impl Meter {
    pub fn stopped(now: Instant) -> Self {
        Self {
            state: State::Stopped,
            target: [0.0; 2],
            levels: [0.0; 2],
            peak: [0.0; 2],
            received_at: None,
            peak_at: now,
        }
    }

    fn clear(&mut self, state: State) {
        self.state = state;
        self.target = [0.0; 2];
        self.levels = [0.0; 2];
        self.peak = [0.0; 2];
    }

    pub fn start(&mut self) {
        self.clear(State::Waiting);
    }

    pub fn stop(&mut self) {
        self.clear(State::Stopped);
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// 子から届いた左右の振幅。不正な値は、更新が止まったものとして扱う。
    pub fn receive(&mut self, value: [f32; 2], now: Instant) {
        if self.state == State::Stopped {
            return;
        }
        if !value.iter().all(|n| n.is_finite() && *n >= 0.0) {
            self.clear(State::Stale);
            return;
        }
        self.target = value;
        self.received_at = Some(now);
        self.state = if value.iter().all(|n| *n == 0.0) {
            State::Silent
        } else {
            State::Live
        };
    }

    /// 描画の周期ごとに進める。表示が変わったら `true`。
    pub fn tick(&mut self, now: Instant) -> bool {
        if self.state == State::Live
            && self
                .received_at
                .is_none_or(|at| now.duration_since(at) >= TIMEOUT)
        {
            self.clear(State::Stale);
            return true;
        }
        if !matches!(self.state, State::Live | State::Silent) {
            return false;
        }
        let before = (self.levels, self.peak);
        let decay = now.duration_since(self.peak_at) >= PEAK_HOLD;
        if decay {
            self.peak_at = now;
        }
        for i in 0..2 {
            let target = self.target[i];
            let rate = if target > self.levels[i] { 0.8 } else { 0.4 };
            let next = self.levels[i] + (target - self.levels[i]) * rate;
            self.levels[i] = if target == 0.0 && next < 0.0001 {
                0.0
            } else {
                next
            };
            let held = if decay {
                self.peak[i] * 0.9
            } else {
                self.peak[i]
            };
            let peak = held.max(target);
            self.peak[i] = if target == 0.0 && peak < 0.0001 {
                0.0
            } else {
                peak
            };
        }
        before != (self.levels, self.peak)
    }

    pub fn smoothed(&self) -> f32 {
        self.levels[0].max(self.levels[1])
    }

    pub fn peak(&self) -> f32 {
        self.peak[0].max(self.peak[1])
    }

    /// 右の列の出力の一言。音が流れているときだけ。
    pub fn verdict(&self) -> Option<Verdict> {
        if self.state != State::Live {
            return None;
        }
        if self.peak() >= amplitude(LOUD_DB) {
            Some(Verdict::High)
        } else if self.smoothed() < amplitude(QUIET_DB) {
            Some(Verdict::Low)
        } else {
            Some(Verdict::Ok)
        }
    }
}

fn amplitude(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

pub fn to_dbfs(level: f32) -> f32 {
    if level > 0.0 && level.is_finite() {
        20.0 * level.log10()
    } else {
        f32::NEG_INFINITY
    }
}

/// メーターのバーの長さ（0〜1）。
pub fn position(level: f32) -> f32 {
    let db = to_dbfs(level);
    if !db.is_finite() {
        return 0.0;
    }
    ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
}

/// 黄色の境目（−6 dBFS）の位置。
pub fn warning_position() -> f32 {
    position(amplitude(LOUD_DB))
}

/// 画面に出すピークの数字。負号は U+2212 にそろえる（`formatPeakDbfs`）。
pub fn format_peak(level: f32) -> String {
    let db = to_dbfs(level);
    if !db.is_finite() {
        return "−∞".into();
    }
    format!("{db:.1}").replacen('-', "−", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(value: [f32; 2]) -> (Meter, Instant) {
        let now = Instant::now();
        let mut meter = Meter::stopped(now);
        meter.start();
        meter.receive(value, now);
        (meter, now)
    }

    #[test]
    fn stopped_meter_ignores_levels() {
        let now = Instant::now();
        let mut meter = Meter::stopped(now);
        meter.receive([0.5, 0.5], now);
        assert_eq!(meter.state(), State::Stopped);
        assert_eq!(meter.verdict(), None);
    }

    #[test]
    fn levels_without_update_for_one_second_become_stale() {
        let (mut meter, now) = live([0.5, 0.5]);
        assert!(meter.tick(now + Duration::from_millis(16)));
        assert_eq!(meter.state(), State::Live);
        meter.tick(now + TIMEOUT);
        assert_eq!(meter.state(), State::Stale);
        assert_eq!(meter.peak(), 0.0);
    }

    #[test]
    fn invalid_levels_become_stale() {
        let (mut meter, now) = live([0.5, 0.5]);
        meter.receive([f32::NAN, 0.1], now);
        assert_eq!(meter.state(), State::Stale);
    }

    #[test]
    fn zero_levels_are_silent_without_verdict() {
        let (mut meter, now) = live([0.0, 0.0]);
        meter.tick(now);
        assert_eq!(meter.state(), State::Silent);
        assert_eq!(meter.verdict(), None);
    }

    #[test]
    fn verdict_uses_peak_for_loud_and_smoothed_for_quiet() {
        let (mut loud, now) = live([0.6, 0.0]);
        loud.tick(now);
        assert_eq!(loud.verdict(), Some(Verdict::High));

        let (mut quiet, now) = live([0.01, 0.01]);
        quiet.tick(now);
        assert_eq!(quiet.verdict(), Some(Verdict::Low));

        let (mut ok, now) = live([0.2, 0.2]);
        for i in 0..20 {
            ok.tick(now + Duration::from_millis(16 * i));
        }
        assert_eq!(ok.verdict(), Some(Verdict::Ok));
    }

    #[test]
    fn peak_holds_for_two_seconds_then_decays() {
        let (mut meter, now) = live([0.5, 0.5]);
        meter.tick(now);
        meter.receive([0.1, 0.1], now + Duration::from_millis(500));
        meter.tick(now + Duration::from_millis(500));
        assert_eq!(meter.peak(), 0.5);
        meter.receive([0.1, 0.1], now + PEAK_HOLD);
        meter.tick(now + PEAK_HOLD);
        assert!((meter.peak() - 0.45).abs() < 1e-6);
    }

    #[test]
    fn scale_maps_minus_sixty_to_zero_db_linearly() {
        assert_eq!(position(0.0), 0.0);
        assert_eq!(position(1.0), 1.0);
        assert!((position(amplitude(-30.0)) - 0.5).abs() < 1e-5);
        assert_eq!(position(amplitude(-80.0)), 0.0);
    }

    #[test]
    fn peak_text_uses_minus_sign() {
        assert_eq!(format_peak(0.0), "−∞");
        assert_eq!(format_peak(amplitude(-12.34)), "−12.3");
        assert_eq!(format_peak(1.0), "0.0");
    }
}

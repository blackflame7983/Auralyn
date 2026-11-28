//! メーターの読み。
//! ピークの下がり方だけは変えた：保持が切れたら毎秒 [`PEAK_RELEASE_DB_PER_SEC`] で下げる（写した規則は2秒ごとに0.9倍で、−60 dB まで約2分かかった）。
//! 描画から独立させ、時刻を引数で受けて試験できるようにする。

use std::time::{Duration, Instant};

/// 最後のレベルから、更新が止まったとみなすまで（`METER_TIMEOUT_MS`）。
pub const TIMEOUT: Duration = Duration::from_millis(1000);
/// ピークを保持する長さ。最後にピークが上がった時刻から数える。
const PEAK_HOLD: Duration = Duration::from_millis(2000);
/// 保持が切れたあと、ピークを下げる速さ（dB/秒）。0 dBFS から目盛りの下端まで3秒。
pub const PEAK_RELEASE_DB_PER_SEC: f32 = 20.0;
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
    /// 左右それぞれ、ピークが最後に上がった時刻。
    peak_at: [Instant; 2],
    ticked_at: Instant,
    /// 前の `tick` から状態が変わった。値が変わらなくても描き直すため。
    state_changed: bool,
}

impl Meter {
    pub fn stopped(now: Instant) -> Self {
        Self {
            state: State::Stopped,
            target: [0.0; 2],
            levels: [0.0; 2],
            peak: [0.0; 2],
            received_at: None,
            peak_at: [now; 2],
            ticked_at: now,
            state_changed: false,
        }
    }

    fn set_state(&mut self, state: State) {
        self.state_changed |= self.state != state;
        self.state = state;
    }

    fn clear(&mut self, state: State) {
        self.set_state(state);
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
        self.set_state(if value.iter().all(|n| *n == 0.0) {
            State::Silent
        } else {
            State::Live
        });
    }

    /// 描画の周期ごとに進める。表示（値か状態）が変わったら `true`。
    pub fn tick(&mut self, now: Instant) -> bool {
        let moved = self.advance(now);
        std::mem::take(&mut self.state_changed) || moved
    }

    fn advance(&mut self, now: Instant) -> bool {
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
        let elapsed = now.saturating_duration_since(self.ticked_at).as_secs_f32();
        self.ticked_at = now;
        for i in 0..2 {
            let target = self.target[i];
            let rate = if target > self.levels[i] { 0.8 } else { 0.4 };
            let next = self.levels[i] + (target - self.levels[i]) * rate;
            self.levels[i] = if target == 0.0 && next < 0.0001 {
                0.0
            } else {
                next
            };
            self.peak[i] = if target >= self.peak[i] {
                self.peak_at[i] = now;
                target
            } else if now.saturating_duration_since(self.peak_at[i]) < PEAK_HOLD {
                self.peak[i]
            } else {
                // 保持の時間内だった分は下げない（周期が止まって間隔が空いたとき）。
                let held_until = self.peak_at[i] + PEAK_HOLD;
                let falling = elapsed.min(now.saturating_duration_since(held_until).as_secs_f32());
                release(self.peak[i], falling).max(target)
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

/// 出力の見出しの横の札。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputTag {
    /// ミュート中か、出力音量が 0。音が出ないことを、判定より先に知らせる。
    Muted,
    Verdict(Verdict),
}

/// 出力の札を決める。`volume_zero` は出力音量のスライダーが 0。
pub fn output_tag(muted: bool, volume_zero: bool, output: &Meter) -> Option<OutputTag> {
    if muted || volume_zero {
        Some(OutputTag::Muted)
    } else {
        output.verdict().map(OutputTag::Verdict)
    }
}

/// 保持が切れたピークを `elapsed` 秒ぶん下げる。目盛りの下端より下は 0 にする。
fn release(peak: f32, elapsed: f32) -> f32 {
    let db = to_dbfs(peak) - PEAK_RELEASE_DB_PER_SEC * elapsed;
    if db < FLOOR_DB {
        0.0
    } else {
        amplitude(db)
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

/// 話し声のちょうど良い大きさ（−30〜−6 dBFS）の帯の、下と上の位置。
pub fn comfortable_band() -> (f32, f32) {
    (position(amplitude(QUIET_DB)), warning_position())
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

    #[test]
    fn comfortable_band_sits_between_quiet_and_loud() {
        let (low, high) = comfortable_band();
        assert!((low - 0.5).abs() < 1e-4 && (high - 0.9).abs() < 1e-4);
    }

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

    /// 16ms ごとに `until` まで進め、届く値は `value` のまま。
    fn run(meter: &mut Meter, from: Instant, until: Duration, value: [f32; 2]) {
        let mut at = Duration::ZERO;
        while at < until {
            at += Duration::from_millis(16);
            meter.receive(value, from + at);
            meter.tick(from + at);
        }
    }

    #[test]
    fn peak_holds_for_two_seconds_after_the_last_rise() {
        let (mut meter, now) = live([0.5, 0.5]);
        meter.tick(now);
        run(&mut meter, now, Duration::from_millis(1900), [0.1, 0.1]);
        assert_eq!(meter.peak(), 0.5);
        meter.receive([0.6, 0.1], now + Duration::from_millis(1920));
        meter.tick(now + Duration::from_millis(1920));
        let later = now + Duration::from_millis(1920);
        run(&mut meter, later, Duration::from_millis(1900), [0.1, 0.1]);
        assert_eq!(meter.peak(), 0.6, "上がった時刻から2秒は保持する");
    }

    #[test]
    fn released_peak_falls_at_a_steady_rate() {
        let (mut meter, now) = live([1.0, 1.0]);
        meter.tick(now);
        run(
            &mut meter,
            now,
            PEAK_HOLD + Duration::from_secs(1),
            [0.0, 0.0],
        );
        let db = to_dbfs(meter.peak());
        assert!(
            (-PEAK_RELEASE_DB_PER_SEC - 1.0..=-PEAK_RELEASE_DB_PER_SEC + 1.0).contains(&db),
            "保持のあと1秒で約 {PEAK_RELEASE_DB_PER_SEC} dB 下がる: {db}"
        );
    }

    #[test]
    fn released_peak_reaches_zero_within_three_seconds_of_silence() {
        let (mut meter, now) = live([1.0, 1.0]);
        meter.tick(now);
        run(
            &mut meter,
            now,
            PEAK_HOLD + Duration::from_millis(3100),
            [0.0, 0.0],
        );
        assert_eq!(meter.peak(), 0.0);
        assert_eq!(format_peak(meter.peak()), "−∞");
    }

    #[test]
    fn a_long_gap_between_ticks_releases_only_after_the_hold() {
        let (mut meter, now) = live([1.0, 1.0]);
        meter.tick(now);
        let later = now + PEAK_HOLD + Duration::from_millis(500);
        meter.receive([0.0, 0.0], later);
        meter.tick(later);
        let db = to_dbfs(meter.peak());
        assert!(
            (-11.0..=-9.0).contains(&db),
            "保持のあとの0.5秒分だけ下がる: {db}"
        );
    }

    #[test]
    fn each_channel_holds_its_own_peak() {
        let (mut meter, now) = live([1.0, 0.1]);
        meter.tick(now);
        let later = now + Duration::from_millis(1500);
        meter.receive([0.0, 0.5], later);
        meter.tick(later);
        let after_left_hold = now + PEAK_HOLD + Duration::from_millis(100);
        meter.receive([0.0, 0.0], after_left_hold);
        meter.tick(after_left_hold);
        assert!(meter.peak[0] < 1.0, "左は保持が切れて下がる");
        assert_eq!(meter.peak[1], 0.5, "右は上がった時刻から保持する");
    }

    #[test]
    fn state_change_alone_counts_as_a_change() {
        let now = Instant::now();
        let mut meter = Meter::stopped(now);
        meter.start();
        meter.tick(now);
        meter.receive([0.0, 0.0], now);
        assert!(meter.tick(now), "受信待ちから無音への変化は描き直す");
        assert_eq!(meter.state(), State::Silent);
        assert!(!meter.tick(now + Duration::from_millis(16)));
    }

    #[test]
    fn released_peak_does_not_fall_below_the_current_level() {
        let (mut meter, now) = live([1.0, 1.0]);
        meter.tick(now);
        run(
            &mut meter,
            now,
            PEAK_HOLD + Duration::from_secs(5),
            [0.1, 0.1],
        );
        assert_eq!(meter.peak(), 0.1);
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

    #[test]
    fn output_tag_says_muted_before_any_verdict() {
        let (mut loud, now) = live([0.6, 0.0]);
        loud.tick(now);
        assert_eq!(output_tag(true, false, &loud), Some(OutputTag::Muted));
        assert_eq!(output_tag(false, true, &loud), Some(OutputTag::Muted));
        assert_eq!(
            output_tag(false, false, &loud),
            Some(OutputTag::Verdict(Verdict::High))
        );
        assert_eq!(output_tag(false, false, &Meter::stopped(now)), None);
    }
}

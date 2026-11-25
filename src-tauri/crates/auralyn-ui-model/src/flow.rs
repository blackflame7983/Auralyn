//! 音の流れの帯（DESIGN.md 10.5）。加工前と加工後の音量を重ねて、時間の流れで見せる。
//! `src/components/features/Home/SoundFlow.tsx`・`useSoundFlowCanvas.ts`・`soundFlowDraw.ts` の規則を写したもの。
//! 加工後は、出力音量・ピーク保護・ミュートの前の値（レベル通知の `processed`）を使う。出力のメーターは音量とミュートで変わり、加工の比較にならないため。

use std::collections::VecDeque;

use crate::meter::{Meter, State};

/// 時間の流れで描くサンプルの数。
pub const HISTORY: usize = 96;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub before: f32,
    pub after: f32,
}

/// 帯の描き方。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// 区画ごと出さない（停止中と、開始してからまだ値が届いていないあいだ）。
    Hidden,
    /// 時間の流れで描く。右端に今の位置の線を引く。
    Flowing,
    /// 音は流れているが、動きを減らす設定なので今の値だけを横に伸ばす。
    Still,
    /// 無音。平らな波形と凡例だけを描き、言葉は出さない。
    Flat,
}

#[derive(Clone, Debug)]
pub struct Flow {
    history: VecDeque<Sample>,
    mode: Mode,
}

impl Default for Flow {
    fn default() -> Self {
        Self {
            history: VecDeque::with_capacity(HISTORY),
            mode: Mode::Hidden,
        }
    }
}

impl Flow {
    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// 描くサンプル。古い順。
    pub fn samples(&self) -> impl ExactSizeIterator<Item = Sample> + '_ {
        self.history.iter().copied()
    }

    /// メーターの読みが変わったときに呼ぶ。`before` は入力、`after` は加工後（`processed`）のメーター。
    /// 受信待ち・更新停止になっても、一度値が届いたら停止まで区画を残し、最後の波形を止めて見せる（#644）。
    pub fn update(&mut self, running: bool, before: &Meter, after: &Meter, reduce_motion: bool) {
        let live = running && (before.state() == State::Live || after.state() == State::Live);
        let receiving = live || (running && before.state() == State::Silent);
        if !running || (self.mode == Mode::Hidden && !receiving) {
            self.history.clear();
            self.mode = Mode::Hidden;
            return;
        }
        if !receiving {
            if reduce_motion && self.mode == Mode::Flowing {
                self.keep_last();
                self.mode = Mode::Still;
            }
            return;
        }
        let sample = Sample {
            before: before.smoothed(),
            after: after.smoothed(),
        };
        if live && !reduce_motion {
            if self.mode != Mode::Flowing {
                self.history.clear();
            }
            if self.history.len() == HISTORY {
                self.history.pop_front();
            }
            self.history.push_back(sample);
            self.mode = Mode::Flowing;
        } else {
            self.history.clear();
            self.history.push_back(sample);
            self.mode = if live { Mode::Still } else { Mode::Flat };
        }
    }

    fn keep_last(&mut self) {
        let last = self.history.back().copied();
        self.history.clear();
        self.history.extend(last);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn meter(value: Option<[f32; 2]>, now: Instant) -> Meter {
        let mut meter = Meter::stopped(now);
        if let Some(value) = value {
            meter.start();
            meter.receive(value, now);
            meter.tick(now);
        }
        meter
    }

    #[test]
    fn hidden_while_stopped_and_until_levels_arrive() {
        let now = Instant::now();
        let mut flow = Flow::default();
        flow.update(
            false,
            &meter(Some([0.5; 2]), now),
            &meter(Some([0.5; 2]), now),
            false,
        );
        assert_eq!(flow.mode(), Mode::Hidden);

        let mut waiting = Meter::stopped(now);
        waiting.start();
        flow.update(true, &waiting, &waiting, false);
        assert_eq!(flow.mode(), Mode::Hidden);
        assert_eq!(flow.samples().len(), 0);
    }

    #[test]
    fn live_levels_flow_and_keep_at_most_history_samples() {
        let now = Instant::now();
        let (before, after) = (meter(Some([0.5; 2]), now), meter(Some([0.25; 2]), now));
        let mut flow = Flow::default();
        for _ in 0..HISTORY + 10 {
            flow.update(true, &before, &after, false);
        }
        assert_eq!(flow.mode(), Mode::Flowing);
        assert_eq!(flow.samples().len(), HISTORY);
        let last = flow.samples().last().unwrap();
        assert_eq!(last.before, before.smoothed());
        assert_eq!(last.after, after.smoothed());
    }

    #[test]
    fn after_level_stays_while_output_is_muted() {
        let now = Instant::now();
        let silent_input = meter(Some([0.0; 2]), now);
        let processed = meter(Some([0.3; 2]), now);
        let mut flow = Flow::default();
        flow.update(true, &silent_input, &processed, false);
        assert_eq!(flow.mode(), Mode::Flowing, "加工後が流れていれば描く");
    }

    #[test]
    fn silence_is_a_flat_single_sample() {
        let now = Instant::now();
        let silent = meter(Some([0.0; 2]), now);
        let mut flow = Flow::default();
        flow.update(true, &silent, &silent, false);
        assert_eq!(flow.mode(), Mode::Flat);
        assert_eq!(flow.samples().len(), 1);
    }

    #[test]
    fn stale_levels_freeze_the_last_wave_until_stopped() {
        let now = Instant::now();
        let live = meter(Some([0.5; 2]), now);
        let mut flow = Flow::default();
        flow.update(true, &live, &live, false);
        flow.update(true, &live, &live, false);
        let mut stale = live.clone();
        stale.tick(now + Duration::from_secs(2));
        assert_eq!(stale.state(), State::Stale);
        flow.update(true, &stale, &stale, false);
        assert_eq!(flow.mode(), Mode::Flowing);
        assert_eq!(flow.samples().len(), 2, "最後の波形を止めて残す");

        flow.update(false, &stale, &stale, false);
        assert_eq!(flow.mode(), Mode::Hidden);
    }

    #[test]
    fn reduced_motion_draws_only_the_current_value() {
        let now = Instant::now();
        let live = meter(Some([0.5; 2]), now);
        let mut flow = Flow::default();
        flow.update(true, &live, &live, false);
        flow.update(true, &live, &live, false);
        flow.update(true, &live, &live, true);
        assert_eq!(flow.mode(), Mode::Still);
        assert_eq!(flow.samples().len(), 1);
    }

    #[test]
    fn reduced_motion_while_stale_keeps_only_the_last_value() {
        let now = Instant::now();
        let live = meter(Some([0.5; 2]), now);
        let mut flow = Flow::default();
        flow.update(true, &live, &live, false);
        flow.update(true, &live, &live, false);
        let mut stale = live.clone();
        stale.tick(now + Duration::from_secs(2));
        flow.update(true, &stale, &stale, true);
        assert_eq!(flow.mode(), Mode::Still);
        assert_eq!(flow.samples().len(), 1);
    }
}

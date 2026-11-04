//! VST原音比較の経路変更を無音のcallback境界で行う。
//! 遅延の異なるdry/wetを重ねず、各5 ms以上の短いfadeで波形の段差を抑える。

pub(crate) struct Transition {
    requested: bool,
    bypassed: bool,
    gain: f32,
    start: f32,
    target: f32,
    remaining: usize,
    duration: usize,
    fade_frames: usize,
}

impl Transition {
    pub(crate) fn new(bypassed: bool, sample_rate: u32) -> Self {
        Self {
            requested: bypassed,
            bypassed,
            gain: 1.0,
            start: 1.0,
            target: 1.0,
            remaining: 0,
            duration: 1,
            fade_frames: (sample_rate.div_ceil(200) as usize).max(1),
        }
    }

    pub(crate) fn request(&mut self, bypassed: bool) {
        self.requested = bypassed;
    }

    pub(crate) fn bypassed(&self) -> bool {
        self.bypassed
    }

    pub(crate) fn settled(&self) -> bool {
        self.requested == self.bypassed && self.remaining == 0 && self.gain == 1.0
    }

    fn ramp(&mut self, target: f32, frames: usize) {
        self.start = self.gain;
        self.target = target;
        self.duration = frames;
        self.remaining = frames;
    }

    pub(crate) fn begin_block(&mut self, frames: usize, has_vst: bool) {
        if frames == 0 {
            return;
        }
        if !has_vst {
            // 空ラックでは経路が同じなので音量を下げない。途中で空になったら現在値から戻す。
            self.bypassed = self.requested;
            if self.target != 1.0 {
                self.ramp(1.0, self.fade_frames);
            }
        } else if self.requested != self.bypassed {
            if self.remaining == 0 && self.gain == 0.0 {
                self.bypassed = self.requested;
                self.ramp(1.0, self.fade_frames);
            } else if self.target != 0.0 {
                self.ramp(0.0, self.fade_frames);
            }
        } else if self.target != 1.0 {
            // fade途中の取消も現在の音量から戻し、要求の連打で段差を作らない。
            self.ramp(1.0, self.fade_frames);
        }
        if self.target == 0.0 && self.remaining < frames {
            // 最後のfade-outをblock末尾に揃え、次callbackで無音から経路を変更する。
            self.ramp(0.0, frames);
        }
    }

    fn next_gain(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.gain = self.target
                + (self.start - self.target) * self.remaining as f32 / self.duration as f32;
        }
        self.gain
    }

    pub(crate) fn apply(&mut self, planar: &mut [Vec<f32>], channels: usize, frames: usize) {
        if self.settled() {
            return;
        }
        for i in 0..frames {
            let gain = self.next_gain();
            for channel in planar.iter_mut().take(channels) {
                channel[i] *= gain;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    // wetをdryと逆極性にして、従来の瞬時切替なら2.0の段差になる条件を作る。
    fn block(transition: &mut Transition, frames: usize) -> Vec<f32> {
        transition.begin_block(frames, true);
        let input = if transition.bypassed() { -1.0 } else { 1.0 };
        let mut planar = vec![vec![input; frames], vec![input * 0.5; frames]];
        transition.apply(&mut planar, 2, frames);
        assert!(planar[0]
            .iter()
            .zip(&planar[1])
            .all(|(l, r)| *r == *l * 0.5));
        planar.remove(0)
    }

    #[test]
    fn both_directions_cross_silence_without_a_polarity_step() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            for frames in [32, 127, 480, 1056] {
                let mut transition = Transition::new(false, rate);
                let mut previous = 1.0;
                for requested in [true, false] {
                    transition.request(requested);
                    for _ in 0..200 {
                        for value in block(&mut transition, frames) {
                            assert!(
                                (value - previous).abs()
                                    <= 1.0 / transition.fade_frames as f32 + 1e-6
                            );
                            previous = value;
                        }
                        if transition.settled() {
                            break;
                        }
                    }
                    assert!(transition.settled());
                    assert_eq!(transition.bypassed(), requested);
                    assert_eq!(previous, if requested { -1.0 } else { 1.0 });
                }
            }
        }
    }

    #[test]
    fn rapid_changes_and_variable_blocks_converge_to_the_last_request() {
        let mut transition = Transition::new(false, 48_000);
        let mut previous = 1.0;
        for i in 0..300 {
            transition.request(i < 150 && i % 3 != 0);
            for value in block(&mut transition, [13, 64, 257, 1036][i % 4]) {
                assert!((value - previous).abs() <= 1.0 / 240.0 + 1e-6);
                previous = value;
            }
        }
        assert!(transition.settled());
        assert!(!transition.bypassed());
        assert_eq!(previous, 1.0);
    }

    #[test]
    fn duplicate_requests_do_not_restart_the_fade_and_empty_rack_does_not_dip() {
        let mut transition = Transition::new(false, 48_000);
        for _ in 0..20 {
            transition.request(true);
            block(&mut transition, 64);
        }
        assert!(transition.settled());
        let mut empty = Transition::new(false, 48_000);
        let mut planar = vec![vec![0.25; 480], vec![-0.5; 480]];
        empty.request(true);
        empty.begin_block(480, false);
        empty.apply(&mut planar, 2, 480);
        assert!(empty.settled());
        assert!(empty.bypassed());
        assert!(planar[0].iter().all(|v| *v == 0.25));
        assert!(planar[1].iter().all(|v| *v == -0.5));
    }

    #[test]
    fn startup_and_zero_length_blocks_do_not_fade_or_advance() {
        let mut transition = Transition::new(true, 48_000);
        assert!(transition.settled());
        transition.request(false);
        transition.begin_block(0, true);
        transition.apply(&mut [], 0, 0);
        assert!(transition.bypassed());
        assert!(!transition.settled());
    }

    #[test]
    fn rack_removal_mid_transition_recovers_without_a_gain_step() {
        let mut transition = Transition::new(false, 48_000);
        transition.request(true);
        block(&mut transition, 64);
        let mut previous = transition.gain;
        for _ in 0..10 {
            let mut planar = vec![vec![1.0; 64]];
            transition.begin_block(64, false);
            transition.apply(&mut planar, 1, 64);
            for value in planar.remove(0) {
                assert!((value - previous).abs() <= 1.0 / 240.0 + 1e-6);
                previous = value;
            }
        }
        assert!(transition.settled());
        assert_eq!(previous, 1.0);
    }

    #[test]
    fn fade_processing_and_retargeting_do_not_allocate_or_free() {
        let mut transition = Transition::new(false, 48_000);
        let mut planar = vec![vec![0.25; 1056]; 4];
        assert_eq!(
            allocation_counts(|| {
                for i in 0..100 {
                    transition.request(i % 5 != 0);
                    transition.begin_block(1056, i % 7 != 0);
                    transition.apply(&mut planar, 4, 1056);
                }
            }),
            (0, 0)
        );
    }
}

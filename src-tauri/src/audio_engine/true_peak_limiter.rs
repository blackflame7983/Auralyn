//! 配信用 sink 向けの先読み true-peak 制限。
//!
//! サンプルピーク保護（`peak_protection`）とは別物で、分離した配信用 sink だけに使う。
//! 4倍の短い Hann 窓 sinc でサンプル間の山を見積もり、必要 gain のスライディング最小を
//! 箱型平均で滑らかにする。山が遅延線から出る時点で、その包絡は必要 gain 以下になっている。
//! 係数はここで独自に作る。測定試験の長い 8倍 Blackman とは配列も窓も次数も共有しない。
//!
//! ON/OFF で遅延が変わるときは、短いフェードアウトのあと遅延線を消してから
//! フェードインする。消す前の音を、新しい遅延の先から出さない。
//! 天井の変更はフェードも履歴消去もせず、短い線形ランプだけ行う。ランプ中の必要 gain は
//! 今の天井から計算する。
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

const TAPS: usize = 16;
const ANALYZED: usize = 7;
/// 補間点は履歴の中心にある。最新サンプルから見た群遅延。
const GROUP_DELAY: usize = TAPS - 1 - ANALYZED;
const PHASES: [f64; 3] = [0.25, 0.5, 0.75];
/// 4倍・16 tap が見落とす急な立上りの分だけ、検出に使う天井を下げる。
/// 余裕なしの最悪は 48 kHz の立上りで +0.28 dB。0.20 dB で許容 0.1 dB の内側に入る。
/// 出力の合否は設定した天井で測る。
const GUARD_DB: f32 = 0.20;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub ceiling_db: f32,
    pub release_ms: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            ceiling_db: -1.0,
            release_ms: 100.0,
        }
    }
}

impl Config {
    pub fn validate(self) -> Result<Self, String> {
        if !self.ceiling_db.is_finite()
            || !(-12.0..=-0.1).contains(&self.ceiling_db)
            || !self.release_ms.is_finite()
            || !(20.0..=1000.0).contains(&self.release_ms)
        {
            return Err("配信用 true-peak 制限の天井または復帰時間を確認してください".into());
        }
        Ok(self)
    }

    pub(crate) fn prepare(self, rate: u32) -> Prepared {
        let rate = rate.max(1);
        Prepared {
            enabled: self.enabled,
            ceiling: 10.0f32.powf(self.ceiling_db / 20.0),
            release: (-1.0 / (rate as f32 * self.release_ms / 1000.0)).exp(),
            ramp: 1.0 / (rate as f32 * 0.005).max(1.0),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Prepared {
    enabled: bool,
    ceiling: f32,
    release: f32,
    ramp: f32,
}

/// 包絡を滑らかにする長さ。48 kHz で 1 ms。すべてのレートで 0.5 ms とは限らない。
fn envelope_samples(rate: u32) -> usize {
    let proportional = (f64::from(rate.max(1)) * 0.001).round() as usize;
    proportional.max(GROUP_DELAY)
}

/// 遅延線の長さ。包絡長に補間 FIR の群遅延を足し、ゲインを掛ける位置を山の位置に合わせる。
pub(crate) fn lookahead_samples(rate: u32) -> u32 {
    (envelope_samples(rate) + GROUP_DELAY) as u32
}

/// 設定の ON と、実際に遅延が付く状態を分ける。
/// 分離した配信用 sink があり、かつ有効なときだけ適用する。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub split: bool,
    pub sink: bool,
}

impl Route {
    /// 分離した配信用 sink がある経路。アルゴリズム試験の既定。
    #[cfg(test)]
    pub(crate) const ENGAGED: Self = Self {
        split: true,
        sink: true,
    };
}

pub(crate) fn is_applied(enabled: bool, route: Route) -> bool {
    enabled && route.split && route.sink
}

pub(crate) fn lookahead_ms(rate: u32) -> f64 {
    f64::from(lookahead_samples(rate)) * 1000.0 / f64::from(rate.max(1))
}

pub(crate) struct Shared {
    revision: AtomicU64,
    enabled: AtomicBool,
    ceiling: AtomicU32,
    release: AtomicU32,
    ramp: AtomicU32,
    applied: AtomicU64,
    minimum_gain: AtomicU32,
}

impl Default for Shared {
    fn default() -> Self {
        let prepared = Config::default().prepare(48_000);
        Self {
            revision: AtomicU64::new(0),
            enabled: AtomicBool::new(prepared.enabled),
            ceiling: AtomicU32::new(prepared.ceiling.to_bits()),
            release: AtomicU32::new(prepared.release.to_bits()),
            ramp: AtomicU32::new(prepared.ramp.to_bits()),
            applied: AtomicU64::new(0),
            minimum_gain: AtomicU32::new(1.0f32.to_bits()),
        }
    }
}

impl Shared {
    pub(crate) fn publish(&self, prepared: Prepared) -> u64 {
        let revision = self.revision.load(Ordering::SeqCst).saturating_add(2);
        self.revision.store(revision - 1, Ordering::SeqCst);
        self.enabled.store(prepared.enabled, Ordering::SeqCst);
        self.ceiling
            .store(prepared.ceiling.to_bits(), Ordering::SeqCst);
        self.release
            .store(prepared.release.to_bits(), Ordering::SeqCst);
        self.ramp.store(prepared.ramp.to_bits(), Ordering::SeqCst);
        self.revision.store(revision, Ordering::SeqCst);
        revision
    }

    fn read(&self) -> Option<(u64, Prepared)> {
        let revision = self.revision.load(Ordering::SeqCst);
        if revision & 1 != 0 {
            return None;
        }
        let prepared = Prepared {
            enabled: self.enabled.load(Ordering::SeqCst),
            ceiling: f32::from_bits(self.ceiling.load(Ordering::SeqCst)),
            release: f32::from_bits(self.release.load(Ordering::SeqCst)),
            ramp: f32::from_bits(self.ramp.load(Ordering::SeqCst)),
        };
        (revision == self.revision.load(Ordering::SeqCst)).then_some((revision, prepared))
    }

    pub(crate) fn pending(&self) -> bool {
        self.applied.load(Ordering::Acquire) != self.revision.load(Ordering::Acquire)
    }

    pub(crate) fn status(
        &self,
        config: Config,
        running: bool,
        route: Route,
        rate: u32,
    ) -> Snapshot {
        let minimum = f32::from_bits(self.minimum_gain.swap(1.0f32.to_bits(), Ordering::AcqRel));
        let applied = is_applied(config.enabled, route);
        Snapshot {
            config,
            running,
            pending: running && route.sink && self.pending(),
            applied,
            revision: self.revision.load(Ordering::Acquire).to_string(),
            reduction_db: -20.0 * minimum.max(1.0e-12).log10(),
            added_latency_samples: if applied { lookahead_samples(rate) } else { 0 },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: Config,
    pub running: bool,
    pub pending: bool,
    /// 分離した配信用 sink で、今この設定が遅延を足しているか。
    #[serde(default)]
    pub applied: bool,
    pub revision: String,
    pub reduction_db: f32,
    pub added_latency_samples: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Stable,
    FadeOut,
    /// 遅延を消したあと、新しい音で先読みを埋める間は無音にする。
    Prime,
    FadeIn,
}

pub(crate) struct Rt {
    #[cfg_attr(not(test), allow(dead_code))]
    rate: u32,
    lookahead: usize,
    envelope: usize,
    guard: f32,
    coeff: [[f32; TAPS]; 3],
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    pos: usize,
    /// 単調 deque。直近 L+1 の山の最大を、割当なしで出す。
    peak_age: Vec<u32>,
    peak_value: Vec<f32>,
    peak_head: usize,
    peak_len: usize,
    peak_now: u32,
    /// スライディング最大の履歴。長さは包絡で、箱型平均の入力になる。
    held: Vec<f32>,
    held_write: usize,
    box_sum: f32,
    sum_ceiling: f32,
    sum_refresh: u32,
    hist_l: [f32; TAPS],
    hist_r: [f32; TAPS],
    gain: f32,
    ceiling: f32,
    applied_ceiling: f32,
    release: f32,
    ramp: f32,
    fade_step: f32,
    fade: f32,
    prime_left: u32,
    stage: Stage,
    wet: bool,
    target_enabled: bool,
    route: Route,
    revision: u64,
    minimum: f32,
}

impl Rt {
    pub(crate) fn new(config: Config, rate: u32, route: Route) -> Self {
        let prepared = config.prepare(rate);
        let envelope = envelope_samples(rate);
        let lookahead = envelope + GROUP_DELAY;
        let mut coeff = [[0.0f32; TAPS]; 3];
        for (phase, frac) in PHASES.iter().enumerate() {
            coeff[phase] = design_hann_phase(*frac);
        }
        let applied = is_applied(prepared.enabled, route);
        let guard = 10.0f32.powf(-GUARD_DB / 20.0);
        Self {
            rate,
            lookahead,
            envelope,
            guard,
            coeff,
            delay_l: vec![0.0; lookahead],
            delay_r: vec![0.0; lookahead],
            pos: 0,
            peak_age: vec![0; envelope + 1],
            peak_value: vec![0.0; envelope + 1],
            peak_head: 0,
            peak_len: 0,
            peak_now: 0,
            held: vec![0.0; envelope],
            held_write: 0,
            box_sum: envelope as f32,
            sum_ceiling: prepared.ceiling * guard,
            sum_refresh: 0,
            hist_l: [0.0; TAPS],
            hist_r: [0.0; TAPS],
            gain: 1.0,
            ceiling: prepared.ceiling,
            applied_ceiling: prepared.ceiling,
            release: prepared.release,
            ramp: prepared.ramp,
            fade_step: 2.0 / lookahead.max(2) as f32,
            fade: 1.0,
            prime_left: 0,
            stage: Stage::Stable,
            wet: applied,
            target_enabled: prepared.enabled,
            route,
            revision: 0,
            minimum: 1.0,
        }
    }

    /// 今の経路の遅延。適用されていないときは 0。試験と、切替途中の実遅延の確認に使う。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn added_latency_samples(&self) -> u32 {
        if self.wet {
            self.lookahead as u32
        } else {
            0
        }
    }

    fn desired(&self) -> bool {
        is_applied(self.target_enabled, self.route)
    }

    #[cfg(test)]
    fn applied_gain(&self) -> f32 {
        self.gain
    }

    #[cfg(test)]
    fn current_ceiling(&self) -> f32 {
        self.applied_ceiling
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + (self.delay_l.capacity()
                + self.delay_r.capacity()
                + self.peak_value.capacity()
                + self.held.capacity())
                * std::mem::size_of::<f32>()
            + self.peak_age.capacity() * std::mem::size_of::<u32>()
    }

    pub(crate) fn sync(&mut self, shared: &Shared) {
        if let Some((revision, prepared)) = shared.read() {
            self.revision = revision;
            self.ceiling = prepared.ceiling;
            self.release = prepared.release;
            self.ramp = prepared.ramp;
            self.target_enabled = prepared.enabled;
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn apply_config(&mut self, config: Config) {
        let prepared = config.prepare(self.rate);
        self.ceiling = prepared.ceiling;
        self.release = prepared.release;
        self.ramp = prepared.ramp;
        self.target_enabled = prepared.enabled;
    }

    /// 停止から再開するとき、サンプルをまたいでフェードしてから遅延を消す。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn request_reset(&mut self) {
        if self.stage != Stage::FadeOut {
            self.stage = Stage::FadeOut;
        }
    }

    /// 無音へ落ちた callback で、遅延に残った音を出さない。割当はしない。
    pub(crate) fn reset_audio(&mut self) {
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.peak_age.fill(0);
        self.peak_value.fill(0.0);
        self.held.fill(0.0);
        self.hist_l = [0.0; TAPS];
        self.hist_r = [0.0; TAPS];
        self.pos = 0;
        self.peak_head = 0;
        self.peak_len = 0;
        self.peak_now = 0;
        self.held_write = 0;
        self.box_sum = self.envelope as f32;
        self.sum_ceiling = self.applied_ceiling * self.guard;
        self.sum_refresh = 0;
        self.gain = 1.0;
    }

    /// レート変更で作り直す。制御スレッド専用で、古いサンプルは持たない。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn rebuild(&mut self, rate: u32) {
        let enabled = self.target_enabled;
        let route = self.route;
        let ceiling_db = 20.0 * self.ceiling.max(1.0e-12).log10();
        let release_ms = release_ms_from_coeff(self.release, self.rate);
        *self = Self::new(
            Config {
                enabled,
                ceiling_db,
                release_ms,
            },
            rate,
            route,
        );
    }

    pub(crate) fn process(&mut self, sample: [f32; 2]) -> [f32; 2] {
        self.applied_ceiling = approach(self.applied_ceiling, self.ceiling, self.ramp);
        if (self.stage == Stage::Stable || self.stage == Stage::FadeIn)
            && self.wet != self.desired()
        {
            self.stage = Stage::FadeOut;
        }
        if self.stage == Stage::Stable && !self.wet {
            return sample;
        }
        let finite = sanitize(sample);
        if self.stage == Stage::Prime {
            let _ = self.process_wet(finite);
            self.prime_left = self.prime_left.saturating_sub(1);
            if self.prime_left == 0 {
                self.fade = 0.0;
                self.stage = Stage::FadeIn;
            }
            return [0.0; 2];
        }
        let wet = if self.wet || self.stage != Stage::Stable {
            self.process_wet(finite)
        } else {
            finite
        };
        match self.stage {
            Stage::Stable => wet,
            Stage::Prime => [0.0; 2],
            Stage::FadeOut => {
                self.fade = (self.fade - self.fade_step).max(0.0);
                let source = if self.wet { wet } else { finite };
                let faded = source.map(|value| value * self.fade);
                if self.fade <= 0.0 {
                    self.reset_audio();
                    self.wet = self.desired();
                    if self.wet {
                        self.prime_left = self.lookahead as u32;
                        self.stage = Stage::Prime;
                    } else {
                        self.stage = Stage::FadeIn;
                    }
                }
                faded
            }
            Stage::FadeIn => {
                self.fade = (self.fade + self.fade_step).min(1.0);
                let source = if self.wet { wet } else { finite };
                if self.fade >= 1.0 {
                    self.fade = 1.0;
                    self.stage = Stage::Stable;
                }
                source.map(|value| value * self.fade)
            }
        }
    }

    pub(crate) fn report(&mut self, shared: &Shared) {
        shared
            .minimum_gain
            .fetch_min(self.minimum.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        self.minimum = 1.0;
        if self.stage == Stage::Stable
            && self.wet == self.desired()
            && (self.applied_ceiling - self.ceiling).abs() < 1.0e-5
        {
            shared.applied.store(self.revision, Ordering::Release);
        }
    }

    fn process_wet(&mut self, sample: [f32; 2]) -> [f32; 2] {
        let delayed = [self.delay_l[self.pos], self.delay_r[self.pos]];
        self.push_hist(sample);
        // 補間の中心は GROUP_DELAY だけ過去を見ている。その山に対する必要 gain を、
        // 直近 L+1 の最小（山の最大）から作り、長さ L の箱型平均で滑らかにする。
        let attack = self.attack_envelope(self.estimate());
        self.follow_envelope(attack);
        self.delay_l[self.pos] = sample[0];
        self.delay_r[self.pos] = sample[1];
        self.pos += 1;
        if self.pos == self.lookahead {
            self.pos = 0;
        }
        let gain = self.gain;
        self.minimum = self.minimum.min(gain);
        delayed.map(|value| value * gain)
    }

    /// 今の天井で必要 gain を作り直す。天井ランプの途中でも、過去の山を古い天井のまま使わない。
    fn attack_envelope(&mut self, peak: f32) -> f32 {
        let sliding = self.push_sliding_peak(peak);
        let ceiling = self.applied_ceiling * self.guard;
        let old_peak = self.held[self.held_write];
        self.held[self.held_write] = sliding;
        self.held_write += 1;
        if self.held_write == self.held.len() {
            self.held_write = 0;
        }
        self.sum_refresh = self.sum_refresh.saturating_add(1);
        // 天井が動いたときと、定期的な再計算で、増分和の誤差を消す。
        if (ceiling - self.sum_ceiling).abs() > 1.0e-6 || self.sum_refresh >= self.envelope as u32 {
            let mut sum = 0.0f32;
            for value in &self.held {
                sum += required_gain(ceiling, *value);
            }
            self.box_sum = sum;
            self.sum_ceiling = ceiling;
            self.sum_refresh = 0;
        } else {
            self.box_sum += required_gain(ceiling, sliding) - required_gain(ceiling, old_peak);
        }
        self.box_sum / self.envelope as f32
    }

    fn push_sliding_peak(&mut self, peak: f32) -> f32 {
        let window = self.envelope as u32;
        self.peak_now = self.peak_now.wrapping_add(1);
        let now = self.peak_now;
        while self.peak_len > 0 && now.wrapping_sub(self.peak_age[self.peak_head]) > window {
            self.peak_head += 1;
            if self.peak_head == self.peak_age.len() {
                self.peak_head = 0;
            }
            self.peak_len -= 1;
        }
        while self.peak_len > 0 {
            let back = (self.peak_head + self.peak_len - 1) % self.peak_age.len();
            if self.peak_value[back] <= peak {
                self.peak_len -= 1;
            } else {
                break;
            }
        }
        let back = (self.peak_head + self.peak_len) % self.peak_age.len();
        self.peak_age[back] = now;
        self.peak_value[back] = peak;
        self.peak_len += 1;
        self.peak_value[self.peak_head]
    }

    fn follow_envelope(&mut self, attack: f32) {
        let attack = if attack.is_finite() {
            attack.clamp(0.0, 1.0)
        } else {
            0.0
        };
        if attack < self.gain {
            // 下がる方向は、平滑済みの attack へすぐ従う。release では山を逃さない。
            self.gain = attack;
        } else {
            let released = 1.0 - (1.0 - self.gain) * self.release;
            self.gain = released.min(attack).clamp(0.0, 1.0);
        }
    }

    fn push_hist(&mut self, sample: [f32; 2]) {
        for index in 0..TAPS - 1 {
            self.hist_l[index] = self.hist_l[index + 1];
            self.hist_r[index] = self.hist_r[index + 1];
        }
        self.hist_l[TAPS - 1] = sample[0];
        self.hist_r[TAPS - 1] = sample[1];
    }

    fn estimate(&self) -> f32 {
        let mut peak = self.hist_l[ANALYZED].abs().max(self.hist_r[ANALYZED].abs());
        for phase in &self.coeff {
            let left: f32 = self
                .hist_l
                .iter()
                .zip(phase)
                .map(|(sample, coeff)| sample * coeff)
                .sum();
            let right: f32 = self
                .hist_r
                .iter()
                .zip(phase)
                .map(|(sample, coeff)| sample * coeff)
                .sum();
            peak = peak.max(left.abs()).max(right.abs());
        }
        if peak.is_finite() {
            peak
        } else {
            0.0
        }
    }
}

fn required_gain(ceiling: f32, peak: f32) -> f32 {
    if !ceiling.is_finite() || ceiling <= 0.0 {
        return 0.0;
    }
    if !peak.is_finite() || peak <= ceiling {
        1.0
    } else {
        (ceiling / peak).clamp(0.0, 1.0)
    }
}

fn approach(current: f32, target: f32, step: f32) -> f32 {
    current + (target - current).clamp(-step, step)
}

fn sanitize(sample: [f32; 2]) -> [f32; 2] {
    sample.map(|value| if value.is_finite() { value } else { 0.0 })
}

fn design_hann_phase(frac: f64) -> [f32; TAPS] {
    let mut sum = 0.0f64;
    let mut windowed = [0.0f64; TAPS];
    let width = (TAPS - 1) as f64;
    for (index, slot) in windowed.iter_mut().enumerate() {
        let offset = index as f64 - ANALYZED as f64 - frac;
        let hann = 0.5 - 0.5 * (std::f64::consts::TAU * index as f64 / width).cos();
        let value = hann_sinc(offset) * hann;
        *slot = value;
        sum += value;
    }
    let scale = if sum.abs() < 1.0e-18 { 1.0 } else { 1.0 / sum };
    let mut coeff = [0.0f32; TAPS];
    for (slot, value) in coeff.iter_mut().zip(windowed) {
        *slot = (value * scale) as f32;
    }
    coeff
}

fn hann_sinc(offset: f64) -> f64 {
    if offset.abs() < 1.0e-12 {
        1.0
    } else {
        (std::f64::consts::PI * offset).sin() / (std::f64::consts::PI * offset)
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn release_ms_from_coeff(release: f32, rate: u32) -> f32 {
    let denom = -(rate.max(1) as f32) * release.clamp(1.0e-6, 0.999_999).ln();
    if denom.is_finite() && denom > 0.0 {
        (1000.0 / denom).clamp(20.0, 1000.0)
    } else {
        100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    fn enabled(rate: u32) -> Rt {
        Rt::new(
            Config {
                enabled: true,
                ceiling_db: -1.0,
                release_ms: 100.0,
            },
            rate,
            Route::ENGAGED,
        )
    }

    #[test]
    fn meter_matches_the_analytic_quarter_cycle_peak_and_a_low_sine() {
        let mut meter = TruePeakMeter::new();
        let mut hot = 0.0f64;
        let mut quiet_peak = 0.0f64;
        for index in 0..16_384 {
            let quarter =
                (std::f64::consts::PI * index as f64 / 2.0 + std::f64::consts::FRAC_PI_4).sin();
            let peak = meter.push(quarter);
            if index > 512 {
                hot = hot.max(peak);
            }
        }
        let mut low = TruePeakMeter::new();
        for index in 0..16_384 {
            let sine = (2.0 * std::f64::consts::PI * 100.0 * index as f64 / 48_000.0).sin();
            let peak = low.push(sine);
            if index > 512 {
                quiet_peak = quiet_peak.max(peak);
            }
        }
        let hot_db = 20.0 * hot.log10();
        assert!(
            hot_db.abs() < 0.05,
            "fs/4 45° の真の山は 0 dBFS のはずですが、測定器は {hot_db:.3} dB ({hot:.5}) でした"
        );
        let low_db = 20.0 * quiet_peak.log10();
        assert!(
            low_db.abs() < 0.05,
            "低い正弦の true-peak はサンプルピークにほぼ一致するはずですが {low_db:.3} dB でした"
        );
    }

    #[test]
    fn lookahead_scales_with_rate_and_bypass_adds_no_delay() {
        for (rate, envelope) in [(44_100, 44u32), (48_000, 48), (96_000, 96), (192_000, 192)] {
            assert_eq!(
                lookahead_samples(rate),
                envelope + GROUP_DELAY as u32,
                "{rate} Hz の遅延は包絡 {envelope} に群遅延を足した長さ"
            );
            let mut bypass = Rt::new(Config::default(), rate, Route::ENGAGED);
            assert_eq!(bypass.added_latency_samples(), 0);
            assert_eq!(bypass.process([0.2, -0.4]), [0.2, -0.4]);
            let limited = enabled(rate);
            assert_eq!(limited.added_latency_samples(), lookahead_samples(rate));
            let ms = lookahead_ms(rate);
            let envelope_ms = f64::from(envelope) * 1000.0 / f64::from(rate);
            assert!(
                ms > envelope_ms && ms < envelope_ms + 0.3,
                "{rate} Hz の先読みは包絡 {envelope_ms:.3} ms に群遅延を足して {ms:.3} ms"
            );
        }
    }

    #[test]
    fn under_ceiling_sine_stays_aligned_and_hot_quarter_cycle_beats_sample_peak() {
        let rate = 48_000u32;
        let ceiling = 10.0f32.powf(-1.0 / 20.0) as f64;
        let quiet = render_sine(1_000.0, -20.0, 0.0, rate, Processor::Candidate);
        let latency = lookahead_samples(rate) as usize;
        let mut error = 0.0f64;
        for index in latency + 64..quiet.output.len() {
            error = error.max((quiet.output[index] - quiet.input[index - latency]).abs());
        }
        assert!(error < 1.0e-4, "天井未満の誤差 {error}");

        let bare = render_quarter(2.0, rate, Processor::Bare);
        let sample = render_quarter(2.0, rate, Processor::SamplePeak);
        let candidate = render_quarter(2.0, rate, Processor::Candidate);
        assert!(
            bare.overshoot_db > 6.0,
            "保護なしの fs/4 は大きく超えるはずです: {:.3}",
            bare.overshoot_db
        );
        assert!(
            sample.overshoot_db > 2.5,
            "fs/4 45° では sample-peak 後も約 +3 dB 残ります: {:.3}",
            sample.overshoot_db
        );
        assert!(
            candidate.overshoot_db <= 0.1,
            "候補の超過 {:.3} dB は 0.1 dB を超えています",
            candidate.overshoot_db
        );
        assert!(
            candidate.overshoot_db + 2.0 < sample.overshoot_db,
            "候補 {:.3} dB、サンプルピーク {:.3} dB",
            candidate.overshoot_db,
            sample.overshoot_db
        );
        for rate in [44_100u32, 96_000, 192_000] {
            let sample = render_quarter(2.0, rate, Processor::SamplePeak);
            let candidate = render_quarter(2.0, rate, Processor::Candidate);
            assert!(
                sample.overshoot_db > 2.0,
                "{rate} Hz の sample-peak 超過 {:.3} dB",
                sample.overshoot_db
            );
            assert!(
                candidate.overshoot_db <= 0.1,
                "{rate} Hz の候補超過 {:.3} dB",
                candidate.overshoot_db
            );
        }
        assert!(candidate.output.iter().all(|value| value.is_finite()));
        let _ = ceiling;
    }

    #[test]
    fn switches_ceiling_rate_and_restart_do_not_click_or_replay_old_audio() {
        let mut rt = enabled(48_000);
        let mut previous = 0.0f32;
        for _ in 0..2_000 {
            previous = rt.process([0.75, 0.75])[0];
        }
        let mut worst = 0.0f32;
        rt.apply_config(Config {
            enabled: false,
            ceiling_db: -1.0,
            release_ms: 100.0,
        });
        let mut tail = Vec::new();
        for index in 0..1_200 {
            let sample = rt.process([0.75, 0.75])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
            if index > 800 {
                tail.push(sample);
            }
        }
        assert!(worst < 0.05, "ON→OFF の隣接差 {worst}");
        assert!(
            tail.iter().all(|value| (*value - 0.75).abs() < 1.0e-3),
            "OFF 後は遅延なしの入力そのものになるはずです"
        );

        worst = 0.0;
        rt.apply_config(Config {
            enabled: true,
            ceiling_db: -1.0,
            release_ms: 100.0,
        });
        for _ in 0..2_000 {
            let sample = rt.process([0.75, 0.75])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
        }
        assert!(worst < 0.05, "OFF→ON の隣接差 {worst}");

        for _ in 0..500 {
            previous = rt.process([0.95, 0.95])[0];
        }
        worst = 0.0;
        rt.apply_config(Config {
            enabled: true,
            ceiling_db: -6.0,
            release_ms: 100.0,
        });
        for _ in 0..2_000 {
            let sample = rt.process([0.95, 0.95])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
        }
        assert!(worst < 0.05, "天井変更の隣接差 {worst}");

        worst = 0.0;
        rt.request_reset();
        let mut restarted = Vec::new();
        for index in 0..1_200 {
            let sample = rt.process([0.0, 0.0])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
            if index > 800 {
                restarted.push(sample.abs());
            }
        }
        assert!(worst < 0.05, "再開フェードの隣接差 {worst}");
        assert!(restarted.iter().all(|value| *value < 1.0e-4));

        for _ in 0..500 {
            rt.process([0.8, -0.2]);
        }
        rt.rebuild(96_000);
        let leaked = (0..400)
            .map(|_| rt.process([0.0, 0.0])[0].abs())
            .fold(0.0, f32::max);
        assert!(leaked < 1.0e-5, "レート変更後に古い音 {leaked}");
        assert_eq!(rt.added_latency_samples(), lookahead_samples(96_000));
    }

    #[test]
    fn processing_reports_and_resets_allocate_nothing_and_stay_finite() {
        let shared = Shared::default();
        let mut rt = enabled(48_000);
        let counts = allocation_counts(|| {
            for index in 0..4_000u32 {
                let sample = if index == 10 {
                    [f32::NAN, f32::INFINITY]
                } else {
                    [(index as f32 * 0.01).sin(), 0.2]
                };
                let output = rt.process(sample);
                assert!(output.iter().all(|value| value.is_finite()));
                rt.sync(&shared);
                rt.report(&shared);
                if index == 100 {
                    rt.request_reset();
                }
                if index == 2_000 {
                    rt.reset_audio();
                }
            }
        });
        assert_eq!(counts, (0, 0));
        let mut hot = enabled(48_000);
        for _ in 0..4_000 {
            let output = hot.process([3.0, -2.0]);
            assert!(output
                .iter()
                .all(|value| value.is_finite() && value.abs() <= 1.0));
        }
    }

    #[test]
    fn stereo_link_keeps_ratio_and_rejects_bad_settings() {
        let mut rt = enabled(48_000);
        let mut left = Vec::new();
        let mut right = Vec::new();
        for index in 0..4_000 {
            let phase = std::f64::consts::PI * index as f64 / 2.0 + 0.4;
            let output = rt.process([(phase.sin() as f32) * 1.6, (phase.sin() as f32) * 0.8]);
            if index > 2_000 {
                left.push(output[0] as f64);
                right.push(output[1] as f64);
            }
        }
        let mut ratio_error = 0.0f64;
        for (l, r) in left.iter().zip(&right) {
            if l.abs() > 0.05 {
                ratio_error = ratio_error.max((r / l - 0.5).abs());
            }
        }
        assert!(ratio_error < 1.0e-3, "左右比のずれ {ratio_error}");
        let mut one_sided = enabled(48_000);
        for index in 0..2_000 {
            let sample = (std::f64::consts::PI * index as f64 / 2.0).sin() as f32 * 2.0;
            let output = one_sided.process([sample, 0.0]);
            assert_eq!(output[1], 0.0);
        }
        for config in [
            Config {
                ceiling_db: 0.0,
                ..Config::default()
            },
            Config {
                release_ms: f32::NAN,
                ..Config::default()
            },
            Config {
                release_ms: 10.0,
                ..Config::default()
            },
        ] {
            assert!(config.validate().is_err());
        }
    }

    #[test]
    fn route_application_matches_displayed_latency() {
        let config = Config {
            enabled: true,
            ceiling_db: -12.0,
            release_ms: 20.0,
        };
        let cases = [
            (false, true, false, "分離OFFでsinkあり"),
            (false, false, false, "単一出力"),
            (true, false, false, "分離ONだがsinkなし"),
            (true, true, true, "分離ON"),
        ];
        for (split, sink, expect_applied, label) in cases {
            let route = Route { split, sink };
            let shared = Shared::default();
            let status = shared.status(config, true, route, 48_000);
            let mut rt = Rt::new(config, 48_000, route);
            assert_eq!(status.applied, expect_applied, "{label}");
            assert_eq!(
                status.added_latency_samples,
                rt.added_latency_samples(),
                "{label} の表示遅延と処理器の遅延"
            );
            assert_eq!(
                rt.added_latency_samples(),
                if expect_applied {
                    lookahead_samples(48_000)
                } else {
                    0
                },
                "{label}"
            );
            let mut impulse_at = None;
            for index in 0..2_000 {
                let sample = if index == 80 { 4.0 } else { 0.0 };
                let output = rt.process([sample, 0.0])[0];
                if impulse_at.is_none() && output.abs() > 0.05 {
                    impulse_at = Some(index);
                }
                assert!(output.is_finite(), "{label} の出力 {output}");
                if expect_applied {
                    assert!(output.abs() <= 1.0, "{label} の出力 {output}");
                }
            }
            if expect_applied {
                let at = impulse_at.expect("分離ONではインパルスが減衰して出る");
                assert!(
                    at >= 80 + lookahead_samples(48_000) as usize - 2,
                    "{label} の山は遅延の後に出るはずですが {at}"
                );
                assert!(impulse_at.unwrap() < 80 + lookahead_samples(48_000) as usize + 8);
            } else {
                assert_eq!(impulse_at, Some(80), "{label} は遅延も減衰もしない");
            }
        }
    }

    #[test]
    fn impulses_and_program_signals_stay_inside_the_ceiling() {
        let rates = [44_100u32, 48_000, 96_000, 192_000];
        let ceilings = [-12.0f32, -6.0, -1.0, -0.1];
        let releases = [20.0f32, 100.0, 1000.0];
        let mut worst = f64::NEG_INFINITY;
        let mut worst_label = String::new();
        for rate in rates {
            for ceiling_db in ceilings {
                for release_ms in releases {
                    for amplitude in 1..=10 {
                        let (over, sample_abs) = limit_signal(
                            &single_impulse(amplitude as f32),
                            rate,
                            Config {
                                enabled: true,
                                ceiling_db,
                                release_ms,
                            },
                        );
                        if over > worst {
                            worst = over;
                            worst_label = format!(
                                "{rate} Hz 天井 {ceiling_db} dB release {release_ms} ms 振幅 {amplitude}"
                            );
                        }
                        assert!(over <= 0.1, "{worst_label} の超過 {over:.3} dB");
                        assert!(
                            sample_abs <= 1.0,
                            "{rate} Hz 天井 {ceiling_db} の出力絶対値 {sample_abs}"
                        );
                    }
                }
            }
        }
        eprintln!("単発インパルスの最悪超過: {worst:.3} dB（{worst_label}）");
        for rate in rates {
            for (ceiling_db, release_ms) in [(-1.0, 100.0), (-12.0, 20.0), (-0.1, 20.0)] {
                let config = Config {
                    enabled: true,
                    ceiling_db,
                    release_ms,
                };
                let signals: [(&str, Vec<[f32; 2]>); 6] = [
                    ("fs/4", quarter_frames(2.0)),
                    ("15 kHz 急な立上り", sudden_onset(rate)),
                    ("帯域制限インパルス", bandlimited_impulse(rate)),
                    ("帯域制限雑音", bandlimited_noise(rate)),
                    ("左だけ", one_sided_hot(rate)),
                    ("12 kHz 45°", quarter_frames(1.8)),
                ];
                for (name, signal) in signals {
                    let (over, sample_abs) = limit_signal(&signal, rate, config);
                    assert!(sample_abs <= 1.0, "{name} の出力絶対値 {sample_abs}");
                    if over > worst {
                        worst = over;
                        worst_label = format!(
                            "{name} {rate} Hz 天井 {ceiling_db} dB release {release_ms} ms"
                        );
                    }
                }
            }
        }
        eprintln!("評価信号を含めた最悪超過: {worst:.3} dB（{worst_label}）");
        assert!(worst <= 0.1, "最悪超過 {worst:.3} dB（{worst_label}）");
    }

    #[test]
    fn ceiling_ramp_uses_the_current_ceiling() {
        let mut rt = enabled(48_000);
        let mut meter = TruePeakMeter::new();
        for index in 0..2_000 {
            let frame = quarter_sample(index, 2.0);
            let output = rt.process(frame);
            meter.push(output[0] as f64);
        }
        rt.apply_config(Config {
            enabled: true,
            ceiling_db: -12.0,
            release_ms: 20.0,
        });
        let mut ceilings = Vec::new();
        let mut peaks = Vec::new();
        for index in 0..4_000 {
            let output = rt.process(quarter_sample(index, 2.0));
            assert!(output
                .iter()
                .all(|value| value.is_finite() && value.abs() <= 1.0));
            ceilings.push(f64::from(rt.current_ceiling()));
            peaks.push(meter.push(output[0] as f64));
        }
        let mut worst = f64::NEG_INFINITY;
        for index in 96..peaks.len() {
            let reference = ceilings[index - 64];
            if peaks[index] > 0.0 {
                worst = worst.max(20.0 * (peaks[index] / reference).log10());
            }
        }
        assert!(
            worst <= 0.1,
            "天井ランプ中の超過 {worst:.3} dB。測定器の遅れ分だけ前の天井と比べています"
        );
        let settled = 20.0
            * (peaks.last().copied().unwrap_or(0.0) / ceilings.last().copied().unwrap_or(1.0))
                .log10();
        assert!(settled <= 0.1, "ランプ完了後の超過 {settled:.3} dB");
    }

    fn quarter_sample(index: usize, amplitude: f32) -> [f32; 2] {
        let value = (std::f64::consts::PI * index as f64 / 2.0 + std::f64::consts::FRAC_PI_4).sin()
            as f32
            * amplitude;
        [value, value * 0.5]
    }

    fn quarter_frames(amplitude: f32) -> Vec<[f32; 2]> {
        (0..4_096)
            .map(|index| quarter_sample(index, amplitude))
            .collect()
    }

    fn single_impulse(amplitude: f32) -> Vec<[f32; 2]> {
        let mut input = vec![[0.0; 2]; 1_536];
        input[64] = [amplitude, amplitude * 0.25];
        input
    }

    fn limit_signal(input: &[[f32; 2]], rate: u32, config: Config) -> (f64, f32) {
        let mut rt = Rt::new(config, rate, Route::ENGAGED);
        let mut left = TruePeakMeter::new();
        let mut right = TruePeakMeter::new();
        let ceiling = 10.0f64.powf(f64::from(config.ceiling_db) / 20.0);
        let mut true_peak = 0.0f64;
        let mut sample_abs = 0.0f32;
        for (index, frame) in input.iter().enumerate() {
            let output = rt.process(*frame);
            sample_abs = sample_abs.max(output[0].abs()).max(output[1].abs());
            assert!(output.iter().all(|value| value.is_finite()));
            let peak = left
                .push(output[0] as f64)
                .max(right.push(output[1] as f64));
            if index > 64 {
                true_peak = true_peak.max(peak);
            }
        }
        let overshoot = if true_peak > 0.0 {
            20.0 * (true_peak / ceiling).log10()
        } else {
            -120.0
        };
        (overshoot, sample_abs)
    }

    #[test]
    fn evaluation_table_shows_a_clear_true_peak_reduction() {
        let rate = 48_000u32;
        let mut rows = Vec::new();
        let mut worst_candidate = f64::NEG_INFINITY;
        let mut weak_margin = f64::INFINITY;
        let mut clear_failures = 0u32;
        let mut push_row = |label: &str, metric: [Metric; 3]| {
            worst_candidate = worst_candidate.max(metric[2].overshoot_db);
            if metric[1].overshoot_db > 0.3 {
                clear_failures += 1;
                weak_margin = weak_margin.min(metric[1].overshoot_db - metric[2].overshoot_db);
            }
            let quiet = format!(
                "{} / {}",
                fmt_optional(metric[2].quiet_error),
                fmt_optional(metric[1].quiet_error)
            );
            rows.push(format!(
                "| {label} | {bare:.2} | {sample:.2} | {candidate:.2} | {exceed:.3} | {atten:.2} | {thd} | {quiet} | {bend:.5} |",
                bare = metric[0].overshoot_db,
                sample = metric[1].overshoot_db,
                candidate = metric[2].overshoot_db,
                exceed = metric[2].exceed_ratio * 100.0,
                atten = metric[2].attenuation_db,
                thd = fmt_optional(metric[2].thd),
                quiet = quiet,
                bend = metric[2].bend,
            ));
            assert_metric(label, &metric);
        };
        push_row(
            "12 kHz (fs/4) / 45°",
            [
                render_quarter(1.8, rate, Processor::Bare),
                render_quarter(1.8, rate, Processor::SamplePeak),
                render_quarter(1.8, rate, Processor::Candidate),
            ],
        );
        for (freq, phase) in [
            (11_000.0, 0.0),
            (11_000.0, 45.0),
            (15_000.0, 20.0),
            (15_000.0, 75.0),
            (19_000.0, 10.0),
            (19_000.0, 45.0),
            (19_000.0, 90.0),
        ] {
            let bare = render_tone(freq, phase, 1.8, rate, Processor::Bare);
            let sample = render_tone(freq, phase, 1.8, rate, Processor::SamplePeak);
            let candidate = render_tone(freq, phase, 1.8, rate, Processor::Candidate);
            worst_candidate = worst_candidate.max(candidate.overshoot_db);
            if sample.overshoot_db > 0.3 {
                clear_failures += 1;
                weak_margin = weak_margin.min(sample.overshoot_db - candidate.overshoot_db);
            }
            let label = format!("{freq:.0} Hz / {phase:.0}°");
            let quiet = format!(
                "{} / {}",
                fmt_optional(candidate.quiet_error),
                fmt_optional(sample.quiet_error)
            );
            rows.push(format!(
                "| {label} | {bare:.2} | {sample:.2} | {candidate:.2} | {exceed:.3} | {atten:.2} | {thd} | {quiet} | {bend:.5} |",
                bare = bare.overshoot_db,
                sample = sample.overshoot_db,
                candidate = candidate.overshoot_db,
                exceed = candidate.exceed_ratio * 100.0,
                atten = candidate.attenuation_db,
                thd = fmt_optional(candidate.thd),
                quiet = quiet,
                bend = candidate.bend,
            ));
            assert_metric(&label, &[bare, sample, candidate]);
        }
        let impulse = render_custom(&bandlimited_impulse(48_000), rate);
        let noise = render_custom(&bandlimited_noise(48_000), rate);
        let onset = render_custom(&sudden_onset(48_000), rate);
        let one_sided = render_custom(&one_sided_hot(48_000), rate);
        eprintln!("評価（48 kHz、天井 -1 dBFS、超過は測定器の true-peak）");
        eprintln!("| 信号 | 保護なし dB | sample-peak dB | 候補 dB | 候補の超過率 % | 候補の平均減衰 dB | 候補 THD | 天井未満の相対誤差 候補/sample-peak | 候補の折れ残差 |");
        for row in &rows {
            eprintln!("{row}");
        }
        for (name, metric) in [
            ("帯域制限インパルス", impulse),
            ("帯域制限雑音", noise),
            ("急な立上り", onset),
            ("左だけの過大音", one_sided),
        ] {
            eprintln!(
                "| {name} | {:.2} | {:.2} | {:.2} | {:.3} | {:.2} | {} | {} / {} | {:.5} |",
                metric[0].overshoot_db,
                metric[1].overshoot_db,
                metric[2].overshoot_db,
                metric[2].exceed_ratio * 100.0,
                metric[2].attenuation_db,
                fmt_optional(metric[2].thd),
                fmt_optional(metric[2].quiet_error),
                fmt_optional(metric[1].quiet_error),
                metric[2].bend
            );
            assert_metric(name, &metric);
            worst_candidate = worst_candidate.max(metric[2].overshoot_db);
            if metric[1].overshoot_db > 0.3 {
                clear_failures += 1;
                weak_margin = weak_margin.min(metric[1].overshoot_db - metric[2].overshoot_db);
            }
        }
        let mut latency = String::new();
        for rate in [44_100u32, 48_000, 96_000, 192_000] {
            let samples = lookahead_samples(rate);
            latency.push_str(&format!(
                "{rate} Hz: {samples} sample / {:.3} ms\n",
                lookahead_ms(rate)
            ));
        }
        eprintln!("{latency}");
        let memory = enabled(48_000).retained_bytes();
        eprintln!("保持メモリ（48 kHz）: {memory} bytes");
        assert!(
            worst_candidate <= 0.1,
            "最大超過 {worst_candidate:.3} dB。表は --nocapture を参照"
        );
        assert!(
            clear_failures > 0,
            "sample-peak が超過する比較信号がありません"
        );
        assert!(
            weak_margin > 0.5,
            "sample-peak が超過する信号での改善が小さいです: {weak_margin:.3} dB"
        );
        let _ = rows;
    }

    #[test]
    #[ignore]
    fn bench_one_second_against_sample_peak() {
        let (candidate_ms, sample_ms, ratio) = debug_cpu_median(5);
        eprintln!(
            "CPU中央値（debug、5回、他の試験と分けて測る。release は未測定）: 候補 {candidate_ms:.1} ms / sample-peak {sample_ms:.1} ms / 比 {ratio:.2}"
        );
        assert!(ratio < 12.0, "CPU比 {ratio:.2}");
    }

    fn debug_cpu_median(runs: usize) -> (f64, f64, f64) {
        let rate = 48_000usize;
        let mut signal = vec![[0.0f32; 2]; rate];
        for (index, frame) in signal.iter_mut().enumerate() {
            let value =
                (2.0 * std::f64::consts::PI * 19_000.0 * index as f64 / rate as f64).sin() as f32;
            *frame = [value * 1.5, value * -1.2];
        }
        let mut ratios = Vec::with_capacity(runs);
        let mut candidate_ms = Vec::with_capacity(runs);
        let mut sample_ms = Vec::with_capacity(runs);
        for _ in 0..runs {
            let mut candidate = enabled(rate as u32);
            let mut sample = super::super::peak_protection::Rt::new(
                super::super::peak_protection::Config {
                    enabled: true,
                    ceiling_db: -1.0,
                    release_ms: 100.0,
                },
                rate as u32,
            );
            let candidate_time = time_processor(&mut signal, |frame| {
                candidate.process(frame);
            });
            let sample_time = time_processor(&mut signal, |frame| {
                sample.process(frame);
            });
            let candidate = candidate_time.as_secs_f64() * 1000.0;
            let sample = sample_time.as_secs_f64() * 1000.0;
            ratios.push(candidate / sample.max(1.0e-9));
            candidate_ms.push(candidate);
            sample_ms.push(sample);
        }
        (
            median(&mut candidate_ms),
            median(&mut sample_ms),
            median(&mut ratios),
        )
    }

    fn median(values: &mut [f64]) -> f64 {
        values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
        values[values.len() / 2]
    }

    fn time_processor(
        signal: &mut [[f32; 2]],
        mut process: impl FnMut([f32; 2]),
    ) -> std::time::Duration {
        let start = std::time::Instant::now();
        for frame in signal.iter().copied() {
            process(std::hint::black_box(frame));
        }
        start.elapsed()
    }

    #[derive(Clone, Copy)]
    enum Processor {
        Bare,
        SamplePeak,
        Candidate,
    }

    struct Metric {
        overshoot_db: f64,
        exceed_ratio: f64,
        attenuation_db: f64,
        /// 正弦だけ測る。過渡は None で、0 にはしない。
        thd: Option<f64>,
        /// 天井未満の区間で、遅延を揃えた入力との相対誤差。静かな区間が足りなければ None。
        quiet_error: Option<f64>,
        /// 出力と「遅延入力 × 適用ゲイン」の差。純ゲインならほぼ 0。
        bend: f64,
        full_scale_peak: f64,
        output: Vec<f64>,
        input: Vec<f64>,
    }

    fn fmt_optional(value: Option<f64>) -> String {
        match value {
            Some(value) => format!("{value:.3}"),
            None => "未測定".to_string(),
        }
    }

    fn assert_metric(label: &str, metric: &[Metric; 3]) {
        assert!(
            metric[2].overshoot_db <= 0.1,
            "{label} の超過 {:.3} dB",
            metric[2].overshoot_db
        );
        assert!(
            metric[2].full_scale_peak <= 1.0,
            "{label} の出力絶対値 {:.4}",
            metric[2].full_scale_peak
        );
        assert!(
            metric[2].bend < 1.0e-3,
            "{label} の折れ残差 {:.5}。ゲイン以外で波形を折っています",
            metric[2].bend
        );
        if let Some(thd) = metric[2].thd {
            assert!(
                thd < 0.02,
                "{label} の THD 相当 {thd:.4} が正弦の採否 0.02 を超えています"
            );
        }
    }

    fn render_sine(
        freq: f64,
        level_db: f64,
        phase_deg: f64,
        rate: u32,
        processor: Processor,
    ) -> Metric {
        let amplitude = 10.0f64.powf(level_db / 20.0);
        render_tone(freq, phase_deg, amplitude as f32, rate, processor)
    }

    fn render_quarter(amplitude: f32, rate: u32, processor: Processor) -> Metric {
        let input: Vec<[f32; 2]> = (0..8_192)
            .map(|index| {
                let value = (std::f64::consts::PI * index as f64 / 2.0
                    + std::f64::consts::FRAC_PI_4)
                    .sin() as f32
                    * amplitude;
                [value, value * 0.5]
            })
            .collect();
        measure(&input, rate, processor, Some(rate as f64 / 4.0))
    }

    fn render_tone(
        freq: f64,
        phase_deg: f64,
        amplitude: f32,
        rate: u32,
        processor: Processor,
    ) -> Metric {
        let input: Vec<[f32; 2]> = (0..8_192)
            .map(|index| {
                let phase = 2.0 * std::f64::consts::PI * freq * index as f64 / rate as f64
                    + phase_deg * std::f64::consts::PI / 180.0;
                let value = phase.sin() as f32 * amplitude;
                [value, -value]
            })
            .collect();
        measure(&input, rate, processor, Some(freq))
    }

    fn render_custom(input: &[[f32; 2]], rate: u32) -> [Metric; 3] {
        [
            measure(input, rate, Processor::Bare, None),
            measure(input, rate, Processor::SamplePeak, None),
            measure(input, rate, Processor::Candidate, None),
        ]
    }

    fn measure(input: &[[f32; 2]], rate: u32, processor: Processor, freq: Option<f64>) -> Metric {
        let mut meter = TruePeakMeter::new();
        let ceiling = 10.0f64.powf(-1.0 / 20.0);
        let latency = match processor {
            Processor::Candidate => lookahead_samples(rate) as usize,
            _ => 0,
        };
        let mut candidate = enabled(rate);
        let mut sample_peak = super::super::peak_protection::Rt::new(
            super::super::peak_protection::Config {
                enabled: true,
                ..Default::default()
            },
            rate,
        );
        let skip = latency + 128;
        let mut max_abs = 0.0f64;
        let mut exceed = 0u64;
        let mut points = 0u64;
        let mut output = Vec::with_capacity(input.len());
        let mut dry = Vec::with_capacity(input.len());
        let mut gains = Vec::with_capacity(input.len());
        let mut full_scale_peak = 0.0f64;
        let mut out_sq = 0.0f64;
        let mut in_sq = 0.0f64;
        let mut counted = 0u64;
        for (index, frame) in input.iter().enumerate() {
            let processed = match processor {
                Processor::Bare => *frame,
                Processor::SamplePeak => sample_peak.process(*frame),
                Processor::Candidate => candidate.process(*frame),
            };
            let applied = match processor {
                Processor::Bare => 1.0,
                Processor::SamplePeak => f64::from(sample_peak.applied_gain()),
                Processor::Candidate => f64::from(candidate.applied_gain()),
            };
            output.push(processed[0] as f64);
            dry.push(frame[0] as f64);
            gains.push(applied);
            full_scale_peak = full_scale_peak
                .max(processed[0].abs() as f64)
                .max(processed[1].abs() as f64);
            if index < skip {
                meter.push(processed[0] as f64);
                continue;
            }
            let oversampled = meter.push_points(processed[0] as f64);
            for value in oversampled {
                max_abs = max_abs.max(value.abs());
                points += 1;
                if value.abs() > ceiling * 10.0f64.powf(0.001 / 20.0) {
                    exceed += 1;
                }
            }
            let aligned = input[index - latency][0] as f64;
            out_sq += (processed[0] as f64) * (processed[0] as f64);
            in_sq += aligned * aligned;
            counted += 1;
        }
        let overshoot_db = if max_abs > 0.0 {
            20.0 * (max_abs / ceiling).log10()
        } else {
            -120.0
        };
        let attenuation_db = if counted > 0 && in_sq > 0.0 {
            10.0 * (out_sq / in_sq).log10()
        } else {
            0.0
        };
        Metric {
            overshoot_db,
            exceed_ratio: if points == 0 {
                0.0
            } else {
                exceed as f64 / points as f64
            },
            attenuation_db,
            thd: freq.and_then(|freq| residual_ratio(&output[skip..], freq, rate)),
            quiet_error: quiet_relative_error(&output, &dry, latency, ceiling),
            bend: gain_residual(&output, &dry, &gains, skip, latency),
            full_scale_peak,
            output,
            input: dry,
        }
    }

    fn quiet_relative_error(
        output: &[f64],
        input: &[f64],
        latency: usize,
        ceiling: f64,
    ) -> Option<f64> {
        let mut error = 0.0;
        let mut energy = 0.0;
        let mut count = 0usize;
        for index in latency..output.len() {
            let dry = input[index - latency];
            let magnitude = dry.abs();
            if magnitude < ceiling && magnitude > 1.0e-4 {
                let delta = output[index] - dry;
                error += delta * delta;
                energy += magnitude * magnitude;
                count += 1;
            }
        }
        if count < 32 || energy < 1.0e-18 {
            None
        } else {
            Some((error / energy).sqrt())
        }
    }

    fn gain_residual(
        output: &[f64],
        input: &[f64],
        gain: &[f64],
        skip: usize,
        latency: usize,
    ) -> f64 {
        let mut error = 0.0;
        let mut energy = 0.0;
        for index in skip..output.len() {
            let predicted = input[index - latency] * gain[index];
            let delta = output[index] - predicted;
            error += delta * delta;
            energy += output[index] * output[index];
        }
        if energy < 1.0e-18 {
            0.0
        } else {
            (error / energy).sqrt()
        }
    }

    fn residual_ratio(output: &[f64], freq: f64, rate: u32) -> Option<f64> {
        if output.len() < 32 {
            return None;
        }
        let mut sin_energy = 0.0;
        let mut cos_energy = 0.0;
        let mut cross = 0.0;
        let mut sin_proj = 0.0;
        let mut cos_proj = 0.0;
        for (index, value) in output.iter().enumerate() {
            let angle = 2.0 * std::f64::consts::PI * freq * index as f64 / f64::from(rate);
            let sine = angle.sin();
            let cosine = angle.cos();
            sin_energy += sine * sine;
            cos_energy += cosine * cosine;
            cross += sine * cosine;
            sin_proj += value * sine;
            cos_proj += value * cosine;
        }
        let det = sin_energy * cos_energy - cross * cross;
        if det.abs() < 1.0e-12 {
            return None;
        }
        let sine_gain = (sin_proj * cos_energy - cos_proj * cross) / det;
        let cosine_gain = (cos_proj * sin_energy - sin_proj * cross) / det;
        let mut error = 0.0;
        let mut energy = 0.0;
        for (index, value) in output.iter().enumerate() {
            let angle = 2.0 * std::f64::consts::PI * freq * index as f64 / f64::from(rate);
            let predicted = sine_gain * angle.sin() + cosine_gain * angle.cos();
            let delta = value - predicted;
            error += delta * delta;
            energy += value * value;
        }
        if energy == 0.0 {
            None
        } else {
            Some((error / energy).sqrt())
        }
    }

    fn bandlimited_impulse(rate: u32) -> Vec<[f32; 2]> {
        let mut input = vec![[0.0; 2]; 4_096];
        let center = 2_048.0;
        for (index, frame) in input.iter_mut().enumerate() {
            let x = index as f64 - center;
            let value = if x.abs() < 1.0e-9 {
                1.0
            } else {
                (std::f64::consts::PI * 0.45 * x).sin() / (std::f64::consts::PI * 0.45 * x)
                    * (0.5 + 0.5 * (std::f64::consts::PI * x / 64.0).cos())
            };
            let scaled = (value * 1.7) as f32;
            *frame = [scaled, scaled];
        }
        let _ = rate;
        input
    }

    fn bandlimited_noise(rate: u32) -> Vec<[f32; 2]> {
        let mut state = 0x1234_5678u32;
        let mut white = vec![0.0f64; 8_192];
        for sample in &mut white {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *sample = f64::from(state) / f64::from(u32::MAX) * 2.0 - 1.0;
        }
        let mut filtered = vec![0.0f64; white.len()];
        let taps = 31;
        for index in taps..white.len() {
            let mut acc = 0.0;
            for tap in 0..taps {
                let offset = tap as f64 - 15.0;
                let window = 0.5 + 0.5 * (std::f64::consts::PI * offset / 15.0).cos();
                let sinc = if offset.abs() < 1.0e-9 {
                    1.0
                } else {
                    (std::f64::consts::PI * 0.6 * offset).sin()
                        / (std::f64::consts::PI * 0.6 * offset)
                };
                acc += white[index - tap] * sinc * window;
            }
            filtered[index] = acc;
        }
        let peak = filtered
            .iter()
            .map(|value| value.abs())
            .fold(0.0, f64::max)
            .max(1.0e-9);
        filtered
            .into_iter()
            .map(|value| {
                let scaled = (value / peak * 1.6) as f32;
                [scaled, scaled * -0.7]
            })
            .collect::<Vec<_>>()
            .into_iter()
            .take(rate as usize)
            .collect()
    }

    fn sudden_onset(rate: u32) -> Vec<[f32; 2]> {
        (0..8_192)
            .map(|index| {
                if index < 1_000 {
                    [0.0; 2]
                } else {
                    let angle = 2.0 * std::f64::consts::PI * 15_000.0 * (index - 1_000) as f64
                        / f64::from(rate)
                        + std::f64::consts::FRAC_PI_2;
                    let value = angle.sin() as f32 * 1.8;
                    [value, value]
                }
            })
            .collect()
    }

    fn one_sided_hot(rate: u32) -> Vec<[f32; 2]> {
        (0..8_192)
            .map(|index| {
                let angle = std::f64::consts::PI * index as f64 / 2.0 + 0.3;
                [angle.sin() as f32 * 2.0, 0.0]
            })
            .take(rate as usize)
            .collect()
    }

    struct TruePeakMeter {
        phases: [[f64; 64]; 7],
        hist: [f64; 64],
    }

    impl TruePeakMeter {
        fn new() -> Self {
            let mut phases = [[0.0f64; 64]; 7];
            for step in 1..8 {
                phases[step - 1] = design_blackman_phase(step as f64 / 8.0);
            }
            Self {
                phases,
                hist: [0.0; 64],
            }
        }

        fn push(&mut self, sample: f64) -> f64 {
            self.push_points(sample)
                .into_iter()
                .map(|value| value.abs())
                .fold(0.0, f64::max)
        }

        fn push_points(&mut self, sample: f64) -> [f64; 8] {
            for index in 0..63 {
                self.hist[index] = self.hist[index + 1];
            }
            self.hist[63] = sample;
            let mut points = [0.0; 8];
            points[0] = self.hist[32];
            for (index, phase) in self.phases.iter().enumerate() {
                let mut acc = 0.0;
                for (tap, coeff) in phase.iter().enumerate() {
                    acc += self.hist[tap] * coeff;
                }
                points[index + 1] = acc;
            }
            points
        }
    }

    fn design_blackman_phase(frac: f64) -> [f64; 64] {
        const TAPS: usize = 64;
        let position = 31.0 + frac;
        let mut sum = 0.0;
        let mut coeff = [0.0; TAPS];
        for (index, slot) in coeff.iter_mut().enumerate() {
            let x = index as f64 / (TAPS - 1) as f64;
            let blackman = 0.42 - 0.5 * (std::f64::consts::TAU * x).cos()
                + 0.08 * (2.0 * std::f64::consts::TAU * x).cos();
            let offset = index as f64 - position;
            let sinc = if offset.abs() < 1.0e-12 {
                1.0
            } else {
                (std::f64::consts::PI * offset).sin() / (std::f64::consts::PI * offset)
            };
            *slot = sinc * blackman;
            sum += *slot;
        }
        let scale = 1.0 / sum;
        for value in &mut coeff {
            *value *= scale;
        }
        coeff
    }
}

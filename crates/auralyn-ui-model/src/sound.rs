//! 音づくりの画面：ノイズ低減と「声を整える」（歌向けの3つの値を含む）と残響と歯擦音の抑制。
//!
//! エンジンの統計（文字列と 0〜1 の値）を読み、画面が選べる形にする。保存と読み直しも同じ形を使う。

/// ノイズ低減の種類。弱・強は画面で選べる。測定値・会場は詳細の「環境に合わせる」で選ぶ。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseMode {
    Low,
    High,
    Measured,
    Venue,
}

impl NoiseMode {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "low" => Some(Self::Low),
            "high" => Some(Self::High),
            "smart" => Some(Self::Measured),
            "venue" => Some(Self::Venue),
            _ => None,
        }
    }

    /// エンジンへ渡す名前。
    pub fn key(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::High => "high",
            Self::Measured => "smart",
            Self::Venue => "venue",
        }
    }
}

/// 「声を整える」の種類。歌向けは整え具合の代わりに [`Singing`] の3つの値で調整する。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Broadcast,
    Warm,
    Bright,
    Singing,
}

impl Preset {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "broadcast" => Some(Self::Broadcast),
            "warm" => Some(Self::Warm),
            "bright" => Some(Self::Bright),
            "singing" => Some(Self::Singing),
            _ => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Broadcast => "broadcast",
            Self::Warm => "warm",
            Self::Bright => "bright",
            Self::Singing => "singing",
        }
    }
}

/// 音づくりの画面の1つの操作。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Change {
    NoiseOn(bool),
    NoiseMode(NoiseMode),
    /// 抑制の強さ（0.25〜1.25）。
    Strength(f32),
    VoiceGuard(bool),
    EffectsOn(bool),
    Preset(Preset),
    /// 整え具合（0〜1）。
    Amount(f32),
    LowCut(f32),
    /// 音量差を整える量（0〜1）。
    Dynamics(f32),
    Brightness(f32),
    ReverbOn(bool),
    /// 響きの量（0〜0.25）。
    ReverbMix(f32),
    ReverbDecay(f32),
    /// 高域の減衰（0〜1）。
    ReverbDamping(f32),
    DeEsserOn(bool),
    /// 抑える量（0〜1）。
    DeEsserAmount(f32),
}

/// 歌向けの3つの値（エンジンの `singing::SingingParams` と同じ範囲・既定）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Singing {
    /// 低音の整理（Hz、40〜160）。
    pub low_cut_hz: f32,
    /// 音量差を整える量（0〜1）。
    pub dynamics: f32,
    /// 声の明るさ（dB、-3〜3）。
    pub brightness_db: f32,
}

impl Default for Singing {
    fn default() -> Self {
        Self {
            low_cut_hz: 80.0,
            dynamics: 0.35,
            brightness_db: 0.0,
        }
    }
}

/// 残響（「声を整える」の ON/OFF とは別に使える。エンジンの `reverb::ReverbParams` と同じ範囲・既定）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reverb {
    pub enabled: bool,
    /// 響きの量（0〜0.25）。
    pub mix: f32,
    /// 残響の長さ（秒、0.3〜2.5）。
    pub decay_seconds: f32,
    /// 高域の減衰（0〜1）。
    pub damping: f32,
}

impl Default for Reverb {
    fn default() -> Self {
        Self {
            enabled: false,
            mix: 0.08,
            decay_seconds: 1.2,
            damping: 0.5,
        }
    }
}

/// 歯擦音（サ行）の抑制。OFF でも量は保つ（エンジンへは OFF を `None` で送る）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DeEsser {
    pub on: bool,
    /// 抑える量（0〜1。1 で最大約 −12 dB）。
    pub amount: f32,
}

impl Default for DeEsser {
    /// Tauri 版の初めの量と同じ 50%。
    fn default() -> Self {
        Self {
            on: false,
            amount: 0.5,
        }
    }
}

/// 歌向け・残響・歯擦音のスライダー。画面の単位（Hz・%・dB・秒）での範囲と、`Sound` との換算を持つ。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Knob {
    LowCut,
    Dynamics,
    Brightness,
    ReverbMix,
    ReverbDecay,
    ReverbDamping,
    DeEsser,
}

impl Knob {
    /// 宣言の順（画面は `knob as usize` で引く）。
    pub const ALL: [Knob; 7] = [
        Knob::LowCut,
        Knob::Dynamics,
        Knob::Brightness,
        Knob::ReverbMix,
        Knob::ReverbDecay,
        Knob::ReverbDamping,
        Knob::DeEsser,
    ];

    /// 画面の単位での（最小, 最大, 刻み）。エンジンが受け付ける範囲と同じ。
    pub fn range(self) -> (f32, f32, f32) {
        match self {
            Knob::LowCut => (40.0, 160.0, 1.0),
            Knob::Dynamics | Knob::ReverbDamping | Knob::DeEsser => (0.0, 100.0, 1.0),
            Knob::Brightness => (-3.0, 3.0, 0.1),
            Knob::ReverbMix => (0.0, 25.0, 1.0),
            Knob::ReverbDecay => (0.3, 2.5, 0.1),
        }
    }

    /// 画面の値 = `Sound` の値 × これ（百分率のものは 100）。
    fn scale(self) -> f32 {
        match self {
            Knob::Dynamics | Knob::ReverbMix | Knob::ReverbDamping | Knob::DeEsser => 100.0,
            Knob::LowCut | Knob::Brightness | Knob::ReverbDecay => 1.0,
        }
    }

    /// `Sound` の値を収める範囲（`Sound` の単位）。
    fn limits(self) -> (f32, f32) {
        let (min, max, _) = self.range();
        (min / self.scale(), max / self.scale())
    }

    /// 画面に出す値。
    pub fn shown(self, sound: &Sound) -> f32 {
        let value = match self {
            Knob::LowCut => sound.singing.low_cut_hz,
            Knob::Dynamics => sound.singing.dynamics,
            Knob::Brightness => sound.singing.brightness_db,
            Knob::ReverbMix => sound.reverb.mix,
            Knob::ReverbDecay => sound.reverb.decay_seconds,
            Knob::ReverbDamping => sound.reverb.damping,
            Knob::DeEsser => sound.deesser.amount,
        };
        value * self.scale()
    }

    /// 画面の値からの操作。
    pub fn change(self, shown: f32) -> Change {
        let value = shown / self.scale();
        match self {
            Knob::LowCut => Change::LowCut(value),
            Knob::Dynamics => Change::Dynamics(value),
            Knob::Brightness => Change::Brightness(value),
            Knob::ReverbMix => Change::ReverbMix(value),
            Knob::ReverbDecay => Change::ReverbDecay(value),
            Knob::ReverbDamping => Change::ReverbDamping(value),
            Knob::DeEsser => Change::DeEsserAmount(value),
        }
    }
}

/// 範囲に収める。数でなければ既定にする（エンジンは範囲外を断る）。
fn within(value: f32, knob: Knob, default: f32) -> f32 {
    if value.is_finite() {
        let (min, max) = knob.limits();
        value.clamp(min, max)
    } else {
        default
    }
}

impl Singing {
    fn normalized(self) -> Self {
        let d = Self::default();
        Self {
            low_cut_hz: within(self.low_cut_hz, Knob::LowCut, d.low_cut_hz),
            dynamics: within(self.dynamics, Knob::Dynamics, d.dynamics),
            brightness_db: within(self.brightness_db, Knob::Brightness, d.brightness_db),
        }
    }
}

impl Reverb {
    fn normalized(self) -> Self {
        let d = Self::default();
        Self {
            enabled: self.enabled,
            mix: within(self.mix, Knob::ReverbMix, d.mix),
            decay_seconds: within(self.decay_seconds, Knob::ReverbDecay, d.decay_seconds),
            damping: within(self.damping, Knob::ReverbDamping, d.damping),
        }
    }
}

impl DeEsser {
    /// エンジンへ送る形（OFF は `None`。OFF の間の量はエンジンへ渡らない）。
    pub fn sent(self) -> Option<f32> {
        self.on.then_some(self.amount)
    }
}

/// 「声を整える」・残響・歯擦音の抑制を、エンジンへどう送るか（`Sound::effects_request`）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EffectsRequest {
    pub active: bool,
    pub preset: Option<Preset>,
    pub amount: f32,
    /// 歌向けのときだけ送る。
    pub singing: Option<Singing>,
    /// 変わったときだけ送る（`None` ならエンジンは今の残響を保つ）。
    pub reverb: Option<Reverb>,
    /// 変わったときだけ置き換える（`None` ならエンジンは今の値を保つ。`Some(None)` は OFF）。
    pub deesser: Option<Option<f32>>,
}

/// 抑制の強さの既定（Tauri 版と同じ 80%）。統計が 0 以下（まだ設定していない）のときに使う。
const DEFAULT_STRENGTH: f32 = 0.8;

/// 音づくりの設定。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sound {
    pub noise_on: bool,
    /// 分からない種類は `None`。画面ではどれも選ばない。
    pub noise_mode: Option<NoiseMode>,
    /// 抑制の強さ（0.25〜1.25）。
    pub strength: f32,
    pub voice_guard: bool,
    pub effects_on: bool,
    pub preset: Option<Preset>,
    /// 整え具合（0〜1）。歌向けでは使わない。
    pub amount: f32,
    /// 歌向けの値。歌向けでないときも、次に歌向けを選んだときのために持つ。
    pub singing: Singing,
    pub reverb: Reverb,
    pub deesser: DeEsser,
}

impl Sound {
    /// エンジンの統計や保存から読んだ値を、範囲に収める。強さが未設定（0 以下）なら既定にする。
    pub fn normalized(self) -> Self {
        Self {
            strength: if self.strength.is_finite() && self.strength > 0.0 {
                self.strength.clamp(0.25, 1.25)
            } else {
                DEFAULT_STRENGTH
            },
            amount: if self.amount.is_finite() {
                self.amount.clamp(0.0, 1.0)
            } else {
                0.0
            },
            singing: self.singing.normalized(),
            reverb: self.reverb.normalized(),
            deesser: DeEsser {
                amount: within(
                    self.deesser.amount,
                    Knob::DeEsser,
                    DeEsser::default().amount,
                ),
                ..self.deesser
            },
            ..self
        }
    }

    /// 画面の1つの操作を重ねる。画面が持つ古い値で、ほかの区画を上書きしないため。
    pub fn with(self, change: Change) -> Self {
        match change {
            Change::NoiseOn(on) => Self {
                noise_on: on,
                ..self
            },
            Change::NoiseMode(mode) => Self {
                noise_mode: Some(mode),
                ..self
            },
            Change::Strength(strength) => Self { strength, ..self }.normalized(),
            Change::VoiceGuard(on) => Self {
                voice_guard: on,
                ..self
            },
            Change::EffectsOn(on) => Self {
                effects_on: on,
                ..self
            },
            Change::Preset(preset) => Self {
                preset: Some(preset),
                ..self
            },
            Change::Amount(amount) => Self { amount, ..self }.normalized(),
            Change::LowCut(low_cut_hz) => self.singing_with(Singing {
                low_cut_hz,
                ..self.singing
            }),
            Change::Dynamics(dynamics) => self.singing_with(Singing {
                dynamics,
                ..self.singing
            }),
            Change::Brightness(brightness_db) => self.singing_with(Singing {
                brightness_db,
                ..self.singing
            }),
            Change::ReverbOn(enabled) => self.reverb_with(Reverb {
                enabled,
                ..self.reverb
            }),
            Change::ReverbMix(mix) => self.reverb_with(Reverb { mix, ..self.reverb }),
            Change::ReverbDecay(decay_seconds) => self.reverb_with(Reverb {
                decay_seconds,
                ..self.reverb
            }),
            Change::ReverbDamping(damping) => self.reverb_with(Reverb {
                damping,
                ..self.reverb
            }),
            Change::DeEsserOn(on) => Self {
                deesser: DeEsser { on, ..self.deesser },
                ..self
            },
            Change::DeEsserAmount(amount) => Self {
                deesser: DeEsser {
                    amount,
                    ..self.deesser
                },
                ..self
            }
            .normalized(),
        }
    }

    fn singing_with(self, singing: Singing) -> Self {
        Self { singing, ..self }.normalized()
    }

    fn reverb_with(self, reverb: Reverb) -> Self {
        Self { reverb, ..self }.normalized()
    }

    /// ノイズ低減の設定が `other` と違う（エンジンへ送り直す）。
    pub fn noise_differs(&self, other: &Sound) -> bool {
        (
            self.noise_on,
            self.noise_mode,
            self.strength,
            self.voice_guard,
        ) != (
            other.noise_on,
            other.noise_mode,
            other.strength,
            other.voice_guard,
        )
    }

    /// 「声を整える」・残響・歯擦音の抑制の設定が `other` と違う（エンジンへは同じ命令で送る）。
    /// 歌向けの値は歌向けを選んでいるときだけ、歯擦音の量は ON のときだけ比べる（それ以外はエンジンへ渡らない）。
    pub fn effects_differ(&self, other: &Sound) -> bool {
        let singing = |s: &Sound| (s.preset == Some(Preset::Singing)).then_some(s.singing);
        (
            self.effects_on,
            self.preset,
            self.amount,
            singing(self),
            self.reverb,
            self.deesser.sent(),
        ) != (
            other.effects_on,
            other.preset,
            other.amount,
            singing(other),
            other.reverb,
            other.deesser.sent(),
        )
    }

    /// `before`（エンジンへ最後に送った値。起動時の復元などで分からなければ `None`）から変えるとき、送る中身。
    /// 送るものが無ければ `None`。
    pub fn effects_request(&self, before: Option<Sound>) -> Option<EffectsRequest> {
        if before.is_some_and(|before| !self.effects_differ(&before)) {
            return None;
        }
        Some(EffectsRequest {
            active: self.effects_on,
            preset: self.preset,
            amount: self.amount,
            singing: (self.preset == Some(Preset::Singing)).then_some(self.singing),
            reverb: before
                .is_none_or(|before| before.reverb != self.reverb)
                .then_some(self.reverb),
            deesser: before
                .is_none_or(|before| before.deesser.sent() != self.deesser.sent())
                .then_some(self.deesser.sent()),
        })
    }
}

/// 整え具合を、画面のスライダーの百分率（整数）にする。
pub fn percent(amount: f32) -> f32 {
    (amount.clamp(0.0, 1.0) * 100.0).round()
}

/// 抑制の強さを、画面のスライダーの百分率（整数）にする。
pub fn strength_percent(strength: f32) -> f32 {
    (strength.clamp(0.25, 1.25) * 100.0).round()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sound() -> Sound {
        Sound {
            noise_on: false,
            noise_mode: Some(NoiseMode::Low),
            strength: 0.8,
            voice_guard: true,
            effects_on: false,
            preset: Some(Preset::Broadcast),
            amount: 0.7,
            singing: Singing::default(),
            reverb: Reverb::default(),
            deesser: DeEsser::default(),
        }
    }

    #[test]
    fn modes_and_presets_round_trip_through_engine_names() {
        for mode in [
            NoiseMode::Low,
            NoiseMode::High,
            NoiseMode::Measured,
            NoiseMode::Venue,
        ] {
            assert_eq!(NoiseMode::parse(mode.key()), Some(mode));
        }
        for preset in [
            Preset::Broadcast,
            Preset::Warm,
            Preset::Bright,
            Preset::Singing,
        ] {
            assert_eq!(Preset::parse(preset.key()), Some(preset));
        }
        assert_eq!(NoiseMode::parse("unknown"), None);
        assert_eq!(Preset::parse(""), None);
    }

    #[test]
    fn normalized_fills_default_strength_and_clamps() {
        let fresh = Sound {
            strength: 0.0,
            amount: 1.7,
            ..sound()
        }
        .normalized();
        assert_eq!(fresh.strength, 0.8);
        assert_eq!(fresh.amount, 1.0);
        let odd = Sound {
            strength: 2.0,
            amount: f32::NAN,
            ..sound()
        }
        .normalized();
        assert_eq!(odd.strength, 1.25);
        assert_eq!(odd.amount, 0.0);
    }

    #[test]
    fn singing_values_count_only_while_singing_and_stay_in_range() {
        let low = sound().with(Change::LowCut(500.0));
        assert_eq!(low.singing.low_cut_hz, 160.0);
        assert!(!low.effects_differ(&sound()));
        let singing = sound().with(Change::Preset(Preset::Singing));
        assert!(singing.with(Change::Dynamics(0.5)).effects_differ(&singing));
        assert_eq!(
            singing.with(Change::Brightness(f32::NAN)).singing,
            Singing::default()
        );
        let wet = sound()
            .with(Change::ReverbOn(true))
            .with(Change::ReverbMix(1.0));
        assert!(wet.reverb.enabled && wet.reverb.mix == 0.25);
        assert!(wet.effects_differ(&sound()) && !wet.noise_differs(&sound()));
        let sharp = sound().with(Change::DeEsserAmount(2.0));
        assert_eq!(
            sharp.deesser,
            DeEsser {
                on: false,
                amount: 1.0
            }
        );
        // OFF の間の量は送らない（本番モードを「カスタム」にしない）。
        assert!(!sharp.effects_differ(&sound()));
        assert!(sharp.with(Change::DeEsserOn(true)).effects_differ(&sharp));
    }

    #[test]
    fn effects_request_sends_only_what_changed() {
        let base = sound();
        assert_eq!(base.effects_request(Some(base)), None);
        let first = base.effects_request(None).unwrap();
        assert_eq!(first.reverb, Some(Reverb::default()));
        assert_eq!(first.deesser, Some(None));
        assert_eq!(first.singing, None);
        let warmer = base.with(Change::Amount(0.2));
        let request = warmer.effects_request(Some(base)).unwrap();
        assert_eq!((request.reverb, request.deesser), (None, None));
        let singing = base.with(Change::Preset(Preset::Singing));
        assert_eq!(
            singing.effects_request(Some(base)).unwrap().singing,
            Some(Singing::default())
        );
        let on = base.with(Change::DeEsserOn(true));
        assert_eq!(
            on.effects_request(Some(base)).unwrap().deesser,
            Some(Some(0.5))
        );
    }

    #[test]
    fn knobs_convert_between_screen_and_model_units() {
        for knob in Knob::ALL {
            let (min, max, _) = knob.range();
            let low = sound().with(knob.change(min - 1000.0));
            let high = sound().with(knob.change(max + 1000.0));
            assert_eq!(
                (knob.shown(&low), knob.shown(&high)),
                (min, max),
                "{knob:?}"
            );
        }
        assert_eq!(Knob::ReverbMix.change(10.0), Change::ReverbMix(0.1));
        // 画面は `knob as usize` で `ALL` の順のスライダーを引く。
        assert!(Knob::ALL.iter().enumerate().all(|(i, k)| *k as usize == i));
    }

    #[test]
    fn differences_are_split_by_section() {
        let base = sound();
        let louder = Sound {
            amount: 0.9,
            ..base
        };
        assert!(!louder.noise_differs(&base));
        assert!(louder.effects_differ(&base));
        let noisy = Sound {
            noise_on: true,
            ..base
        };
        assert!(noisy.noise_differs(&base));
        assert!(!noisy.effects_differ(&base));
        assert_eq!(percent(0.704), 70.0);
    }

    #[test]
    fn a_change_touches_only_its_own_field() {
        let noisy = sound().with(Change::NoiseOn(true));
        assert_eq!(
            noisy,
            Sound {
                noise_on: true,
                ..sound()
            }
        );
        let warm = noisy.with(Change::Preset(Preset::Warm));
        assert!(warm.noise_on);
        assert_eq!(warm.preset, Some(Preset::Warm));
        assert_eq!(sound().with(Change::Amount(3.0)).amount, 1.0);
        let strong = sound().with(Change::Strength(2.0));
        assert_eq!(strong.strength, 1.25);
        assert!(strong.noise_differs(&sound()));
        assert!(!sound().with(Change::VoiceGuard(false)).voice_guard);
        assert_eq!(strength_percent(0.8), 80.0);
    }
}

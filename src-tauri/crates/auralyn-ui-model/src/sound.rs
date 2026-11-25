//! 音づくりの画面：ノイズ低減と「声を整える」。
//!
//! エンジンの統計（文字列と 0〜1 の値）を読み、画面が選べる形にする。保存と読み直しも同じ形を使う。

/// ノイズ低減の種類。弱・強は画面で選べる。測定値・会場は詳細の設定（まだ GPUI 版に無い）で選ぶ。
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

/// 「声を整える」の種類。歌向けは専用の3つの値で調整するので、まだ GPUI 版では変えない。
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
    EffectsOn(bool),
    Preset(Preset),
    /// 整え具合（0〜1）。
    Amount(f32),
}

/// 抑制の強さの既定（Tauri 版と同じ 80%）。統計が 0 以下（まだ設定していない）のときに使う。
const DEFAULT_STRENGTH: f32 = 0.8;

/// 音づくりの設定。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sound {
    pub noise_on: bool,
    /// 分からない種類は `None`。画面ではどれも選ばない。
    pub noise_mode: Option<NoiseMode>,
    /// 抑制の強さ（0.25〜1.25）。画面ではまだ変えず、そのまま渡す。
    pub strength: f32,
    pub voice_guard: bool,
    pub effects_on: bool,
    pub preset: Option<Preset>,
    /// 整え具合（0〜1）。
    pub amount: f32,
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
            ..self
        }
    }

    /// 画面で「声を整える」を変えられるか。歌向けは、今までの版で調整する。
    /// 種類が分からない（音声をまだ始めていない）ときは変えられる。種類を選べば送れる。
    pub fn effects_editable(&self) -> bool {
        self.preset != Some(Preset::Singing)
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
            Change::EffectsOn(on) => Self {
                effects_on: on,
                ..self
            },
            Change::Preset(preset) => Self {
                preset: Some(preset),
                ..self
            },
            Change::Amount(amount) => Self { amount, ..self }.normalized(),
        }
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

    /// 「声を整える」の設定が `other` と違う。
    pub fn effects_differ(&self, other: &Sound) -> bool {
        (self.effects_on, self.preset, self.amount)
            != (other.effects_on, other.preset, other.amount)
    }
}

/// 整え具合を、画面のスライダーの百分率（整数）にする。
pub fn percent(amount: f32) -> f32 {
    (amount.clamp(0.0, 1.0) * 100.0).round()
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
    fn only_singing_is_not_editable_here() {
        let mut sound = Sound {
            preset: Some(Preset::Singing),
            ..sound()
        };
        assert!(!sound.effects_editable());
        sound.preset = None;
        assert!(sound.effects_editable());
        sound.preset = Some(Preset::Bright);
        assert!(sound.effects_editable());
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
    }
}

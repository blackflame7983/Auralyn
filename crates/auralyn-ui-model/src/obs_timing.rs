//! OBS の同期調整：利用者が録画で測った差から、早い側のソースへ足す遅れを決める（Tauri 版の `ObsTimingCheck`）。
//! 変更そのもの（対象の取得・変更予定・適用・元に戻す）は vst-host の `obs_setup`。

/// 測った差の上限（ms）。
pub const MAX_DELAY_MS: i64 = 20_950;
/// OBS の同期オフセットの範囲（ms）。
pub const MIN_OFFSET_MS: i64 = -950;
pub const MAX_OFFSET_MS: i64 = 20_000;
pub const MAX_NOTE_CHARS: usize = 500;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Comparison {
    #[default]
    VoiceAccompaniment,
    AudioVideo,
}

/// 録画で、比べたものの前者（声・音声）が後者より早いか遅いか。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Early,
    Late,
    Unknown,
}

/// 遅れを足す側。早い側だけを遅らせる。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// 映像より早い音声
    Audio,
    /// 声より早い伴奏（声とは別のソース）
    Accompaniment,
    /// 伴奏より早い声
    Voice,
}

/// 変更を提案できない理由。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blocked {
    /// 声と伴奏が同じソースに混ざっていて、OBS では相対調整できない。
    Mixed,
    /// 判断できない。
    Unknown,
    /// 音声が映像より遅い：映像側の調整が要る。
    AudioLate,
}

/// まだ足りない入力（上から順に埋めてもらう）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Missing {
    Direction,
    Difference,
    Fps,
    Track,
    Note,
    Checked,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Form {
    pub comparison: Comparison,
    pub direction: Option<Direction>,
    /// 声と伴奏が同じソースに混ざっている。
    pub mixed: bool,
    pub difference: String,
    pub note: String,
    pub fps: String,
    pub track: String,
    /// 基準と経路を確かめ、OBS の配信・録画を止めた。
    pub checked: bool,
}

/// 送れる形にした入力。`measured_ms` は声（音声）が遅ければ正、早ければ負。
#[derive(Clone, Debug, PartialEq)]
pub struct Measurement {
    pub delay_ms: i64,
    pub measured_ms: i64,
    pub note: String,
    pub fps: Option<f64>,
    pub track: Option<u8>,
}

impl Form {
    pub fn blocked(&self) -> Option<Blocked> {
        if self.mixed && self.comparison == Comparison::VoiceAccompaniment {
            return Some(Blocked::Mixed);
        }
        match (self.direction?, self.comparison) {
            (Direction::Unknown, _) => Some(Blocked::Unknown),
            (Direction::Late, Comparison::AudioVideo) => Some(Blocked::AudioLate),
            _ => None,
        }
    }

    /// 遅れを足す側。方向を選んでいないか、提案できなければ `None`。
    pub fn role(&self) -> Option<Role> {
        if self.blocked().is_some() {
            return None;
        }
        Some(match (self.comparison, self.direction?) {
            (Comparison::AudioVideo, _) => Role::Audio,
            (_, Direction::Late) => Role::Accompaniment,
            _ => Role::Voice,
        })
    }

    /// 最初に足りない入力。そろっているか、提案できない（`blocked`）ときは `None`。
    pub fn missing(&self) -> Option<Missing> {
        self.read().err().flatten()
    }

    /// 入力がそろっていて範囲内なら、送れる形にする。
    pub fn measurement(&self) -> Option<Measurement> {
        self.read().ok()
    }

    /// 入力を上から順に読む。提案できないときは `Err(None)`、足りない入力があれば `Err(Some(その入力))`。
    fn read(&self) -> Result<Measurement, Option<Missing>> {
        if self.blocked().is_some() {
            return Err(None);
        }
        let direction = self.direction.ok_or(Some(Missing::Direction))?;
        let delay_ms = self
            .difference
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|delay| (1..=MAX_DELAY_MS).contains(delay))
            .ok_or(Some(Missing::Difference))?;
        let fps = optional(&self.fps, |fps: f64| {
            fps.is_finite() && (1.0..=240.0).contains(&fps)
        })
        .ok_or(Some(Missing::Fps))?;
        let track = optional(&self.track, |track: u8| (1..=6).contains(&track))
            .ok_or(Some(Missing::Track))?;
        let note = self.note.trim();
        if note.is_empty() || self.note.chars().count() > MAX_NOTE_CHARS {
            return Err(Some(Missing::Note));
        }
        if !self.checked {
            return Err(Some(Missing::Checked));
        }
        let late = direction == Direction::Late;
        Ok(Measurement {
            delay_ms,
            measured_ms: if late { delay_ms } else { -delay_ms },
            note: note.to_string(),
            fps,
            track,
        })
    }
}

/// 空なら `Some(None)`、読めて条件に合えば `Some(Some(値))`、それ以外は `None`。
fn optional<T: std::str::FromStr + Copy>(text: &str, ok: impl Fn(T) -> bool) -> Option<Option<T>> {
    let text = text.trim();
    if text.is_empty() {
        return Some(None);
    }
    let value: T = text.parse().ok()?;
    ok(value).then_some(Some(value))
}

/// 変更後のオフセット。OBS の範囲を外れるなら `None`。
pub fn result_offset(current_ms: i64, delay_ms: i64) -> Option<i64> {
    current_ms
        .checked_add(delay_ms)
        .filter(|after| (MIN_OFFSET_MS..=MAX_OFFSET_MS).contains(after))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Form {
        Form {
            direction: Some(Direction::Early),
            difference: "120".into(),
            note: "手拍子".into(),
            checked: true,
            ..Form::default()
        }
    }

    #[test]
    fn early_voice_delays_the_voice_and_records_a_negative_measurement() {
        let form = ready();
        assert_eq!(form.role(), Some(Role::Voice));
        let m = form.measurement().unwrap();
        assert_eq!(
            (m.delay_ms, m.measured_ms, m.fps, m.track),
            (120, -120, None, None)
        );
    }

    #[test]
    fn missing_names_the_first_empty_input_in_order() {
        let mut form = Form::default();
        assert_eq!(form.missing(), Some(Missing::Direction));
        form.direction = Some(Direction::Early);
        assert_eq!(form.missing(), Some(Missing::Difference));
        form.difference = "0".into();
        assert_eq!(form.missing(), Some(Missing::Difference));
        form.difference = "120".into();
        form.fps = "500".into();
        assert_eq!(form.missing(), Some(Missing::Fps));
        form.fps = "60".into();
        form.track = "9".into();
        assert_eq!(form.missing(), Some(Missing::Track));
        form.track.clear();
        assert_eq!(form.missing(), Some(Missing::Note));
        form.note = "手拍子".into();
        assert_eq!(form.missing(), Some(Missing::Checked));
        assert_eq!(form.measurement(), None);
        form.checked = true;
        assert_eq!(form.missing(), None);
        assert_eq!(
            form.measurement().map(|m| (m.fps, m.track)),
            Some((Some(60.0), None))
        );
        form.mixed = true;
        assert_eq!((form.missing(), form.measurement()), (None, None));
    }

    #[test]
    fn late_voice_delays_the_accompaniment() {
        let form = Form {
            direction: Some(Direction::Late),
            ..ready()
        };
        assert_eq!(form.role(), Some(Role::Accompaniment));
        assert_eq!(form.measurement().unwrap().measured_ms, 120);
    }

    #[test]
    fn blocked_cases_propose_nothing() {
        let mixed = Form {
            mixed: true,
            ..ready()
        };
        assert_eq!(mixed.blocked(), Some(Blocked::Mixed));
        assert!(mixed.measurement().is_none());
        let unknown = Form {
            direction: Some(Direction::Unknown),
            ..ready()
        };
        assert_eq!(unknown.blocked(), Some(Blocked::Unknown));
        let audio_late = Form {
            comparison: Comparison::AudioVideo,
            direction: Some(Direction::Late),
            ..ready()
        };
        assert_eq!(audio_late.blocked(), Some(Blocked::AudioLate));
        let audio_early_mixed = Form {
            comparison: Comparison::AudioVideo,
            mixed: true,
            ..ready()
        };
        assert_eq!(audio_early_mixed.role(), Some(Role::Audio));
    }

    #[test]
    fn inputs_out_of_range_are_rejected() {
        for (difference, fps, track) in [
            ("0", "", ""),
            ("20951", "", ""),
            ("1.5", "", ""),
            ("120", "0", ""),
            ("120", "abc", ""),
            ("120", "", "7"),
        ] {
            let form = Form {
                difference: difference.into(),
                fps: fps.into(),
                track: track.into(),
                ..ready()
            };
            assert!(form.measurement().is_none(), "{difference} {fps} {track}");
        }
        let unchecked = Form {
            checked: false,
            ..ready()
        };
        assert!(unchecked.measurement().is_none());
        let blank = Form {
            note: "  ".into(),
            ..ready()
        };
        assert!(blank.measurement().is_none());
        let full = Form {
            fps: "59.94".into(),
            track: "2".into(),
            ..ready()
        };
        let m = full.measurement().unwrap();
        assert_eq!((m.fps, m.track), (Some(59.94), Some(2)));
    }

    #[test]
    fn result_offset_stays_in_the_obs_range() {
        assert_eq!(result_offset(0, 120), Some(120));
        assert_eq!(result_offset(19_950, 120), None);
        assert_eq!(result_offset(-2_000, 1_000), None);
    }
}

//! 音楽鑑賞のホームの案内（Tauri 版の `MusicSourceHint`・`cablePlaybackName`）。
//! 再生元（仮想ケーブルなど）から音が届かない状態が続いたら、再生アプリの出力先を伝える。

use std::time::{Duration, Instant};

use crate::meter::State;

/// 届かない状態がこの時間続いたときだけ出す（曲の合間の無音では出さない）。
pub const SOURCE_HINT_AFTER: Duration = Duration::from_secs(5);

/// 名前の末尾の「 [48kHz]」「 [44/48/96kHz]」のような周波数の札を除く（札のあとに空白があれば除かない。Tauri 版と同じ）。
pub fn without_rate(name: &str) -> &str {
    let Some(body) = name
        .len()
        .checked_sub(4)
        .filter(|&end| name.is_char_boundary(end) && name[end..].eq_ignore_ascii_case("kHz]"))
        .map(|end| &name[..end])
    else {
        return name;
    };
    let Some(open) = body.rfind('[') else {
        return name;
    };
    let inner = &body[open + 1..];
    if inner.is_empty()
        || !inner
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '/' | '.' | ',') || c.is_whitespace())
    {
        return name;
    }
    body[..open].trim_end()
}

/// VB-CABLE（CABLE / CABLE-A / CABLE-B）の組の印（"" / "-A" / "-B"）。ほかの機器は推測しない。
fn cable_family(name: &str, side: &str) -> Option<String> {
    let name = without_rate(name).trim();
    let rest = name
        .get(..5)
        .filter(|head| head.eq_ignore_ascii_case("CABLE"))
        .map(|_| &name[5..])?;
    let (family, rest) = match rest.get(..2) {
        Some(tag) if tag.eq_ignore_ascii_case("-A") || tag.eq_ignore_ascii_case("-B") => {
            (tag.to_ascii_uppercase(), &rest[2..])
        }
        _ => (String::new(), rest),
    };
    let rest = rest.strip_prefix(char::is_whitespace)?.trim_start();
    let rest = rest
        .get(..side.len())
        .filter(|word| word.eq_ignore_ascii_case(side))
        .map(|_| &rest[side.len()..])?
        .trim_start();
    let tail_ok = rest.is_empty()
        || (rest.starts_with('(') && rest.ends_with(')') && !rest[1..rest.len() - 1].contains(')'));
    tail_ok.then_some(family)
}

/// 録音側（CABLE Output）を再生元にしているとき、再生アプリが出力する先（CABLE Input）。
pub fn cable_playback_name(input: &str) -> Option<String> {
    cable_family(input, "Output").map(|family| format!("CABLE{family} Input"))
}

/// 再生元から届かない状態がどれだけ続いたか。
#[derive(Clone, Copy, Debug, Default)]
pub struct SourceHint {
    quiet_since: Option<Instant>,
}

impl SourceHint {
    /// 案内を出すか。アプリの音声を再生元にしているときは、アプリから直接受けるので出さない。
    pub fn update(&mut self, running: bool, from_app: bool, input: State, now: Instant) -> bool {
        let quiet =
            running && !from_app && matches!(input, State::Waiting | State::Stale | State::Silent);
        if !quiet {
            self.quiet_since = None;
            return false;
        }
        let since = *self.quiet_since.get_or_insert(now);
        now.duration_since(since) >= SOURCE_HINT_AFTER
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_tags_from_the_engine_are_removed_and_other_brackets_kept() {
        assert_eq!(
            without_rate("Voicemeeter In 2 [44/48/96kHz]"),
            "Voicemeeter In 2"
        );
        assert_eq!(without_rate("Mic (2) [48kHz]"), "Mic (2)");
        assert_eq!(without_rate("Mic [USB]"), "Mic [USB]");
        assert_eq!(without_rate("Mic [44.1kHz, 48kHz]"), "Mic [44.1kHz, 48kHz]");
    }

    #[test]
    fn only_known_cable_names_map_to_their_playback_side() {
        assert_eq!(
            cable_playback_name("CABLE Output").as_deref(),
            Some("CABLE Input")
        );
        assert_eq!(
            cable_playback_name("cable-b output (VB-Audio Virtual Cable B) [48 kHz]").as_deref(),
            Some("CABLE-B Input")
        );
        assert_eq!(cable_playback_name("CABLE Input"), None);
        assert_eq!(cable_playback_name("CABLE Output [48 kHz] "), None);
        assert_eq!(
            cable_playback_name(" CABLE Output ").as_deref(),
            Some("CABLE Input")
        );
        assert_eq!(cable_playback_name("CABLEOutput"), None);
        assert_eq!(cable_playback_name("Voicemeeter Out B1"), None);
        assert_eq!(cable_playback_name("CABLE Output (a) (b)"), None);
    }

    #[test]
    fn hint_waits_for_a_sustained_silence_from_a_device() {
        let start = Instant::now();
        let mut hint = SourceHint::default();
        assert!(!hint.update(true, false, State::Silent, start));
        assert!(!hint.update(true, false, State::Silent, start + Duration::from_secs(4)));
        assert!(hint.update(true, false, State::Silent, start + SOURCE_HINT_AFTER));
        assert!(!hint.update(true, false, State::Live, start + Duration::from_secs(6)));
        assert!(!hint.update(true, false, State::Silent, start + Duration::from_secs(7)));
        assert!(!hint.update(true, true, State::Silent, start + Duration::from_secs(20)));
        assert!(!hint.update(
            false,
            false,
            State::Stopped,
            start + Duration::from_secs(30)
        ));
    }
}

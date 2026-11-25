//! VST の画面：追加の候補と、並びの入れ替え。
//!
//! 音は並びの上から順に通る。候補はエンジンのスキャン結果（名前・メーカー・カテゴリ・パス）。

/// スキャンで見つかった VST の1クラス。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub name: String,
    /// 空はメーカー不明。
    pub vendor: String,
    pub category: Option<String>,
    pub path: String,
    pub class_id: Option<String>,
}

impl Candidate {
    /// 一覧に出す名前。同じ名前の VST を見分けられるよう、メーカーを添える。
    pub fn title(&self) -> String {
        if self.vendor.is_empty() {
            self.name.clone()
        } else {
            format!("{} — {}", self.name, self.vendor)
        }
    }

    /// 検索：名前・メーカー・カテゴリのどれかに、大文字小文字を区別せずに含まれる。空の検索はすべてに合う。
    pub fn matches(&self, query: &str) -> bool {
        let query = query.trim().to_lowercase();
        [
            Some(self.name.as_str()),
            Some(self.vendor.as_str()),
            self.category.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|field| field.to_lowercase().contains(&query))
    }
}

/// `index` の項目を1つ上（または下）へ動かすときの、入れ替える相手の位置。端なら動かさない。
pub fn neighbour(len: usize, index: usize, up: bool) -> Option<usize> {
    if index >= len {
        return None;
    }
    if up {
        index.checked_sub(1)
    } else {
        Some(index + 1).filter(|&next| next < len)
    }
}

/// VST ごとの音量の上限（200%）。Tauri 版のスライダーと同じ。
pub const MAX_GAIN: f32 = 2.0;

/// 音量の百分率（スライダーの値）を、エンジンへ送る倍率にする。0〜200% に収める。
pub fn gain_from_percent(percent: f32) -> f32 {
    (percent / 100.0).clamp(0.0, MAX_GAIN)
}

/// 倍率を、画面に出す整数の百分率にする。
pub fn gain_percent(gain: f32) -> f32 {
    (gain.clamp(0.0, MAX_GAIN) * 100.0).round()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str, vendor: &str, category: Option<&str>) -> Candidate {
        Candidate {
            name: name.into(),
            vendor: vendor.into(),
            category: category.map(Into::into),
            path: format!("C:/VST3/{name}.vst3"),
            class_id: None,
        }
    }

    #[test]
    fn title_adds_vendor_only_when_known() {
        assert_eq!(candidate("Comp", "Acme", None).title(), "Comp — Acme");
        assert_eq!(candidate("Comp", "", None).title(), "Comp");
    }

    #[test]
    fn search_looks_at_name_vendor_and_category_ignoring_case() {
        let c = candidate("ReaComp", "Cockos", Some("Fx|Dynamics"));
        assert!(c.matches("reacomp"));
        assert!(c.matches("COCKOS"));
        assert!(c.matches("dynamics"));
        assert!(c.matches("  "));
        assert!(!c.matches("reverb"));
    }

    #[test]
    fn neighbour_stays_inside_the_list() {
        assert_eq!(neighbour(3, 0, true), None);
        assert_eq!(neighbour(3, 1, true), Some(0));
        assert_eq!(neighbour(3, 1, false), Some(2));
        assert_eq!(neighbour(3, 2, false), None);
        assert_eq!(neighbour(3, 3, true), None);
    }

    #[test]
    fn gain_stays_between_silence_and_double() {
        assert_eq!(gain_from_percent(100.0), 1.0);
        assert_eq!(gain_from_percent(-5.0), 0.0);
        assert_eq!(gain_from_percent(250.0), MAX_GAIN);
        assert_eq!(gain_percent(0.506), 51.0);
        assert_eq!(gain_percent(3.0), 200.0);
    }
}

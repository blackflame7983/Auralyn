//! 公式サイトの利用者向けドキュメントへのリンク（`docs/USER_DOCS.md` の約束。Tauri 版 `src/lib/userDocs.ts` と同じ URL）。
//! 行き先は `user-docs/links.json` にあるものだけを使い、試験で確かめる。

/// 困ったときの症状。順は Tauri 版の使い方と同じ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trouble {
    Silent,
    NotReceived,
    Dropouts,
    KeepsRunning,
}

impl Trouble {
    pub const ALL: [Trouble; 4] = [
        Trouble::Silent,
        Trouble::NotReceived,
        Trouble::Dropouts,
        Trouble::KeepsRunning,
    ];

    /// 行き先（ページ名#印）。`links.json` の troubleshooting.* と同じ。
    pub fn target(self) -> &'static str {
        match self {
            Trouble::Silent => "troubleshooting#no-sound",
            Trouble::NotReceived => "troubleshooting#not-received",
            Trouble::Dropouts => "troubleshooting#dropouts",
            Trouble::KeepsRunning => "troubleshooting#still-running",
        }
    }
}

/// ドキュメントの入口（はじめに）。
pub const INDEX: &str = "index";

/// 行き先（ページ名#印）の URL。英語は `/en/` の下。利用者の情報は付けない。
pub fn url(target: &str, english: bool) -> String {
    let (page, anchor) = target.split_once('#').unwrap_or((target, ""));
    let mut url = format!(
        "https://www.kuro7983.com/{}apps/auralyn/docs",
        if english { "en/" } else { "" }
    );
    if page != INDEX {
        url.push('/');
        url.push_str(page);
    }
    if !anchor.is_empty() {
        url.push('#');
        url.push_str(anchor);
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_have_the_documented_shape() {
        assert_eq!(
            url("troubleshooting#no-sound", false),
            "https://www.kuro7983.com/apps/auralyn/docs/troubleshooting#no-sound"
        );
        assert_eq!(
            url(INDEX, true),
            "https://www.kuro7983.com/en/apps/auralyn/docs"
        );
    }

    #[test]
    fn links_are_listed_in_links_json() {
        let links = include_str!("../../../../user-docs/links.json");
        for trouble in Trouble::ALL {
            let target = trouble.target();
            assert!(links.contains(&format!(": \"{target}\"")), "{target}");
        }
    }
}

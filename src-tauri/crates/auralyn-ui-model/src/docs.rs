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

/// 用語集の1語：見出し・印（`term-…`）・最初の段落（Tauri 版 `parseGlossary` と同じ取り出し方）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    pub title: String,
    pub anchor: String,
    pub summary: String,
}

/// `user-docs/{ja,en}/glossary.md` から各用語の見出しと直後の段落だけを取り出す。補足はサイトで読む。
pub fn glossary(source: &str) -> Vec<Term> {
    let lines: Vec<&str> = source.lines().collect();
    let mut terms = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some((title, anchor)) = line
            .strip_prefix("### ")
            .and_then(|rest| rest.strip_suffix('}'))
            .and_then(|rest| rest.rsplit_once(" {#"))
        else {
            continue;
        };
        let valid = anchor.strip_prefix("term-").is_some_and(|name| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        });
        if !valid {
            continue;
        }
        let summary: Vec<&str> = lines[i + 1..]
            .iter()
            .skip_while(|l| l.is_empty())
            .take_while(|l| !l.is_empty() && !l.starts_with('#'))
            .copied()
            .collect();
        if !summary.is_empty() {
            terms.push(Term {
                title: title.to_owned(),
                anchor: anchor.to_owned(),
                summary: summary.join(" "),
            });
        }
    }
    terms
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
        for term in glossary(include_str!("../../../../user-docs/ja/glossary.md")) {
            let target = format!("glossary#{}", term.anchor);
            assert!(links.contains(&format!(": \"{target}\"")), "{target}");
        }
    }

    #[test]
    fn glossary_takes_the_first_paragraph_of_each_term() {
        let source = "## 言葉の意味 {#terms}\n\n### 送り先 {#term-destination}\n\n配信や通話など、\n音を使う目的です。\n\n補足。\n\n### 見出しだけ {#other}\n\n本文\n\n### 大文字 {#term-Foo}\n\n本文\n";
        assert_eq!(
            glossary(source),
            vec![Term {
                title: "送り先".to_owned(),
                anchor: "term-destination".to_owned(),
                summary: "配信や通話など、 音を使う目的です。".to_owned(),
            }]
        );
    }

    #[test]
    fn every_glossary_term_has_a_summary_in_both_languages() {
        let ja = glossary(include_str!("../../../../user-docs/ja/glossary.md"));
        let en = glossary(include_str!("../../../../user-docs/en/glossary.md"));
        assert!(!ja.is_empty());
        let anchors = |terms: &[Term]| terms.iter().map(|t| t.anchor.clone()).collect::<Vec<_>>();
        assert_eq!(anchors(&ja), anchors(&en));
    }
}

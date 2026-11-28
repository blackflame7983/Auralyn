//! VST を探すフォルダー。標準の2つは外せず、利用者は 32 件まで足せる。
//! 使えるかどうか（見つからない・フォルダーでない）はスキャンするエンジンが確かめる。

/// エンジンの `default_roots` と同じ。
pub const STANDARD: [&str; 2] = [
    "C:\\Program Files\\Common Files\\VST3",
    "C:\\Program Files\\Steinberg\\VST3",
];
pub const MAX_EXTRA: usize = 32;
const MAX_CHARS: usize = 32_767;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    Empty,
    Duplicate,
    Invalid,
    Full,
}

/// 同じフォルダーかを比べる形（区切りをそろえ、末尾の区切りと大小文字の違いを無視する）。
pub fn key(path: &str) -> String {
    path.trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn invalid(path: &str) -> bool {
    path.contains('\0') || path.chars().count() > MAX_CHARS
}

fn known(current: &[String], path: &str) -> bool {
    let key = key(path);
    STANDARD
        .iter()
        .copied()
        .chain(current.iter().map(String::as_str))
        .any(|known| self::key(known) == key)
}

/// 保存から読んだ一覧。空・不正・重複を除き、32 件までにする。
pub fn sanitize(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut folders = Vec::new();
    for item in items {
        let path = item.trim();
        if path.is_empty() || invalid(path) || known(&folders, path) {
            continue;
        }
        folders.push(path.to_string());
        if folders.len() >= MAX_EXTRA {
            break;
        }
    }
    folders
}

pub fn add(current: &[String], raw: &str) -> Result<Vec<String>, Reject> {
    let path = raw.trim();
    if path.is_empty() {
        return Err(Reject::Empty);
    }
    if invalid(path) {
        return Err(Reject::Invalid);
    }
    if current.len() >= MAX_EXTRA {
        return Err(Reject::Full);
    }
    if known(current, path) {
        return Err(Reject::Duplicate);
    }
    let mut next = current.to_vec();
    next.push(path.to_string());
    Ok(next)
}

pub fn remove(current: &[String], path: &str) -> Vec<String> {
    let key = key(path);
    current
        .iter()
        .filter(|item| self::key(item) != key)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_rejects_empty_duplicates_and_too_many() {
        let none: Vec<String> = Vec::new();
        assert_eq!(add(&none, "  "), Err(Reject::Empty));
        assert_eq!(add(&none, "a\0b"), Err(Reject::Invalid));
        assert_eq!(
            add(&none, "c:/program files/common files/vst3/"),
            Err(Reject::Duplicate)
        );
        let one = add(&none, " D:\\VST ").unwrap();
        assert_eq!(one, vec!["D:\\VST".to_string()]);
        assert_eq!(add(&one, "d:\\vst\\"), Err(Reject::Duplicate));
        let full: Vec<String> = (0..MAX_EXTRA).map(|i| format!("D:\\{i}")).collect();
        assert_eq!(add(&full, "E:\\VST"), Err(Reject::Full));
        assert_eq!(remove(&one, "d:/VST/"), Vec::<String>::new());
    }

    #[test]
    fn sanitize_drops_bad_and_repeated_entries() {
        let mut items = vec![
            "".to_string(),
            " D:\\VST ".to_string(),
            "d:\\vst".to_string(),
            STANDARD[1].to_string(),
            "x\0".to_string(),
        ];
        items.extend((0..40).map(|i| format!("E:\\{i}")));
        let folders = sanitize(items);
        assert_eq!(folders[0], "D:\\VST");
        assert_eq!(folders.len(), MAX_EXTRA);
        assert_eq!(folders[1], "E:\\0");
    }
}

//! 保存した構成（Tauri 版と同じ `presets/` のファイル）：一覧に出すもの、保存する名前。
//!
//! GPUI 版が読み書きするのは、VST の並び・ノイズ低減・声を整える設定だけ（接続は変えない）。
//! そのどれも持たない構成（接続だけの構成）は、適用しても何も変わらないので一覧に出さない。

/// 構成の一覧の1行。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub has_plugins: bool,
    pub has_noise: bool,
    pub has_effects: bool,
    /// 適用の前に自動で取った退避（「直前の状態に戻す」）。
    pub is_backup: bool,
}

impl Entry {
    fn applicable(&self) -> bool {
        self.has_plugins || self.has_noise || self.has_effects
    }
}

/// 選べる構成の名前。退避と、接続だけの構成は出さない。
pub fn choices(entries: &[Entry]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| !entry.is_backup && entry.applicable())
        .map(|entry| entry.name.clone())
        .collect()
}

/// 直前の状態に戻すときに読む退避の名前。無ければ戻せない。
pub fn backup_name(entries: &[Entry]) -> Option<&str> {
    entries
        .iter()
        .find(|entry| entry.is_backup && entry.applicable())
        .map(|entry| entry.name.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameIssue {
    Empty,
    /// 同じ名前がある（上書きはさせない。退避の名前もここに入る）。Windows のファイル名と同じく、大文字・小文字は区別しない。
    Exists,
}

/// 入力から保存する名前を作る。前後の空白は除く。使えない文字は保存のときにエンジンが断る。
pub fn save_name(input: &str, entries: &[Entry]) -> Result<String, NameIssue> {
    let name = input.trim();
    if name.is_empty() {
        Err(NameIssue::Empty)
    } else if entries
        .iter()
        .any(|entry| entry.name.to_lowercase() == name.to_lowercase())
    {
        Err(NameIssue::Exists)
    } else {
        Ok(name.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, plugins: bool, is_backup: bool) -> Entry {
        Entry {
            name: name.into(),
            has_plugins: plugins,
            has_noise: false,
            has_effects: false,
            is_backup,
        }
    }

    #[test]
    fn backups_and_device_only_setups_are_not_offered() {
        let entries = [
            entry("Talk", true, false),
            entry("Devices only", false, false),
            entry("__backup_previous", true, true),
        ];
        assert_eq!(choices(&entries), ["Talk"]);
        assert_eq!(backup_name(&entries), Some("__backup_previous"));
        assert_eq!(backup_name(&entries[..2]), None);
    }

    #[test]
    fn names_are_trimmed_and_never_overwrite() {
        let entries = [
            entry("Talk", true, false),
            entry("__backup_previous", true, true),
        ];
        assert_eq!(save_name("  Sing ", &entries), Ok("Sing".into()));
        assert_eq!(save_name("   ", &entries), Err(NameIssue::Empty));
        assert_eq!(save_name("Talk ", &entries), Err(NameIssue::Exists));
        assert_eq!(save_name("talk", &entries), Err(NameIssue::Exists));
        assert_eq!(
            save_name("__backup_previous", &entries),
            Err(NameIssue::Exists)
        );
    }
}

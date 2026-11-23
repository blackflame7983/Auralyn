//! 入口の種類の構造の試験（F1b-0b-2b。12.4）。ソースの入口の名前・要求の変種を読み、
//! 表（`class.rs`）と一致することを固定する。新しい入口・要求を足した PR で、分類の付け忘れを CI が落とす。
//! Y15・Y16・Y21・Y31・Y33。
use super::control::{
    class_of, request_class_of, ControlError, Entry, EntryKind, JobClass, BUSY_TEXT, EXPIRED_TEXT,
    NAME_CLASSES, NAME_PAIRS, REQUEST_CLASSES, REQUEST_ENTRIES, REQUEST_PAIRS, STOPPED_FIRST_TEXT,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub(super) fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if path.is_dir() {
            if name != "tests" {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") {
            out.push(path);
        }
    }
}

/// 試験の項目（`#[cfg(test)]`の付いた項目）を、波括弧の対応で飛ばしたソース。
pub(super) fn production_source(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    let mut kept = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim() != "#[cfg(test)]" {
            kept.push(line);
            continue;
        }
        let (mut depth, mut opened) = (0_i64, false);
        for item in lines.by_ref() {
            let (delta, has_open) = brace_delta(item);
            depth += delta;
            opened |= has_open;
            let trimmed = item.trim_end();
            if depth <= 0 && (opened || trimmed.ends_with(';')) {
                break;
            }
        }
    }
    kept.join("\n")
}

/// 1行の波括弧の増減。文字列・文字・コメントの中は数えない。
fn brace_delta(line: &str) -> (i64, bool) {
    let (mut delta, mut opened) = (0_i64, false);
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '/' if chars.get(i + 1) == Some(&'/') => break,
            '"' => {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            '\'' if chars.get(i + 2) == Some(&'\'') => i += 2,
            '\'' if chars.get(i + 1) == Some(&'\\') && chars.get(i + 3) == Some(&'\'') => i += 3,
            '{' => {
                delta += 1;
                opened = true;
            }
            '}' => delta -= 1,
            _ => {}
        }
        i += 1;
    }
    (delta, opened)
}

/// 入口を作るソースの一覧。
fn entry_sources() -> Vec<(PathBuf, String)> {
    let mut files = Vec::new();
    rust_files(&src().join("audio"), &mut files);
    rust_files(&src().join("commands"), &mut files);
    for name in [
        "audio.rs",
        "lib.rs",
        "shortcuts.rs",
        "obs.rs",
        "updates.rs",
        "migration.rs",
        "temporary_session.rs",
    ] {
        files.push(src().join(name));
    }
    files
        .into_iter()
        .map(|path| {
            let text = production_source(&path);
            (path, text)
        })
        .collect()
}

fn first_literal_after(text: &str, from: usize) -> Option<String> {
    let rest = &text[from..];
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')? + start;
    Some(rest[start..end].to_owned())
}

/// `(入口の名前, `.class(`が続くか)`の一覧。`Entry::command("…")`・`Entry::bundle("…")`・`Entry::new(…, "…")`。
fn used_entries() -> Vec<(String, String, bool)> {
    let mut found = Vec::new();
    for (path, text) in entry_sources() {
        let file = path
            .strip_prefix(src())
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for (marker, kind) in [
            ("Entry::command(", "command"),
            ("Entry::bundle(", "bundle"),
            ("Entry::new(", "new"),
        ] {
            let mut at = 0;
            while let Some(found_at) = text[at..].find(marker) {
                let after = at + found_at + marker.len();
                at = after;
                let Some(name) = first_literal_after(&text, after) else {
                    continue;
                };
                let close =
                    text[after..].find(&format!("\"{name}\"")).unwrap() + after + name.len() + 2;
                let tail = text[close..].trim_start();
                let tail = tail.strip_prefix(',').unwrap_or(tail).trim_start();
                let tail = tail.strip_prefix(')').unwrap_or(tail).trim_start();
                found.push((name, format!("{kind} {file}"), tail.starts_with(".class(")));
            }
        }
    }
    found
}

fn table() -> BTreeMap<&'static str, JobClass> {
    let mut map = BTreeMap::new();
    for (name, class) in NAME_CLASSES {
        assert!(map.insert(*name, *class).is_none(), "{name} が表に2回ある");
    }
    map
}

// Y15：ソースの入口の名前のすべてが表にあり、表のすべての名前が使われている。未知は Starting。
#[test]
fn y15_every_entry_name_is_classified_exactly_once() {
    let table = table();
    let used: BTreeSet<String> = used_entries()
        .into_iter()
        .map(|(name, _, _)| name)
        .collect();
    assert!(used.len() > 60, "入口の名前を拾えていない: {}", used.len());
    for name in &used {
        assert!(
            table.contains_key(name.as_str()),
            "入口 {name} が class.rs の NAME_CLASSES に無い（新しい入口は種類を決める）"
        );
    }
    for name in table.keys() {
        assert!(
            used.contains(*name),
            "表の {name} がどこからも使われていない（古い名前が残っている）"
        );
    }
    assert_eq!(
        class_of(Entry::command("a_name_nobody_registered")),
        JobClass::Starting,
        "未知の名前は、停止の後に開始する側へ倒さない"
    );
    assert_eq!(
        class_of(Entry::new(EntryKind::Scheduler, "anything")),
        JobClass::Tick
    );
    assert_eq!(
        class_of(Entry::new(EntryKind::Tray, "anything")),
        JobClass::Mute
    );
    assert_eq!(
        class_of(Entry::command("get_audio_state").class(JobClass::Starting)),
        JobClass::Starting,
        "要求で決めた種類が名前の既定より優先される"
    );
    for (name, class) in NAME_CLASSES {
        assert_eq!(class_of(Entry::command(name)), *class, "{name}");
    }
}

// Y16：今の3種は入口ごとの文言のまま、新しい3種は共通の承認済みの文言。
#[test]
fn y16_control_errors_keep_the_old_texts_and_use_the_approved_new_texts() {
    assert_eq!(
        BUSY_TEXT,
        "音声の操作が混み合っています。しばらくしてから、もう一度操作してください。"
    );
    assert_eq!(
        EXPIRED_TEXT,
        "前の音声の操作が長引いているため、この操作は実行しませんでした。前の操作が終わってから、もう一度操作してください。"
    );
    assert_eq!(
        STOPPED_FIRST_TEXT,
        "停止が先に行われたため、この操作は実行しませんでした。必要なら、もう一度操作してください。"
    );
    for old in [
        ControlError::Poisoned,
        ControlError::Stopped,
        ControlError::Reentrant,
    ] {
        assert_eq!(old.text("入口の文言"), "入口の文言");
    }
    assert_eq!(ControlError::Busy.text("入口の文言"), BUSY_TEXT);
    assert_eq!(ControlError::Expired.text("入口の文言"), EXPIRED_TEXT);
    assert_eq!(
        ControlError::StoppedFirst.text("入口の文言"),
        STOPPED_FIRST_TEXT
    );
    assert_eq!(ControlError::StoppedFirst.to_string(), STOPPED_FIRST_TEXT);
    let wrapped = anyhow::Error::from(ControlError::StoppedFirst);
    assert_eq!(
        wrapped.downcast_ref::<ControlError>(),
        Some(&ControlError::StoppedFirst),
        "anyhow で型を保つ"
    );
    assert!(
        super::localize_audio_error(wrapped.to_string()).contains(STOPPED_FIRST_TEXT),
        "localize_audio_error を通っても文言が失われない（包まれる）"
    );
}

fn variant_names(source: &str, header: &str) -> Vec<String> {
    let start = source
        .find(header)
        .unwrap_or_else(|| panic!("{header} が無い"));
    let body_start = source[start..].find('{').unwrap() + start + 1;
    let mut depth = 1_usize;
    let mut names = Vec::new();
    let mut line_start = true;
    for (offset, ch) in source[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            '\n' => {
                line_start = true;
                continue;
            }
            c if c.is_whitespace() => continue,
            _ => {}
        }
        if line_start && depth == 1 && ch.is_ascii_uppercase() {
            let rest = &source[body_start + offset..];
            let end = rest
                .find(|c: char| !c.is_ascii_alphanumeric())
                .unwrap_or(rest.len());
            names.push(rest[..end].to_owned());
        }
        line_start = false;
    }
    names
}

/// 要求の列挙：`(入口, ソース, 列挙の見出し)`。
const REQUEST_ENUMS: &[(&str, &str, &str)] = &[
    ("post_mix", "audio/post_mix.rs", "pub(crate) enum Request {"),
    ("mixing", "audio/mixing.rs", "pub(crate) enum Request {"),
    (
        "live_modes",
        "audio_engine/live_modes.rs",
        "pub enum Request {",
    ),
    ("session_rack", "ipc.rs", "pub enum SessionRackRequest {"),
    (
        "builtin_effects",
        "audio_engine/builtin.rs",
        "pub enum Request {",
    ),
    (
        "auto_gain",
        "audio_engine/auto_gain.rs",
        "pub enum Request {",
    ),
    (
        "noise_measurement",
        "audio_engine/core/noise_learning.rs",
        "pub enum Request {",
    ),
    (
        "voice_check_preview",
        "audio_engine/voice_check_preview.rs",
        "pub enum Action {",
    ),
];

/// 名前に取り消し・停止・解除の意味を含む要求の変種。Release でなければならない（例外は理由つきで書く）。
const RELEASE_WORDS: &[&str] = &["Cancel", "Stop", "Close", "End", "Release", "Finish"];

#[test]
fn y21_request_tables_cover_every_variant_of_every_request_enum() {
    for (entry, file, header) in REQUEST_ENUMS {
        let source = production_source(&src().join(file));
        let variants = variant_names(&source, header);
        assert!(
            variants.len() >= 5,
            "{entry}: 変種を拾えていない {variants:?}"
        );
        let table: BTreeSet<&str> = REQUEST_CLASSES
            .iter()
            .filter(|row| row.entry == *entry)
            .map(|row| row.variant)
            .collect();
        for variant in &variants {
            assert!(
                table.contains(variant.as_str()),
                "{entry} の要求 {variant} が REQUEST_CLASSES に無い"
            );
            if RELEASE_WORDS.iter().any(|word| variant.contains(word)) {
                assert_eq!(
                    request_class_of(entry, variant),
                    JobClass::Release,
                    "{entry}({variant}) は取り消し・解除の名前なので Release"
                );
            }
        }
        for variant in &table {
            assert!(
                variants.iter().any(|name| name == variant),
                "REQUEST_CLASSES の {entry}({variant}) が列挙に無い（古い）"
            );
        }
    }
}

// Y21：取得と解放は、入口の名前でも要求の変種でも対で表になり、解放は Release、取得は断られてよい種類。
#[test]
fn y21_acquire_and_release_are_paired_by_name_and_by_request_and_release_is_never_refused() {
    let table = table();
    let mut acquires = BTreeSet::new();
    let mut releases = BTreeSet::new();
    for (acquire, release) in NAME_PAIRS {
        assert_eq!(table.get(release), Some(&JobClass::Release), "{release}");
        assert!(
            matches!(
                table.get(acquire),
                Some(JobClass::Normal | JobClass::Starting)
            ),
            "{acquire}"
        );
        assert_ne!(acquire, release, "1つの名前が取得と解放を兼ねない");
        acquires.insert(*acquire);
        releases.insert(*release);
    }
    assert!(
        acquires.is_disjoint(&releases),
        "取得の名前が解放にも使われている"
    );
    for (name, class) in NAME_CLASSES {
        if *class == JobClass::Release {
            assert!(
                releases.contains(name),
                "Release の {name} が取得と解放の対の解放になっていない"
            );
        }
    }
    let mut seen = BTreeSet::new();
    for (name, _, _) in used_entries() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if ["end_", "cancel_", "finish_", "stop_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            assert!(
                matches!(
                    table.get(name.as_str()),
                    Some(JobClass::Release | JobClass::Stop)
                ),
                "取り消し・解除の名前の入口 {name} は、Release か Stop でなければならない"
            );
        }
    }
    for (entry, acquire, release) in REQUEST_PAIRS {
        assert_eq!(
            request_class_of(entry, release),
            JobClass::Release,
            "{entry}({release})"
        );
        assert_eq!(
            request_class_of(entry, acquire),
            JobClass::Starting,
            "{entry}({acquire})"
        );
    }
    for row in REQUEST_CLASSES {
        assert!(
            REQUEST_ENTRIES.contains(&row.entry),
            "{} は要求で決める入口の一覧に無い",
            row.entry
        );
    }
}

// Y31：上限・期限・取り消し・fence・レーンの判定は、`JobClass`の網羅の`match`のメソッド（`_ =>`なし）だけが持つ。
#[test]
fn y31_job_class_decisions_are_exhaustive_matches_in_one_place() {
    let source = production_source(&src().join("audio/control/class.rs"));
    let start = source.find("impl JobClass {").unwrap();
    let end = source[start..].find("\n}\n").unwrap() + start;
    let methods = &source[start..end];
    for name in [
        "fn counted",
        "fn waits_with_deadline",
        "fn refused_after_stop",
        "fn lane",
        "fn raises_fence",
    ] {
        assert!(methods.contains(name), "{name} が無い");
    }
    assert_eq!(methods.matches("match self").count(), 5);
    assert!(
        !methods.contains("_ =>"),
        "網羅の match（新しい種類を足すとコンパイルが落ちる）に`_ =>`を使わない"
    );
    for file in [
        "audio/control/queue.rs",
        "audio/control/actor.rs",
        "audio/control.rs",
    ] {
        let text = production_source(&src().join(file));
        assert!(
            !text.contains("JobClass::"),
            "{file} が種類を直接見ている。判定は JobClass のメソッドだけで行う"
        );
    }
}

// Y33：要求で種類を決める入口の表と、ソースの`Entry`の呼び出し（`.class(…)`の指定）が一致する。
#[test]
fn y33_the_request_dependent_entry_table_matches_the_source() {
    let used = used_entries();
    for name in REQUEST_ENTRIES {
        let uses: Vec<_> = used.iter().filter(|(used, _, _)| used == name).collect();
        assert!(!uses.is_empty(), "{name} がどこからも使われていない");
        for (_, place, with_class) in uses {
            assert!(
                place.starts_with("command "),
                "{name} は Entry::command で要求から種類を決めて呼ぶ（{place}）"
            );
            assert!(
                with_class,
                "{name} は要求で種類を決める入口なのに、`.class(…)`の指定が無い（{place}）"
            );
        }
    }
    for (name, place, with_class) in &used {
        if *with_class {
            assert!(
                REQUEST_ENTRIES.contains(&name.as_str()),
                "{name} に`.class(…)`を指定しているが、要求で決める入口の一覧に無い（{place}）"
            );
        }
    }
}

//! ミックス後の VST：声とオケを混ぜた後の配信音だけを仕上げる、声用とは別の並び。
//! 何ができるか・いつできるかは Tauri 版（`PostMixPanel.tsx`・`audio/post_mix.rs`）に揃える。

/// 並びの1つのうち、保存と比べる分。
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub path: String,
    pub class_id: Option<String>,
    pub enabled: bool,
    pub muted: bool,
    pub gain: f32,
}

/// エンジンから読んだ状態（並びそのものは別に届く）。
#[derive(Clone, Debug, PartialEq)]
pub struct PostMix {
    /// 配信音に掛ける（音声を始めると効く）。
    pub enabled: bool,
    /// 配信 VST のエンジンが動いている。
    pub running: bool,
    /// 保存してある VST の名前。
    pub saved: Vec<String>,
    /// 保存した並びを読み込み済み。読み込むまで（起動し直したあと）は、有効にも保存にもできない。
    pub restored: bool,
    /// 今の並びが保存と違う。
    pub unsaved: bool,
    /// 動かしている途中で止まった。
    pub failed: bool,
    pub error: Option<String>,
}

/// 有効にできない理由（並べた順に確かめる。Tauri 版と同じ）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    /// オケを適用していない。
    NeedsMix,
    /// 保存した並びを読み込んでいない。
    NotRestored,
    /// 音声が動いている（追加・削除・並べ替え・有効の切り替えは止めてから）。
    Running,
}

impl PostMix {
    /// 有効にできない理由。無効にするのはいつでもできる（音声を止めていれば）。
    pub fn enable_block(&self, mix_active: bool, audio_running: bool) -> Option<Block> {
        if !mix_active {
            Some(Block::NeedsMix)
        } else if !self.restored {
            Some(Block::NotRestored)
        } else if audio_running {
            Some(Block::Running)
        } else {
            None
        }
    }
}

/// 今の並びが保存と違うか。音量は小さな丸めの違いを無視し、クラス ID は大小文字を区別しない。
pub fn unsaved(saved: &[Entry], current: &[Entry]) -> bool {
    saved.len() != current.len()
        || saved.iter().zip(current).any(|(a, b)| {
            a.path != b.path
                || !a
                    .class_id
                    .as_deref()
                    .map(str::to_lowercase)
                    .eq(&b.class_id.as_deref().map(str::to_lowercase))
                || a.enabled != b.enabled
                || a.muted != b.muted
                || (a.gain - b.gain).abs() > 1e-4
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, gain: f32) -> Entry {
        Entry {
            path: path.into(),
            class_id: Some("ABC".into()),
            enabled: true,
            muted: false,
            gain,
        }
    }

    #[test]
    fn enabling_needs_mix_then_restore_then_stop() {
        let post = PostMix {
            enabled: false,
            running: false,
            saved: Vec::new(),
            restored: false,
            unsaved: false,
            failed: false,
            error: None,
        };
        assert_eq!(post.enable_block(false, false), Some(Block::NeedsMix));
        assert_eq!(post.enable_block(true, true), Some(Block::NotRestored));
        let restored = PostMix {
            restored: true,
            ..post
        };
        assert_eq!(restored.enable_block(true, true), Some(Block::Running));
        assert_eq!(restored.enable_block(true, false), None);
    }

    #[test]
    fn unsaved_ignores_rounding_and_class_id_case() {
        let saved = [entry("a.vst3", 1.0), entry("b.vst3", 0.5)];
        let mut current = saved.to_vec();
        current[1].gain = 0.500_01;
        current[0].class_id = Some("abc".into());
        assert!(!unsaved(&saved, &current));
        current[1].muted = true;
        assert!(unsaved(&saved, &current));
        assert!(unsaved(&saved, &saved[..1]));
        current.swap(0, 1);
        assert!(unsaved(&saved, &current));
    }
}

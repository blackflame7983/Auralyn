//! ミックス後の VST：声とオケを混ぜた後の配信音だけを仕上げる、声用とは別の並び。
//! 何ができるか・いつできるかは `audio/post_mix.rs` に揃える。

/// エンジンから読んだ状態（並びそのものは別に届く）。
#[derive(Clone, Debug, PartialEq)]
pub struct PostMix {
    /// 読んだときの世代（epoch・revision）。変える操作に付けて、見た後に変わっていれば断らせる。
    pub seen: (String, String),
    /// 配信音に掛ける（音声を始めると効く）。
    pub enabled: bool,
    /// 配信 VST のエンジンが動いている。
    pub running: bool,
    /// 保存してある VST の名前。
    pub saved: Vec<String>,
    /// 保存した並びを読み込み済み。読み込むまで（起動し直したあと）は、有効にも保存にもできない。
    pub restored: bool,
    /// 動かしている途中で止まった。
    pub failed: bool,
    pub error: Option<String>,
}

/// 有効にできない理由（並べた順に確かめる）。
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabling_needs_mix_then_restore_then_stop() {
        let post = PostMix {
            seen: Default::default(),
            enabled: false,
            running: false,
            saved: Vec::new(),
            restored: false,
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
}

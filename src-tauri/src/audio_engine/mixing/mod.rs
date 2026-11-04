//! 声とオケの固定二入力。取得・時間合わせ・本人用の返しを別々に所有する。
mod alignment;
pub(crate) mod controls;
pub(crate) mod input;
mod model;
pub(crate) mod runtime;

pub(crate) use alignment::{AlignedMixer, Delays};
pub use model::{ClockSnapshot, Config, Levels, Request, Snapshot, Source, Start, Track};

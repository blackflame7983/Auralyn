//! 画面の振る舞い。描画から独立させ、時刻や入力を引数で受けて `cargo test` だけで確かめる。
//!
//! このクレートは GPUI・Tauri・音声エンジンのどれにも依存しない。部品（GPUI）はここの結果を描くだけにする。
pub mod connect;
pub mod diagnostics;
pub mod docs;
pub mod flow;
pub mod live_modes;
pub mod live_output;
pub mod measurement;
pub mod meter;
pub mod mix;
pub mod obs;
pub mod obs_timing;
pub mod peak;
pub mod post_mix;
pub mod preparation;
pub mod profile;
pub mod rack;
pub mod recovery;
pub mod scene_routing;
pub mod session;
pub mod setup;
pub mod shortcuts;
pub mod sound;
pub mod voice_check;

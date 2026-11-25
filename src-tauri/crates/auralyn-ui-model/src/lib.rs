//! 画面の振る舞い。描画から独立させ、時刻や入力を引数で受けて `cargo test` だけで確かめる。
//!
//! このクレートは GPUI・Tauri・音声エンジンのどれにも依存しない。部品（GPUI）はここの結果を描くだけにする。
pub mod connect;
pub mod flow;
pub mod meter;
pub mod peak;
pub mod rack;
pub mod session;
pub mod sound;

//! UI に依存しない Auralyn の中核。
//!
//! 画面の層（GPUI）は、このクレートの命令・出来事・文言・デザイントークンだけを使う。
//! このクレートは画面の層のクレートに依存しない。
pub mod design;
pub mod event;
pub mod i18n;

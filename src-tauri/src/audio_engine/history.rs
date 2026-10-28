//! 設定履歴を失った根拠。制御側でのみ更新し、録音データや旧トークンは保持しない。
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    #[default]
    NotCreated,
    SettingsChanged,
    InputChanged,
    LearningChanged,
    NewMeasurement,
    StreamChanged,
    StreamFailed,
    ConditionsChanged,
}

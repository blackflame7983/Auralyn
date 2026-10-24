//! 内蔵処理設定の制御側CAS。既存APIも同じrevisionへ集約する。
use super::singing::SingingParams;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Broadcast,
    Warm,
    Bright,
    Singing,
}
impl Preset {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Broadcast => "broadcast",
            Self::Warm => "warm",
            Self::Bright => "bright",
            Self::Singing => "singing",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub active: bool,
    pub preset: Preset,
    pub amount: f32,
    #[serde(default)]
    pub singing: Option<SingingParams>,
    #[serde(default)]
    pub reverb: Option<super::reverb::ReverbParams>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            active: false,
            preset: Preset::Broadcast,
            amount: 0.7,
            singing: None,
            reverb: None,
        }
    }
}
impl Config {
    pub fn normalize(mut self) -> Result<Self, String> {
        if !self.amount.is_finite() || !(0.0..=1.0).contains(&self.amount) {
            return Err("内蔵処理の量が範囲外です".into());
        }
        if let Some(params) = self.reverb {
            params.validate()?;
        }
        if let Some(params) = self.singing {
            params.validate()?;
        }
        if self.preset == Preset::Singing && self.singing.is_none() {
            self.singing = Some(SingingParams::default());
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Snapshot,
    Apply {
        epoch: String,
        expected_revision: String,
        config: Config,
    },
    ApplyProposal {
        epoch: String,
        expected_revision: String,
        proposal_id: String,
        recording_id: u64,
    },
    Undo {
        epoch: String,
        expected_revision: String,
        undo_token: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub revision: String,
    pub applied_revision: String,
    pub config: Config,
    pub pending: bool,
    pub undo_token: Option<String>,
    pub error: Option<String>,
}
pub(crate) struct Controller {
    pub config: Config,
    pub revision: u64,
    pub applied: Arc<AtomicU64>,
    epoch: String,
    undo: Option<(String, Config)>,
}
impl Controller {
    pub(crate) fn new() -> Self {
        Self {
            config: Config::default(),
            revision: 1,
            applied: Arc::new(AtomicU64::new(0)),
            epoch: format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            undo: None,
        }
    }
    pub(crate) fn snapshot(&self, running: bool) -> Snapshot {
        let applied = self.applied.load(Ordering::Acquire);
        Snapshot {
            epoch: self.epoch.clone(),
            revision: self.revision.to_string(),
            applied_revision: applied.to_string(),
            config: self.config.clone(),
            pending: running && applied != self.revision,
            undo_token: self.undo.as_ref().map(|(token, _)| token.clone()),
            error: None,
        }
    }
    pub(crate) fn legacy(&mut self, config: Config) -> Result<(), String> {
        let config = config.normalize()?;
        self.bump()?;
        self.config = config;
        self.undo = None;
        Ok(())
    }
    fn bump(&mut self) -> Result<(), String> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("内蔵処理の操作回数上限です")?;
        Ok(())
    }
    pub(crate) fn request(&mut self, request: Request) -> Result<bool, String> {
        let (epoch, revision) = match &request {
            Request::Snapshot => return Ok(false),
            Request::Apply {
                epoch,
                expected_revision,
                ..
            }
            | Request::Undo {
                epoch,
                expected_revision,
                ..
            }
            | Request::ApplyProposal {
                epoch,
                expected_revision,
                ..
            } => (epoch, expected_revision),
        };
        if epoch != &self.epoch || revision != &self.revision.to_string() {
            return Err("内蔵処理が変更されました。現在の設定を取得し直してください".into());
        }
        match request {
            Request::Apply { config, .. } => {
                let config = config.normalize()?;
                let before = self.config.clone();
                self.bump()?;
                self.config = config;
                self.undo = Some((format!("{}:{}", self.epoch, self.revision), before));
            }
            Request::Undo { undo_token, .. } => {
                let (token, before) = self.undo.as_ref().ok_or("元に戻せる変更がありません")?;
                if token != &undo_token {
                    return Err("元に戻す操作の期限が切れました".into());
                }
                let before = before.clone();
                self.bump()?;
                self.config = before;
                self.undo = None;
            }
            Request::Snapshot => {}
            // 提案witnessはCoreだけが解決できる。直接のController利用では拒否する。
            Request::ApplyProposal { .. } => {
                return Err("提案を確認してから適用してください".into())
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn apply(controller: &mut Controller, config: Config) -> Result<bool, String> {
        let snapshot = controller.snapshot(false);
        controller.request(Request::Apply {
            epoch: snapshot.epoch,
            expected_revision: snapshot.revision,
            config,
        })
    }
    #[test]
    fn reverb_is_independent_validated_and_part_of_cas_undo() {
        let mut controller = Controller::new();
        let params = super::super::reverb::ReverbParams {
            enabled: true,
            ..Default::default()
        };
        apply(
            &mut controller,
            Config {
                reverb: Some(params),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!controller.config.active);
        let snapshot = controller.snapshot(false);
        assert!(snapshot.config.reverb.unwrap().enabled);
        controller
            .request(Request::Undo {
                epoch: snapshot.epoch,
                expected_revision: snapshot.revision,
                undo_token: snapshot.undo_token.unwrap(),
            })
            .unwrap();
        assert_eq!(controller.config, Config::default());
        let before = controller.revision;
        assert!(apply(
            &mut controller,
            Config {
                reverb: Some(super::super::reverb::ReverbParams {
                    mix: 0.26,
                    ..params
                }),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(controller.revision, before);
    }

    #[test]
    fn cas_epoch_one_undo_legacy_invalidation_and_defaults() {
        let mut controller = Controller::new();
        assert_eq!(controller.config, Config::default());
        let before = controller.snapshot(false);
        let config = Config {
            active: true,
            preset: Preset::Singing,
            amount: 0.7,
            singing: None,
            reverb: None,
        };
        apply(&mut controller, config.clone()).unwrap();
        assert_eq!(controller.config.singing, Some(SingingParams::default()));
        assert!(controller
            .request(Request::Apply {
                epoch: before.epoch.clone(),
                expected_revision: before.revision,
                config: config.clone()
            })
            .is_err());
        let current = controller.snapshot(false);
        assert!(controller
            .request(Request::Apply {
                epoch: "old-engine".into(),
                expected_revision: current.revision.clone(),
                config
            })
            .is_err());
        controller
            .request(Request::Undo {
                epoch: current.epoch,
                expected_revision: current.revision,
                undo_token: current.undo_token.unwrap(),
            })
            .unwrap();
        assert_eq!(controller.config, Config::default());
        assert!(controller.snapshot(false).undo_token.is_none());
        apply(&mut controller, Config::default()).unwrap();
        controller.legacy(Config::default()).unwrap();
        assert!(controller.snapshot(false).undo_token.is_none());
        assert!(serde_json::from_str::<Config>(
            r#"{"active":false,"preset":"broadcast","amount":0.7}"#
        )
        .unwrap()
        .singing
        .is_none());
    }
}

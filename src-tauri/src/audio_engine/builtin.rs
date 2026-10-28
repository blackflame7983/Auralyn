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
    Redo {
        epoch: String,
        expected_revision: String,
        redo_token: String,
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
    pub redo_token: Option<String>,
    pub error: Option<String>,
}
pub(crate) struct Controller {
    pub config: Config,
    pub revision: u64,
    pub applied: Arc<AtomicU64>,
    epoch: String,
    history: Option<History>,
}
struct History {
    id: u64,
    before: Config,
    after: Config,
    after_selected: bool,
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
            history: None,
        }
    }
    pub(crate) fn snapshot(&self, running: bool) -> Snapshot {
        let applied = self.applied.load(Ordering::Acquire);
        let pending = running && applied != self.revision;
        let history = self.history.as_ref().filter(|_| !pending);
        Snapshot {
            epoch: self.epoch.clone(),
            revision: self.revision.to_string(),
            applied_revision: applied.to_string(),
            config: self.config.clone(),
            pending,
            undo_token: history
                .filter(|h| h.after_selected)
                .map(|h| format!("{}:{}:undo", self.epoch, h.id)),
            redo_token: history
                .filter(|h| !h.after_selected)
                .map(|h| format!("{}:{}:redo", self.epoch, h.id)),
            error: None,
        }
    }
    pub(crate) fn legacy(&mut self, config: Config) -> Result<(), String> {
        let config = config.normalize()?;
        self.bump()?;
        self.config = config;
        self.history = None;
        Ok(())
    }
    pub(crate) fn invalidate_history(&mut self) {
        self.history = None;
    }
    fn bump(&mut self) -> Result<(), String> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("内蔵処理の操作回数上限です")?;
        Ok(())
    }
    pub(crate) fn request(&mut self, request: Request, running: bool) -> Result<bool, String> {
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
            | Request::Redo {
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
        if running && self.applied.load(Ordering::Acquire) != self.revision {
            return Err("内蔵処理の反映を確認中です".into());
        }
        match request {
            Request::Apply { config, .. } => {
                let config = config.normalize()?;
                let before = self.config.clone();
                self.bump()?;
                self.config = config.clone();
                self.history = Some(History {
                    id: self.revision,
                    before,
                    after: config,
                    after_selected: true,
                });
            }
            Request::Undo { undo_token, .. } => {
                let history = self.history.as_ref().ok_or("元に戻せる変更がありません")?;
                if !history.after_selected
                    || format!("{}:{}:undo", self.epoch, history.id) != undo_token
                {
                    return Err("元に戻す操作の期限が切れました".into());
                }
                let before = history.before.clone();
                self.bump()?;
                self.config = before;
                self.history
                    .as_mut()
                    .expect("照合済みの履歴")
                    .after_selected = false;
            }
            Request::Redo { redo_token, .. } => {
                let history = self
                    .history
                    .as_ref()
                    .ok_or("再適用できる変更がありません")?;
                if history.after_selected
                    || format!("{}:{}:redo", self.epoch, history.id) != redo_token
                {
                    return Err("再適用する操作の期限が切れました".into());
                }
                let after = history.after.clone();
                self.bump()?;
                self.config = after;
                self.history
                    .as_mut()
                    .expect("照合済みの履歴")
                    .after_selected = true;
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
        controller.request(
            Request::Apply {
                epoch: snapshot.epoch,
                expected_revision: snapshot.revision,
                config,
            },
            false,
        )
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
            .request(
                Request::Undo {
                    epoch: snapshot.epoch,
                    expected_revision: snapshot.revision,
                    undo_token: snapshot.undo_token.unwrap(),
                },
                false,
            )
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
            .request(
                Request::Apply {
                    epoch: before.epoch.clone(),
                    expected_revision: before.revision,
                    config: config.clone()
                },
                false
            )
            .is_err());
        let current = controller.snapshot(false);
        assert!(controller
            .request(
                Request::Apply {
                    epoch: "old-engine".into(),
                    expected_revision: current.revision.clone(),
                    config
                },
                false
            )
            .is_err());
        controller
            .request(
                Request::Undo {
                    epoch: current.epoch,
                    expected_revision: current.revision,
                    undo_token: current.undo_token.unwrap(),
                },
                false,
            )
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

    #[test]
    fn latest_one_undo_redo_roundtrip_waits_for_applied_ack() {
        let mut c = Controller::new();
        c.applied.store(c.revision, Ordering::Release);
        let initial = c.snapshot(true);
        let after = Config {
            active: true,
            amount: 0.4,
            ..Default::default()
        };
        c.request(
            Request::Apply {
                epoch: initial.epoch.clone(),
                expected_revision: initial.revision,
                config: after.clone(),
            },
            true,
        )
        .unwrap();
        let pending = c.snapshot(true);
        assert!(pending.pending);
        assert!(pending.undo_token.is_none() && pending.redo_token.is_none());
        assert!(c
            .request(
                Request::Undo {
                    epoch: pending.epoch.clone(),
                    expected_revision: pending.revision.clone(),
                    undo_token: "stale".into()
                },
                true
            )
            .is_err());
        assert!(c
            .request(
                Request::Apply {
                    epoch: pending.epoch.clone(),
                    expected_revision: pending.revision.clone(),
                    config: Config::default(),
                },
                true,
            )
            .is_err());
        assert_eq!(c.config, after);
        // ACKが来ない間は原本を破棄せず、次の操作へ進めない。
        assert!(c.history.is_some());
        c.applied.store(c.revision, Ordering::Release);
        let applied = c.snapshot(true);
        let undo_token = applied.undo_token.clone().unwrap();
        c.request(
            Request::Undo {
                epoch: applied.epoch.clone(),
                expected_revision: applied.revision,
                undo_token: undo_token.clone(),
            },
            true,
        )
        .unwrap();
        assert_eq!(c.config, Config::default());
        let pending_undo = c.snapshot(true);
        assert!(
            pending_undo.pending
                && pending_undo.undo_token.is_none()
                && pending_undo.redo_token.is_none()
        );
        c.applied.store(c.revision, Ordering::Release);
        let undone = c.snapshot(true);
        assert!(undone.undo_token.is_none());
        let redo_token = undone.redo_token.unwrap();
        c.request(
            Request::Redo {
                epoch: undone.epoch.clone(),
                expected_revision: undone.revision.clone(),
                redo_token: "stale".into(),
            },
            true,
        )
        .unwrap_err();
        c.request(
            Request::Redo {
                epoch: undone.epoch.clone(),
                expected_revision: undone.revision,
                redo_token,
            },
            true,
        )
        .unwrap();
        assert_eq!(c.config, after);
        assert!(c.snapshot(true).pending);
        c.applied.store(c.revision, Ordering::Release);
        let redone = c.snapshot(true);
        assert_eq!(redone.undo_token.as_deref(), Some(undo_token.as_str()));
        c.request(
            Request::Undo {
                epoch: redone.epoch,
                expected_revision: redone.revision,
                undo_token,
            },
            true,
        )
        .unwrap();
        assert_eq!(c.config, Config::default());
    }

    #[test]
    fn latest_replaces_history_and_manual_a_b_a_does_not_revive_it() {
        let mut c = Controller::new();
        let first = Config {
            active: true,
            ..Default::default()
        };
        apply(&mut c, first.clone()).unwrap();
        let old = c.snapshot(false);
        let second = Config {
            active: true,
            amount: 0.3,
            ..Default::default()
        };
        apply(&mut c, second.clone()).unwrap();
        let current = c.snapshot(false);
        assert!(c
            .request(
                Request::Undo {
                    epoch: current.epoch.clone(),
                    expected_revision: current.revision.clone(),
                    undo_token: old.undo_token.unwrap()
                },
                false
            )
            .is_err());
        c.request(
            Request::Undo {
                epoch: current.epoch,
                expected_revision: current.revision,
                undo_token: current.undo_token.unwrap(),
            },
            false,
        )
        .unwrap();
        assert_eq!(c.config, first);
        let redo = c.snapshot(false);
        c.legacy(second).unwrap();
        c.legacy(first).unwrap();
        assert!(c.snapshot(false).redo_token.is_none());
        assert!(c
            .request(
                Request::Redo {
                    epoch: redo.epoch,
                    expected_revision: c.revision.to_string(),
                    redo_token: redo.redo_token.unwrap()
                },
                false
            )
            .is_err());
        let fresh = Controller::new();
        assert_ne!(c.snapshot(false).epoch, fresh.snapshot(false).epoch);
        assert!(
            fresh.snapshot(false).undo_token.is_none()
                && fresh.snapshot(false).redo_token.is_none()
        );
    }
}

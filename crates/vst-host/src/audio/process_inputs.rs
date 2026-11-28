//! 候補の実行状態はHostの寿命内だけ保持し、保存設定には含めない。
use super::*;
use crate::input_source::{Config, Request, Start, Target};

#[derive(Default)]
pub(super) struct Inputs {
    serial: u64,
    candidates: std::collections::HashMap<String, (Config, Target)>,
    pub(super) selected: Option<Start>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    id: String,
    app_key: String,
    name: String,
    routes: Vec<crate::audio_engine::process_capture::sessions::Route>,
}

impl AudioHost {
    pub(crate) fn process_input_sources(&mut self) -> Result<Vec<Candidate>> {
        let sources = crate::audio_engine::process_capture::candidates()?;
        let mut listed = Vec::new();
        let previous = std::mem::take(&mut self.process_inputs.candidates);
        for source in sources.into_iter().take(256) {
            let id = previous.iter().find_map(|(id, (config, target))| {
                (target.pid == source.pid && target.created == source.created
                    && matches!(config, Config::ProcessLoopback(c) if c.app_key == source.app_key)).then(|| id.clone())
            }).unwrap_or_else(|| {
                self.process_inputs.serial = self.process_inputs.serial.wrapping_add(1);
                format!("app-{}", self.process_inputs.serial)
            });
            let config = Config::ProcessLoopback(crate::input_source::ProcessConfig {
                app_key: source.app_key.clone(),
                app_name: source.name.clone(),
                raw_endpoint_id: String::new(),
                purpose: crate::input_source::Purpose::Music,
            });
            self.process_inputs.candidates.insert(
                id.clone(),
                (
                    config,
                    Target {
                        pid: source.pid,
                        created: source.created,
                    },
                ),
            );
            listed.push(Candidate {
                id,
                app_key: source.app_key,
                name: source.name,
                routes: source.routes,
            });
        }
        Ok(listed)
    }

    pub(crate) fn resolve_input_source(&self, request: Option<Request>) -> Result<Option<Start>> {
        let Some(request) = request else {
            // 新形式を扱えない復旧・プロファイル経路に、既定マイクへの暗黙復帰を許さない。
            anyhow::ensure!(
                self.active_config
                    .as_ref()
                    .and_then(|c| c.input_source.as_ref())
                    .is_none_or(|source| *source == Config::default()),
                "現在の入力はこの操作に対応していません。音声設定から入力を選んでください"
            );
            return Ok(None);
        };
        request.source.validate().map_err(anyhow::Error::msg)?;
        let target = match &request.source {
            Config::Device { .. } => {
                anyhow::ensure!(
                    request.candidate_id.is_none(),
                    "機器入力にアプリの選択情報は使えません"
                );
                None
            }
            Config::ProcessLoopback(config) => {
                let target = if let Some(id) = request.candidate_id.as_ref() {
                    let (Config::ProcessLoopback(listed), target) = self
                        .process_inputs
                        .candidates
                        .get(id)
                        .ok_or_else(|| anyhow!("アプリの一覧を更新して選び直してください"))?
                    else {
                        unreachable!()
                    };
                    anyhow::ensure!(
                        listed.app_key == config.app_key && listed.app_name == config.app_name,
                        "選んだアプリの情報が一致しません"
                    );
                    target.clone()
                } else {
                    self.process_inputs
                        .selected
                        .as_ref()
                        .filter(|s| s.source == request.source)
                        .and_then(|s| s.target.clone())
                        .ok_or_else(|| anyhow!("音声設定で起動中のアプリを選び直してください"))?
                };
                crate::audio_engine::process_capture::config_validation(config, &target)?;
                Some(target)
            }
        };
        Ok(Some(Start {
            source: request.source,
            target,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_with_input_source(
        &mut self,
        host: Option<String>,
        input: Option<String>,
        output: Option<String>,
        buffer: Option<u32>,
        rate: Option<u32>,
        input_id: Option<String>,
        output_id: Option<String>,
        routing: Option<crate::ipc::ChannelRouting>,
        source: Option<Start>,
    ) -> Result<AudioConfig> {
        self.require_explicit_start();
        self.start_internal_with_source(
            host, input, output, buffer, rate, None, None, input_id, output_id, routing, source,
        )
    }

    pub(super) fn remember_input_source(&mut self, source: Option<Start>) {
        self.process_inputs.selected = source;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_process_input_cannot_resume_through_a_device_only_entry_or_a_new_host() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-source-readonly-test"));
        let source = Config::ProcessLoopback(crate::input_source::ProcessConfig {
            app_key: "a".repeat(64),
            app_name: "player.exe".into(),
            raw_endpoint_id: "raw".into(),
            purpose: crate::input_source::Purpose::Music,
        });
        host.active_config = Some(ActiveAudioConfig {
            input_source: Some(source.clone()),
            ..Default::default()
        });
        assert!(host.resolve_input_source(None).is_err());
        assert!(host
            .resolve_input_source(Some(Request {
                source,
                candidate_id: None
            }))
            .is_err());
        let explicit = host
            .resolve_input_source(Some(Request {
                source: Config::default(),
                candidate_id: None,
            }))
            .unwrap()
            .unwrap();
        assert!(explicit.target.is_none());
        assert!(host.child.is_none());
        assert!(host.process_inputs.candidates.is_empty());
    }

    #[test]
    fn unknown_candidate_and_mismatched_identity_fail_before_accessing_audio() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-source-registry-test"));
        let source = Config::ProcessLoopback(crate::input_source::ProcessConfig {
            app_key: "a".repeat(64),
            app_name: "player.exe".into(),
            raw_endpoint_id: "raw".into(),
            purpose: crate::input_source::Purpose::Voice,
        });
        let request = Request {
            source: source.clone(),
            candidate_id: Some("app-1".into()),
        };
        assert!(host.resolve_input_source(Some(request.clone())).is_err());
        let mut wrong = source;
        if let Config::ProcessLoopback(config) = &mut wrong {
            config.app_key = "b".repeat(64);
        }
        host.process_inputs
            .candidates
            .insert("app-1".into(), (wrong, Target { pid: 1, created: 1 }));
        assert!(host.resolve_input_source(Some(request)).is_err());
        assert!(host.child.is_none());
    }
}

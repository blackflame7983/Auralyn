#![warn(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::await_holding_lock)]

pub mod audio;
pub mod audio_analysis;
pub mod audio_engine;
/// GPUI 版からミックス後の VST を呼ぶための公開口（`audio::post_mix` 自体は crate 内に閉じる）。
pub mod post_mix {
    pub use crate::audio::post_mix::{Request, SavedPlugin, Snapshot};
}
/// GPUI 版から配信ミックスを呼ぶための公開口（`audio::mixing` 自体は crate 内に閉じる）。
pub mod mixing {
    pub use crate::audio::mixing::{Request, Snapshot};

    /// オケに選べる起動中のアプリ。
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct App {
        /// 適用のときに `Request::Configure` の `candidate_id` として渡す。一覧を読み直すまで有効。
        pub id: String,
        pub app_key: String,
        pub name: String,
        pub routes: Vec<Route>,
    }

    /// アプリが音を出している出力先。
    #[derive(serde::Deserialize)]
    pub struct Route {
        pub id: String,
        pub name: String,
        pub muted: bool,
    }

    /// 一覧を読む。候補の中身は crate の外へ出さず、直列化した形で受け取る。
    pub fn apps(host: &mut crate::audio::AudioHost) -> anyhow::Result<Vec<App>> {
        let listed = serde_json::to_value(host.process_input_sources()?)?;
        Ok(serde_json::from_value(listed)?)
    }
}
/// 入力の元（マイク・仮想ケーブルか、アプリの音声か）を選んで開始する。
pub mod input {
    pub use crate::input_source::{Config, ProcessConfig, Purpose, Request};

    /// `config` の入出力で開始する。入力の元は `config.input_source`（無ければ声のマイク）。
    /// アプリの音声は、`candidate_id`（一覧を読み直すまで有効）か、この起動で選んだ同じアプリで確かめる。
    pub fn start(
        host: &mut crate::audio::AudioHost,
        config: crate::audio::ActiveAudioConfig,
        candidate_id: Option<String>,
    ) -> anyhow::Result<()> {
        let source = config.input_source.unwrap_or(Config::Device {
            purpose: Purpose::Voice,
        });
        let source = host.resolve_input_source(Some(Request {
            source,
            candidate_id,
        }))?;
        host.start_with_input_source(
            Some(config.host),
            config.input,
            config.output,
            config.buffer_size,
            config.sample_rate,
            config.input_id,
            config.output_id,
            config.routing,
            source,
        )?;
        Ok(())
    }
}
/// GPUI 版から OBS の同期調整の対象を読む口（音声の条件 `audio::conditions` 自体は crate 内に閉じる）。
pub mod obs_timing {
    use std::sync::Arc;

    /// 対象を読んだ時点の音声の条件と、変更予定・適用のときの条件を比べるための手がかり。
    #[derive(Clone)]
    pub struct Conditions(Arc<crate::audio::conditions::Conditions>);

    pub fn conditions(host: &crate::audio::AudioHost) -> Conditions {
        Conditions(host.conditions())
    }

    pub async fn targets(
        state: &crate::obs::ObsState,
        conditions: &Conditions,
    ) -> Result<crate::obs_setup::TimingTargets, String> {
        crate::obs_setup::timing_targets(state, &conditions.0).await
    }
}
/// GPUI 版から機器の一覧を、子の走査を待たずに取る口（begin/poll）。
pub mod devices {
    use crate::audio::{AudioDeviceList, AudioHost, DeviceScanStart, DeviceScanTicket};

    /// 走査中の受付票。
    pub struct Scan(DeviceScanTicket);

    pub enum Start {
        Ready(AudioDeviceList),
        Pending(Scan),
    }

    pub fn begin(host: &mut AudioHost) -> anyhow::Result<Start> {
        Ok(match host.begin_device_scan(false)? {
            DeviceScanStart::Cached(list) => Start::Ready(list),
            DeviceScanStart::Pending(ticket) => Start::Pending(Scan(ticket)),
        })
    }

    /// 終わっていなければ `None`。
    pub fn poll(host: &mut AudioHost, scan: &Scan) -> anyhow::Result<Option<AudioDeviceList>> {
        host.poll_device_scan(&scan.0)
    }

    pub fn cancel(host: &mut AudioHost, scan: &Scan) -> anyhow::Result<()> {
        host.cancel_device_scan(&scan.0)
    }
}
pub mod bundle;
mod child_process;
#[cfg(test)]
mod class_id_serde_tests;
mod desktop_integration;
#[cfg(any(test, feature = "dsp-verification"))]
mod dsp_verification_allocator;
pub mod input_source;
pub mod ipc;
mod json_file;
pub mod obs;
pub mod obs_credentials;
pub mod obs_setup;
#[cfg(windows)]
mod process_job;
pub mod profile;
pub mod routing_diag;
pub mod vst_host;

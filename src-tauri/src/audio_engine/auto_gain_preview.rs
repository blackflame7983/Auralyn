//! 試聴専用WASAPI出力。通常の送出ストリームとゲインには触れない。
use super::auto_gain::PreviewDevice;
use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub struct Preview {
    _stream: cpal::Stream,
    pub playing: Arc<AtomicBool>,
    pub failed: Arc<AtomicBool>,
    pub started: std::time::Instant,
}

fn host() -> Result<cpal::Host> {
    cpal::host_from_id(cpal::HostId::Wasapi).map_err(Into::into)
}

// 両方の録音試聴で同じ制約を使う。既定出力への代替は行わない。
#[allow(deprecated)]
pub(super) fn output_device(
    device: &str,
    rate: u32,
    main_id: Option<&str>,
) -> Result<(cpal::Device, cpal::StreamConfig)> {
    if main_id == Some(device) {
        return Err(anyhow!("通常出力とは別の試聴先を選んでください"));
    }
    if !devices()?.iter().any(|candidate| candidate.id == device) {
        return Err(anyhow!(
            "選択した試聴先が見つかりません。出力一覧を更新してください"
        ));
    }
    let id = device
        .parse()
        .map_err(|_| anyhow!("試聴先の識別情報が不正です"))?;
    let device = host()?
        .device_by_id(&id)
        .ok_or_else(|| anyhow!("試聴先を開けません"))?;
    let config = select_output_config(
        rate,
        || device.default_output_config().map_err(Into::into),
        || {
            preview_stage(
                device.supported_output_configs(),
                "試聴先の対応形式を確認できません",
            )
        },
    )?;
    log::info!(
        "試聴出力設定: rate={}, channels={}, format=F32",
        config.sample_rate,
        config.channels
    );
    Ok((device, config))
}

// 非RT専用。UIには段階だけ返し、CPALの詳細は診断ログへ残す。
pub(super) fn preview_stage<T, E: std::fmt::Display + std::fmt::Debug>(
    result: std::result::Result<T, E>,
    stage: &str,
) -> Result<T> {
    result.map_err(|error| {
        log::warn!("{stage}: {error} ({error:?})");
        anyhow!(stage.to_owned())
    })
}

fn select_output_config<I: Iterator<Item = cpal::SupportedStreamConfigRange>>(
    rate: u32,
    default: impl FnOnce() -> Result<cpal::SupportedStreamConfig>,
    supported: impl FnOnce() -> Result<I>,
) -> Result<cpal::StreamConfig> {
    match default() {
        Ok(config) if config.sample_format() == cpal::SampleFormat::F32
            && config.channels() >= 2 && config.sample_rate() == rate => return Ok(config.config()),
        Ok(config) => log::info!("試聴先の既定形式が録音条件と異なるため対応一覧を確認: rate={}, channels={}, format={:?}", config.sample_rate(), config.channels(), config.sample_format()),
        Err(error) => log::warn!("試聴先の既定形式を取得できないため対応一覧を確認: {error} ({error:?})"),
    }
    let config = supported()?
        .find(|config| {
            config.sample_format() == cpal::SampleFormat::F32
                && config.channels() >= 2
                && config.min_sample_rate() <= rate
                && config.max_sample_rate() >= rate
        })
        .ok_or_else(|| {
            anyhow!(
                "試聴先が録音のサンプルレート・形式に対応していません。通常出力は変更していません"
            )
        })?
        .with_sample_rate(rate)
        .config();
    Ok(config)
}

fn render(
    output: &mut [f32],
    channels: usize,
    samples: &[[f32; 2]],
    pos: &mut usize,
    gain: f32,
    ramp: usize,
    active: &AtomicBool,
) {
    output.fill(0.0);
    for frame in output.chunks_exact_mut(channels) {
        if !active.load(Ordering::Acquire) || *pos >= samples.len() {
            active.store(false, Ordering::Release);
            break;
        }
        let envelope = (*pos as f32 / ramp as f32)
            .min(1.0)
            .min((samples.len() - *pos) as f32 / ramp as f32);
        frame[0] = samples[*pos][0] * gain * envelope;
        frame[1] = samples[*pos][1] * gain * envelope;
        *pos += 1;
    }
}

#[allow(deprecated)]
pub fn devices() -> Result<Vec<PreviewDevice>> {
    Ok(host()?
        .output_devices()?
        .filter_map(|d| {
            let name = d.name().ok()?;
            let lower = name.to_lowercase();
            if ["virtual", "cable", "voicemeeter"]
                .iter()
                .any(|s| lower.contains(s))
            {
                return None;
            }
            Some(PreviewDevice {
                id: d.id().ok()?.to_string(),
                name,
            })
        })
        .collect())
}

impl Preview {
    pub fn stop(&self) {
        self.playing.store(false, Ordering::Release);
    }

    #[allow(deprecated)]
    pub fn start(
        device: &str,
        samples: Vec<[f32; 2]>,
        rate: u32,
        gain: f32,
        main_id: Option<&str>,
    ) -> Result<Self> {
        let (dev, config) = output_device(device, rate, main_id)?;
        let channels = config.channels as usize;
        let playing = Arc::new(AtomicBool::new(true));
        let failed = Arc::new(AtomicBool::new(false));
        let active = playing.clone();
        let error = failed.clone();
        let error_active = playing.clone();
        let mut pos = 0;
        let ramp = (rate as usize / 200).max(1);
        let stream = dev.build_output_stream(
            &config,
            move |output: &mut [f32], _| {
                render(output, channels, &samples, &mut pos, gain, ramp, &active);
            },
            move |_| {
                error.store(true, Ordering::Release);
                error_active.store(false, Ordering::Release);
            },
            None,
        )?;
        stream.play()?;
        Ok(Self {
            _stream: stream,
            playing,
            failed,
            started: std::time::Instant::now(),
        })
    }
}
impl Drop for Preview {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn default_config(
        rate: u32,
        channels: u16,
        format: cpal::SampleFormat,
    ) -> cpal::SupportedStreamConfig {
        cpal::SupportedStreamConfig::new(channels, rate, cpal::SupportedBufferSize::Unknown, format)
    }

    #[test]
    fn matching_default_does_not_enumerate_formats_and_keeps_its_config() {
        let selected = select_output_config(
            96_000,
            || Ok(default_config(96_000, 6, cpal::SampleFormat::F32)),
            || -> Result<std::vec::IntoIter<cpal::SupportedStreamConfigRange>> {
                panic!("WASAPI format enumeration must not run")
            },
        )
        .unwrap();
        assert_eq!(selected.sample_rate, 96_000);
        assert_eq!(selected.channels, 6);
    }

    #[test]
    fn incompatible_or_unavailable_default_uses_only_requested_rate_and_f32_stereo() {
        for default in [
            Ok(default_config(48_000, 2, cpal::SampleFormat::F32)),
            Ok(default_config(96_000, 1, cpal::SampleFormat::F32)),
            Ok(default_config(96_000, 2, cpal::SampleFormat::I16)),
            Err(anyhow!("unavailable")),
        ] {
            let selected = select_output_config(
                96_000,
                || default,
                || {
                    Ok([
                        cpal::SupportedStreamConfigRange::new(
                            2,
                            44_100,
                            48_000,
                            cpal::SupportedBufferSize::Unknown,
                            cpal::SampleFormat::F32,
                        ),
                        cpal::SupportedStreamConfigRange::new(
                            2,
                            44_100,
                            96_000,
                            cpal::SupportedBufferSize::Unknown,
                            cpal::SampleFormat::F32,
                        ),
                    ]
                    .into_iter())
                },
            )
            .unwrap();
            assert_eq!(selected.sample_rate, 96_000);
            assert_eq!(selected.channels, 2);
        }
        assert!(select_output_config(
            96_000,
            || Err(anyhow!("unavailable")),
            || Ok(std::iter::empty())
        )
        .is_err());
    }

    #[test]
    fn preview_errors_expose_stage_without_backend_details() {
        let stage = "試聴先の対応形式を確認できません";
        let result = select_output_config(
            96_000,
            || Err(anyhow!("default unavailable")),
            || -> Result<std::iter::Empty<cpal::SupportedStreamConfigRange>> {
                preview_stage(Err::<(), _>("private backend detail"), stage)?;
                unreachable!()
            },
        );
        assert_eq!(result.unwrap_err().to_string(), stage);
        for stage in [
            "試聴先の出力ストリームを作成できません",
            "試聴先の再生を開始できません",
        ] {
            assert_eq!(
                preview_stage(Err::<(), _>("private backend detail"), stage)
                    .unwrap_err()
                    .to_string(),
                stage
            );
        }
    }

    #[test]
    fn comparison_uses_same_position_and_one_gain_without_rt_allocation() {
        let samples = [[0.2, -0.2]; 8];
        let mut before = [0.0; 40];
        let mut after = [0.0; 40];
        let mut pos = 0;
        let active = AtomicBool::new(true);
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            render(&mut before, 4, &samples, &mut pos, 0.5, 1, &active);
        });
        assert_eq!(counts, (0, 0));
        pos = 0;
        active.store(true, Ordering::Release);
        render(&mut after, 4, &samples, &mut pos, 1.0, 1, &active);
        assert_eq!(after[4], before[4] * 2.0);
        assert_eq!(after[5], before[5] * 2.0);
        assert_eq!(after[6], 0.0);
        assert_eq!(after[7], 0.0);
        assert_eq!(after[36], 0.0);
        assert!(!active.load(Ordering::Acquire));
        active.store(false, Ordering::Release);
        pos = 0;
        render(&mut after, 4, &samples, &mut pos, 1.0, 1, &active);
        assert_eq!(after, [0.0; 40]);
    }
}

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
        if main_id == Some(device) {
            return Err(anyhow!("通常出力とは別の試聴先を選んでください"));
        }
        if !devices()?.iter().any(|d| d.id == device) {
            return Err(anyhow!(
                "選択した試聴先が見つかりません。出力一覧を更新してください"
            ));
        }
        let id = device
            .parse()
            .map_err(|_| anyhow!("試聴先の識別情報が不正です"))?;
        let dev = host()?
            .device_by_id(&id)
            .ok_or_else(|| anyhow!("試聴先を開けません"))?;
        let config = dev
            .supported_output_configs()?
            .find(|c| {
                c.sample_format() == cpal::SampleFormat::F32
                    && c.channels() >= 2
                    && c.min_sample_rate() <= rate
                    && c.max_sample_rate() >= rate
            })
            .ok_or_else(|| {
                anyhow!(
                    "試聴先が録音のサンプルレートに対応していません。通常出力は変更していません"
                )
            })?
            .with_sample_rate(rate)
            .config();
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

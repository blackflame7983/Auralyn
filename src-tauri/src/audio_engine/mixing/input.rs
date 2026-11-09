//! オケだけの取得資源。主入力の失敗フラグや、声向け処理を共有しない。
use super::{Source, Start};
use crate::audio_engine::{devices::DeviceManager, mode_silence, process_capture};
use anyhow::{anyhow, ensure, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapRb,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

type AudioRx = <Arc<HeapRb<f32>> as Split>::Cons;
enum Stream {
    Device(cpal::Stream),
    Process(process_capture::Controller),
}
pub struct Controller {
    stream: Stream,
    // callbackが最後のArcを解放しないよう、停止完了まで制御側でも所有する。
    _queue: Arc<HeapRb<f32>>,
}
impl Controller {
    pub fn prepare(
        start: &Start,
        output_rate: u32,
        gate: Arc<mode_silence::Shared>,
        max_frames: usize,
    ) -> Result<(Self, Render)> {
        start.validate().map_err(anyhow::Error::msg)?;
        let failed = Arc::new(AtomicBool::new(false));
        let (stream, shared, rate, queue, rx) = match &start.config.source {
            Source::ProcessLoopback(config) => {
                let capacity = process_capture::clock::queue_capacity(
                    process_capture::RATE,
                    output_rate,
                    max_frames,
                )?;
                let queue = Arc::new(HeapRb::<f32>::new(capacity * 2));
                let (tx, rx) = queue.clone().split();
                let target = start
                    .target
                    .clone()
                    .ok_or_else(|| anyhow!("オケのアプリを選び直してください"))?;
                let shared = Arc::new(process_capture::Shared::for_mixing(
                    failed,
                    process_capture::RATE,
                    gate.clone(),
                ));
                let stream = process_capture::Controller::prepare(
                    config.clone(),
                    target,
                    tx,
                    shared.clone(),
                )?;
                (
                    Stream::Process(stream),
                    shared,
                    process_capture::RATE,
                    queue,
                    rx,
                )
            }
            Source::Device(config) => {
                crate::desktop_integration::check_microphone_access(Some("WASAPI"))
                    .map_err(anyhow::Error::msg)?;
                let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
                let device = DeviceManager::resolve_input_device_by_id(&host, &config.input_id)
                    .ok_or_else(|| {
                        anyhow!("オケの入力機器IDを確認できません。選び直してください")
                    })?;
                ensure!(
                    device.id()?.to_string() == config.input_id,
                    "オケの入力機器が変わりました"
                );
                let supported = device.default_input_config()?;
                ensure!(
                    supported.sample_format() == cpal::SampleFormat::F32,
                    "オケの機器はf32入力が必要です"
                );
                let channels = usize::from(supported.channels());
                ensure!(
                    config
                        .input_channels
                        .iter()
                        .all(|channel| *channel < channels),
                    "オケの入力チャンネルを確認してください"
                );
                let stream_config: cpal::StreamConfig = supported.into();
                let rate = stream_config.sample_rate;
                let capacity =
                    process_capture::clock::queue_capacity(rate, output_rate, max_frames)?;
                let queue = Arc::new(HeapRb::<f32>::new(capacity * 2));
                let (mut tx, rx) = queue.clone().split();
                let shared = Arc::new(process_capture::Shared::for_mixing(
                    failed.clone(),
                    rate,
                    gate.clone(),
                ));
                let input_shared = shared.clone();
                let pair = config.input_channels;
                let input_failed = failed.clone();
                let stream = device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        if input_failed.load(Ordering::Acquire) || gate.pause_sources() {
                            return;
                        }
                        let mut nonzero = 0;
                        for frame in data.chunks_exact(channels) {
                            let selected = pair.map(|channel| frame[channel]);
                            if selected.iter().any(|value| !value.is_finite())
                                || tx.vacant_len() < 2
                            {
                                input_failed.store(true, Ordering::Release);
                                return;
                            }
                            nonzero += usize::from(selected[0] != 0.0 || selected[1] != 0.0);
                            let _ = tx.push_slice(&selected);
                        }
                        input_shared.observe_device(data.len() / channels, nonzero);
                    },
                    move |_| {
                        failed.store(true, Ordering::Release);
                    },
                    None,
                )?;
                (Stream::Device(stream), shared, rate, queue, rx)
            }
        };
        let render = Render {
            renderer: process_capture::clock::Renderer::with_rates_and_capacity(
                rate,
                output_rate,
                queue.capacity().get() / 2,
            )?,
            queue: rx,
            samples: vec![0.0; max_frames * 2],
            shared,
            starved_at: None,
            generation: (0, 0),
        };
        Ok((
            Self {
                stream,
                _queue: queue,
            },
            render,
        ))
    }
    pub fn play(&self) -> Result<()> {
        match &self.stream {
            Stream::Device(stream) => stream.play().map_err(Into::into),
            Stream::Process(stream) => stream.play(),
        }
    }
}

/// 本人用callbackだけが消費する。配信用workerは分岐後の別キューを読む。
pub struct Render {
    renderer: process_capture::clock::Renderer,
    queue: AudioRx,
    samples: Vec<f32>,
    pub shared: Arc<process_capture::Shared>,
    starved_at: Option<u64>,
    generation: (u64, u64),
}
impl Render {
    pub fn begin_block(&mut self, frames: usize, paused: bool, generation: (u64, u64)) {
        self.samples[..frames * 2].fill(0.0);
        if self.generation != generation || paused || self.shared.failed.load(Ordering::Acquire) {
            self.queue.skip(self.queue.occupied_len() / 2 * 2);
            self.renderer.wait_for_audio();
            self.starved_at = None;
            self.generation = generation;
        }
        if paused || self.shared.failed.load(Ordering::Acquire) {
            return;
        }
        self.shared.render_queue(
            &mut self.renderer,
            &mut process_capture::clock::Interleaved(&mut self.queue),
            &mut self.starved_at,
            &mut self.samples[..frames * 2],
        );
        if self.shared.failed.load(Ordering::Acquire) {
            self.samples[..frames * 2].fill(0.0);
        }
    }
    pub fn frame(&self, index: usize) -> [f32; 2] {
        [self.samples[index * 2], self.samples[index * 2 + 1]]
    }
}

#[cfg(test)]
#[path = "input_route_tests.rs"]
mod route_tests;

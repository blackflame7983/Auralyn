//! 配信ミックス用のVSTは専用Engineで処理し、本人用callbackと故障境界を分ける。
use super::*;
use crate::audio_engine::post_mix::{Descriptor, Mapping, Packet, WorkerPort, BLOCK_FRAMES};

pub(super) struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    owner: ControlOwner<Rack>,
    mapping: Mapping,
}
struct Rack {
    port: WorkerPort,
    processors: [Option<VstProcessor>; MAX_PLUGINS],
    controls: startup::PluginControls,
    latencies: [Option<u32>; MAX_PLUGINS],
    generation: Option<u64>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.mapping.set_failed();
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            // 悪いVSTで停止不能になっても、Hostはこの専用processだけを破棄できる。
            let _ = thread.join();
        }
        drop(self.owner.take());
    }
}
impl Engine {
    pub(super) fn acknowledge_processing_preparation(&mut self) {
        self.processing_restart_revision = crate::vst_host::instance::processing_restart_revision();
    }
    pub(super) fn poll_processing_restart(&mut self) {
        // Hostが開始した接続・setActiveの通知は、準備の完了箇所で引き受ける。
        if self.pending_restore.is_some() || !self.plugin_manager.pending_init.is_empty() {
            return;
        }
        let current = crate::vst_host::instance::processing_restart_revision();
        if current == self.processing_restart_revision {
            return;
        }
        self.processing_restart_revision = current;
        // 新しい遅延値の有効化には再設定が必要。古い計測値のまま送出しない。
        if let Some(worker) = &self.post_worker {
            log::warn!("post_mix: VSTの処理条件変更により配信枝の再準備が必要です");
            worker.mapping.set_failed();
            self.stream_failed.store(true, Ordering::Release);
        }
        if self.mixing_start.is_some() && self.output_stream.is_some() {
            log::warn!("mixing: VSTの処理条件変更により配信枝の再準備が必要です");
            log::warn!("mixing restart diagnostics: flags={} revision={} preparation={} plugins={} muted={}", crate::vst_host::instance::processing_restart_flags(), current, self.last_processing_preparation, self.plugin_manager.order.len(), self.global_mute);
            if let Some(mapping) = &self.post_mapping {
                mapping.set_failed();
            }
            if let Some(monitor) = &self.split_monitor {
                monitor.shared.failed.store(true, Ordering::Release);
            }
        }
    }
    pub fn new_post_mix() -> Self {
        let mut engine = Self::new();
        engine.post_role = true;
        engine
    }
    pub(super) fn processing_running(&self) -> bool {
        self.output_stream.is_some() || self.post_worker.is_some()
    }
    pub(super) fn post_command_allowed(&self, command: &Command) -> bool {
        if !self.post_role {
            return !matches!(command, Command::PostMixStart { .. });
        }
        post_role_command_allowed(command, self.processing_running())
    }

    pub(super) fn prepare_post_mix(&mut self, sample_rate: u32) -> Result<Descriptor> {
        anyhow::ensure!(
            !self.post_role && !self.processing_running(),
            "停止してからミックス後VSTを準備してください"
        );
        anyhow::ensure!(
            self.mixing_start.is_some() && self.live_output_config.split_processing,
            "ミックス後VSTには二入力と分離出力が必要です"
        );
        let mapping = Mapping::create(sample_rate)?;
        let descriptor = mapping.descriptor();
        self.post_mapping = Some(mapping);
        Ok(descriptor)
    }
    pub(super) fn start_post_mix(&mut self, descriptor: Descriptor) -> Result<()> {
        anyhow::ensure!(
            self.post_role && !self.processing_running(),
            "ミックス後VSTの専用Engineを停止してください"
        );
        anyhow::ensure!(
            self.pending_restore.is_none() && self.plugin_manager.pending_init.is_empty(),
            "VSTの読み込み完了を待ってください"
        );
        let rate = descriptor.sample_rate;
        let mapping = Mapping::open(&descriptor)?;
        let status_mapping = Mapping::open(&descriptor)?;
        let port = mapping.into_worker()?;
        self.current_sample_rate = f64::from(rate);
        self.current_channels = 2;
        self.current_input_channels = 2;
        self.current_block_size = BLOCK_FRAMES;
        self.processing_block_capacity = BLOCK_FRAMES;
        let prepared =
            self.plugin_manager
                .prepare_for_audio_start(f64::from(rate), 2, BLOCK_FRAMES)?;
        let mut processors = std::array::from_fn(|_| None);
        for (index, processor) in prepared {
            processors[index as usize] = Some(processor);
        }
        let controls = self.prepare_plugin_controls();
        let mut latencies = [None; MAX_PLUGINS];
        for (id, plugin) in &self.plugin_manager.plugins {
            if let Some(index) = self.plugin_manager.rt_index_of(id) {
                latencies[index as usize] = plugin.declared_latency_samples();
            }
        }
        // 停止中の変更は controls に反映済み。所有メッセージは制御側で破棄する。
        self.pending_audio_msgs.clear();
        let (mut rack, owner) = callback_owner(Rack {
            port,
            processors,
            controls,
            latencies,
            generation: None,
            input: vec![vec![0.0; BLOCK_FRAMES]; 2],
            output: vec![vec![0.0; BLOCK_FRAMES]; 2],
        });
        let (tx, mut rx) = HeapRb::new(256).split();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        self.stream_failed.store(false, Ordering::Release);
        let failed = self.stream_failed.clone();
        let thread = std::thread::Builder::new()
            .name("auralyn-post-vst".into())
            .spawn(move || {
                let rack = rack.get_mut();
                rack.port.set_ready(rack.plugin_latency(false));
                let mut packet = Packet::default();
                'run: while !stopping.load(Ordering::Acquire) {
                    while let Some(command) = rx.try_pop() {
                        // 構成変更を受付で拒否するため、所有VSTをRTで追加・破棄しない。
                        match command {
                            AudioThreadMessage::SetBypass { index, active } => {
                                if let Some(value) = rack.controls.bypassed.get_mut(index as usize)
                                {
                                    *value = active;
                                }
                            }
                            AudioThreadMessage::SetMute { index, active } => {
                                if let Some(value) = rack.controls.muted.get_mut(index as usize) {
                                    *value = active;
                                }
                            }
                            AudioThreadMessage::SetGain { index, value } => {
                                if let Some(gain) = rack.controls.gains.get_mut(index as usize) {
                                    gain.set_target(value);
                                }
                            }
                            AudioThreadMessage::ResumePlugin { index } => {
                                rack.controls.resume_slot(index);
                            }
                            unexpected => {
                                // 受付条件が壊れた場合も RT 側で所有物を破棄せず、安全側で停止する。
                                std::mem::forget(unexpected);
                                rack.port.set_failed();
                                break 'run;
                            }
                        }
                    }
                    if rack.port.failed() {
                        break;
                    }
                    if !rack.port.try_input(&mut packet) {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    if packet.bypassed > 1
                        || packet.samples.iter().flatten().any(|v| !v.is_finite())
                    {
                        rack.port.set_failed();
                        break;
                    }
                    rack.port
                        .set_latency(rack.plugin_latency(packet.bypassed != 0));
                    if !rack.process(&mut packet) {
                        rack.port.set_failed();
                        break;
                    }
                    if packet.samples.iter().flatten().any(|v| !v.is_finite())
                        || !rack.port.try_output(&packet)
                    {
                        rack.port.set_failed();
                        break;
                    }
                }
                if !stopping.load(Ordering::Acquire) {
                    failed.store(true, Ordering::Release);
                }
            })
            .inspect_err(|_| {
                status_mapping.set_failed();
            })?;
        self.command_tx = Some(tx);
        self.processing_restart_revision = crate::vst_host::instance::processing_restart_revision();
        self.post_worker = Some(Worker {
            stop,
            thread: Some(thread),
            owner,
            mapping: status_mapping,
        });
        Ok(())
    }
}
// 停止中のみ構成変更できるため、実行中のキューに所有 VST は流入しない。
fn post_role_command_allowed(command: &Command, running: bool) -> bool {
    match command {
        Command::PostMixStart { .. }
        | Command::Stop
        | Command::GetPluginRack
        | Command::ProcessingState
        | Command::GetPluginState { .. }
        | Command::OpenEditor { .. }
        | Command::SetBypass { .. }
        | Command::SetMute { .. }
        | Command::SetGain { .. }
        | Command::ResumePlugin { .. } => true,
        Command::LoadPlugin { .. }
        | Command::RestorePlugin { .. }
        | Command::RestoreSessionPlugin { .. }
        | Command::UnloadPlugin { .. }
        | Command::ReorderPlugins { .. }
        | Command::SetPluginState { .. } => !running,
        _ => false,
    }
}
impl Rack {
    fn plugin_latency(&self, bypassed: bool) -> Option<u32> {
        if bypassed {
            return Some(0);
        }
        let mut total = 0u32;
        for &index in &self.controls.order[..self.controls.order_len] {
            let slot = index as usize;
            if slot >= MAX_PLUGINS
                || self.controls.bypassed[slot]
                || self.processors[slot].is_none()
            {
                continue;
            }
            total = total.checked_add(self.latencies[slot]?)?;
        }
        Some(total)
    }
    fn process(&mut self, packet: &mut Packet) -> bool {
        if self
            .generation
            .is_some_and(|previous| previous != packet.generation)
        {
            for processor in self.processors.iter_mut().flatten() {
                if !processor.reset_processing() {
                    return false;
                }
            }
        }
        self.generation = Some(packet.generation);
        for (index, frame) in packet.samples.iter().enumerate() {
            self.input[0][index] = frame[0];
            self.input[1][index] = frame[1];
        }
        let mut input_a = true;
        if packet.bypassed == 0 {
            for position in 0..self.controls.order_len {
                let index = self.controls.order[position];
                let slot = index as usize;
                if slot >= MAX_PLUGINS || self.controls.bypassed[slot] {
                    continue;
                }
                if self.controls.muted[slot] {
                    let current = if input_a {
                        &mut self.input
                    } else {
                        &mut self.output
                    };
                    current.iter_mut().for_each(|channel| channel.fill(0.0));
                    continue;
                }
                if self.controls.health[slot].isolated {
                    let current = if input_a {
                        &mut self.input
                    } else {
                        &mut self.output
                    };
                    crate::audio_engine::plugin_health::silence_used(current, 2, BLOCK_FRAMES);
                    continue;
                }
                let Some(processor) = &mut self.processors[slot] else {
                    continue;
                };
                let (input, output) = if input_a {
                    (&self.input, &mut self.output)
                } else {
                    (&self.output, &mut self.input)
                };
                processor.process_planar(input, output, BLOCK_FRAMES);
                self.controls.note_processed(slot, output, 2, BLOCK_FRAMES);
                input_a = !input_a;
                let output = if input_a {
                    &mut self.input
                } else {
                    &mut self.output
                };
                for index in 0..BLOCK_FRAMES {
                    let gain = self.controls.gains[slot].next();
                    for channel in output.iter_mut() {
                        channel[index] *= gain;
                    }
                }
            }
        }
        let output = if input_a { &self.input } else { &self.output };
        for (index, frame) in packet.samples.iter_mut().enumerate() {
            *frame = [output[0][index], output[1][index]];
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_preparation_notifications_do_not_latch_a_worker_but_runtime_changes_do() {
        let mapping = Mapping::create(48_000).unwrap();
        let mut engine = Engine::new_post_mix();
        engine.start_post_mix(mapping.descriptor()).unwrap();
        engine.plugin_manager.pending_init.push("preparing".into());
        engine.processing_restart_revision =
            crate::vst_host::instance::processing_restart_revision().wrapping_sub(1);
        engine.poll_processing_restart();
        assert!(!mapping.failed());
        engine.plugin_manager.pending_init.clear();
        engine.acknowledge_processing_preparation();
        engine.poll_processing_restart();
        assert!(!mapping.failed());
        engine.processing_restart_revision =
            crate::vst_host::instance::processing_restart_revision().wrapping_sub(1);
        engine.poll_processing_restart();
        assert!(mapping.failed());
        assert!(engine.stream_failed.load(Ordering::Acquire));
    }

    #[test]
    fn running_worker_rejects_owning_and_device_commands() {
        let commands = [
            Command::LoadPlugin {
                path: "x".into(),
                class_id: None,
            },
            Command::UnloadPlugin { id: "x".into() },
            Command::ReorderPlugins { order: vec![] },
            Command::SetPluginState {
                id: "x".into(),
                state: String::new(),
            },
        ];
        for command in &commands {
            assert!(post_role_command_allowed(command, false));
            assert!(!post_role_command_allowed(command, true));
        }
        assert!(post_role_command_allowed(&Command::ProcessingState, true));
        assert!(!post_role_command_allowed(&Command::GetDevices, false));
        assert!(!post_role_command_allowed(&Command::BeginDeviceScan, true));
        assert!(post_role_command_allowed(
            &Command::SetGain {
                id: "x".into(),
                value: 1.0
            },
            true
        ));
        assert!(post_role_command_allowed(
            &Command::ResumePlugin { id: "x".into() },
            true
        ));
    }

    #[test]
    fn empty_rack_processes_without_allocation() {
        let mut engine = Engine::new_post_mix();
        let mapping = Mapping::create(48_000).unwrap();
        let port = Mapping::open(&mapping.descriptor())
            .unwrap()
            .into_worker()
            .unwrap();
        let mut rack = Rack {
            port,
            processors: std::array::from_fn(|_| None),
            controls: engine.prepare_plugin_controls(),
            latencies: [None; MAX_PLUGINS],
            generation: None,
            input: vec![vec![0.0; BLOCK_FRAMES]; 2],
            output: vec![vec![0.0; BLOCK_FRAMES]; 2],
        };
        let mut packet = Packet::default();
        packet.samples.fill([1.5, -1.5]);
        let counts =
            crate::vst_host::instance::allocation_counts(|| assert!(rack.process(&mut packet)));
        assert_eq!(counts, (0, 0));
        assert!(packet.samples.iter().all(|frame| *frame == [1.5, -1.5]));
        assert_eq!(rack.plugin_latency(false), Some(0));
    }

    #[test]
    fn one_plugin_nan_is_silenced_per_slot_and_the_rack_keeps_running() {
        use crate::vst_host::instance::{allocation_counts, ScriptedVst};
        let mut bad = ScriptedVst::non_finite(f32::NAN, None);
        let mut next = ScriptedVst::scale(0.5);
        let mut engine = Engine::new_post_mix();
        let mapping = Mapping::create(48_000).unwrap();
        let port = Mapping::open(&mapping.descriptor())
            .unwrap()
            .into_worker()
            .unwrap();
        let mut controls = engine.prepare_plugin_controls();
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 4);
        controls.install_slot(1, 5);
        let mut processors = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let mut rack = Rack {
            port,
            processors,
            controls,
            latencies: [None; MAX_PLUGINS],
            generation: None,
            input: vec![vec![0.0; BLOCK_FRAMES]; 2],
            output: vec![vec![0.0; BLOCK_FRAMES]; 2],
        };
        let mut packet = Packet::default();
        packet.samples.fill([0.5, -0.5]);
        let mut finite = false;
        let counts = allocation_counts(|| {
            finite = rack.process(&mut packet);
        });
        assert_eq!(counts, (0, 0));
        assert!(finite);
        assert!(packet
            .samples
            .iter()
            .flatten()
            .all(|sample| sample.is_finite() && *sample == 0.0));
        assert!(!next.saw_non_finite());
        assert_eq!((bad.calls(), next.calls()), (1, 1));
        assert!(!rack.controls.health[0].isolated);
        let counts = allocation_counts(|| {
            for _ in 0..9 {
                assert!(rack.process(&mut packet));
            }
        });
        assert_eq!(counts, (0, 0));
        assert!(rack.controls.health[0].isolated);
        assert!(packet
            .samples
            .iter()
            .flatten()
            .all(|sample| sample.is_finite()));
        assert!(!next.saw_non_finite());
        let bad_calls = bad.calls();
        let next_calls = next.calls();
        assert!(rack.process(&mut packet));
        assert_eq!(bad.calls(), bad_calls);
        assert_eq!(next.calls(), next_calls + 1);
        assert!(packet.samples.iter().all(|frame| *frame == [0.0, 0.0]));
        assert_eq!(
            rack.controls
                .health_shared
                .isolated_publication(0, 4)
                .map(|state| state.isolation_seq),
            Some(1)
        );
        rack.controls.resume_slot(0);
        assert!(rack.process(&mut packet));
        assert_eq!(bad.calls(), bad_calls + 1);
        assert!(!rack.controls.health[0].isolated);
        let counts = allocation_counts(|| {
            for _ in 0..9 {
                assert!(rack.process(&mut packet));
            }
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(
            rack.controls
                .health_shared
                .isolated_publication(0, 4)
                .map(|state| state.isolation_seq),
            Some(2)
        );
    }
}

use super::transport::{ClientPort, Packet, BLOCK_FRAMES};

const DELAY_FRAMES: usize = super::TRANSPORT_LATENCY_FRAMES as usize;
const MAX_STALE: usize = 8;

pub struct ClientRenderer {
    port: ClientPort,
    input: Packet,
    output: Packet,
    input_pos: usize,
    output_pos: usize,
    elapsed: usize,
    source_generation: Option<u64>,
    bypassed: bool,
    generation: u64,
    next_input: u64,
    next_output: u64,
    paused: bool,
    failed: bool,
}
impl ClientRenderer {
    pub fn new(port: ClientPort) -> Self {
        Self {
            port,
            input: Packet::default(),
            output: Packet::default(),
            input_pos: 0,
            output_pos: BLOCK_FRAMES,
            elapsed: 0,
            source_generation: None,
            bypassed: false,
            generation: 0,
            next_input: 0,
            next_output: 0,
            paused: false,
            failed: false,
        }
    }
    fn restart(&mut self, source: u64) {
        self.source_generation = Some(source);
        self.generation = self.generation.wrapping_add(1);
        self.input_pos = 0;
        self.output_pos = BLOCK_FRAMES;
        self.elapsed = 0;
        self.next_input = 0;
        self.next_output = 0;
    }
    fn fail(&mut self, audio: &mut [Vec<f32>], frames: usize) -> bool {
        self.failed = true;
        self.port.set_failed();
        for channel in audio.iter_mut() {
            channel.iter_mut().take(frames).for_each(|v| *v = 0.0);
        }
        false
    }
    fn pull_output(&mut self) -> Result<bool, ()> {
        for _ in 0..MAX_STALE {
            if !self.port.try_output(&mut self.output) {
                return Ok(false);
            }
            if self.output.generation != self.generation {
                continue;
            }
            if self.output.sequence != self.next_output
                || self.output.bypassed != u32::from(self.bypassed)
                || self.output.samples.iter().flatten().any(|v| !v.is_finite())
            {
                return Err(());
            }
            self.next_output = self.next_output.wrapping_add(1);
            self.output_pos = 0;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn process(
        &mut self,
        audio: &mut [Vec<f32>],
        frames: usize,
        paused: bool,
        generation: u64,
        bypassed: bool,
    ) -> bool {
        if self.failed
            || self.port.failed()
            || audio.len() < 2
            || audio.iter().any(|channel| channel.len() < frames)
        {
            return self.fail(audio, frames);
        }
        if paused {
            self.paused = true;
            for channel in audio.iter_mut() {
                channel[..frames].fill(0.0);
            }
            return true;
        }
        if self.paused || self.source_generation != Some(generation) || self.bypassed != bypassed {
            self.restart(generation);
            self.bypassed = bypassed;
            self.paused = false;
        }
        if self.elapsed < DELAY_FRAMES
            && self.output_pos == BLOCK_FRAMES
            && self.pull_output().is_err()
        {
            return self.fail(audio, frames);
        }
        for frame in 0..frames {
            let samples = [audio[0][frame], audio[1][frame]];
            if !samples.iter().all(|v| v.is_finite()) {
                return self.fail(audio, frames);
            }
            self.input.samples[self.input_pos] = samples;
            self.input_pos += 1;
            if self.input_pos == BLOCK_FRAMES {
                self.input.sequence = self.next_input;
                self.input.generation = self.generation;
                self.input.bypassed = u32::from(bypassed);
                if !self.port.try_input(&self.input) {
                    return self.fail(audio, frames);
                }
                self.next_input = self.next_input.wrapping_add(1);
                self.input_pos = 0;
            }
            let mut result = [0.0; 2];
            if self.elapsed >= DELAY_FRAMES {
                if self.output_pos == BLOCK_FRAMES {
                    match self.pull_output() {
                        Ok(true) => {}
                        Ok(false) | Err(()) => return self.fail(audio, frames),
                    }
                }
                result = self.output.samples[self.output_pos];
                self.output_pos += 1;
            }
            self.elapsed = self.elapsed.saturating_add(1);
            audio[0][frame] = result[0];
            audio[1][frame] = result[1];
            for channel in audio.iter_mut().skip(2) {
                channel[frame] = 0.0;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_engine::post_mix::Mapping;

    fn setup() -> (Mapping, ClientRenderer, super::super::WorkerPort) {
        let mut mapping = Mapping::create(48_000).unwrap();
        let worker = Mapping::open(&mapping.descriptor())
            .unwrap()
            .into_worker()
            .unwrap();
        let renderer = ClientRenderer::new(mapping.client().unwrap());
        (mapping, renderer, worker)
    }
    fn pump(worker: &mut super::super::WorkerPort) {
        let mut packet = Packet::default();
        while worker.try_input(&mut packet) {
            assert!(worker.try_output(&packet));
        }
    }
    #[test]
    fn variable_callbacks_identity_delay_and_headroom() {
        let (_mapping, mut renderer, mut worker) = setup();
        let sizes = [127, 385, 256, 256, 512, 512, 128, 384, 512];
        let mut position = 0;
        for size in sizes {
            let mut audio = vec![vec![1.5; size], vec![-1.5; size]];
            assert!(renderer.process(&mut audio, size, false, 1, false));
            for (i, (&left, &right)) in audio[0].iter().zip(&audio[1]).enumerate() {
                let expected = if position + i < DELAY_FRAMES {
                    0.0
                } else {
                    1.5
                };
                assert_eq!(left, expected);
                assert_eq!(right, -expected);
            }
            position += size;
            pump(&mut worker);
        }
    }
    #[test]
    fn pause_resets_generation_and_discards_stale_output() {
        let (_mapping, mut renderer, mut worker) = setup();
        let mut audio = vec![vec![1.0; BLOCK_FRAMES]; 2];
        assert!(renderer.process(&mut audio, BLOCK_FRAMES, false, 1, false));
        pump(&mut worker);
        assert!(renderer.process(&mut audio, BLOCK_FRAMES, true, 1, false));
        assert!(audio.iter().flatten().all(|v| *v == 0.0));
        for block in 0..5 {
            audio.iter_mut().for_each(|c| c.fill(2.0));
            assert!(renderer.process(&mut audio, BLOCK_FRAMES, false, 1, false));
            assert!(audio
                .iter()
                .flatten()
                .all(|v| *v == if block < 4 { 0.0 } else { 2.0 }));
            pump(&mut worker);
        }
    }
    #[test]
    fn missing_worker_and_nonfinite_latch_silence() {
        let (mapping, mut renderer, _worker) = setup();
        let mut audio = vec![vec![1.0; BLOCK_FRAMES]; 2];
        for _ in 0..4 {
            assert!(renderer.process(&mut audio, BLOCK_FRAMES, false, 1, false));
        }
        audio.iter_mut().for_each(|c| c.fill(1.0));
        assert!(!renderer.process(&mut audio, BLOCK_FRAMES, false, 1, false));
        assert!(mapping.failed());
        assert!(audio.iter().flatten().all(|v| *v == 0.0));
        let (_mapping, mut renderer, _worker) = setup();
        audio[0][0] = f32::NAN;
        assert!(!renderer.process(&mut audio, BLOCK_FRAMES, false, 1, false));
        assert!(audio.iter().flatten().all(|v| *v == 0.0));
    }
    #[test]
    fn callback_does_not_allocate_or_free() {
        let (_mapping, mut renderer, _worker) = setup();
        let mut audio = vec![vec![0.5; 128]; 2];
        let counts = crate::vst_host::instance::allocation_counts(|| {
            assert!(renderer.process(&mut audio, 128, false, 1, false));
        });
        assert_eq!(counts, (0, 0));
    }
    #[test]
    fn bypass_change_starts_a_new_packet_generation() {
        let (_mapping, mut renderer, mut worker) = setup();
        let mut audio = vec![vec![1.0; 256]; 2];
        assert!(renderer.process(&mut audio, 256, false, 1, false));
        audio.iter_mut().for_each(|c| c.fill(2.0));
        assert!(renderer.process(&mut audio, 256, false, 1, true));
        audio.iter_mut().for_each(|c| c.fill(2.0));
        assert!(renderer.process(&mut audio, 256, false, 1, true));
        let mut packet = Packet::default();
        assert!(worker.try_input(&mut packet));
        assert_eq!(packet.bypassed, 1);
        assert!(packet.samples.iter().all(|sample| *sample == [2.0, 2.0]));
        assert!(!worker.try_input(&mut packet));
    }
}

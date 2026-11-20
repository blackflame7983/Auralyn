use crate::ipc::MeterLevels;

/// 送信周期のあいだに受け取ったピークの最大値と、無音の連続を省く状態。
/// 音声を止めたときと開始のときに初期化し、前の音声の値を次の開始へ持ち越さない（#824）。
#[derive(Debug, Default)]
pub(super) struct MeterAccumulator {
    input: [f32; 2],
    output: [f32; 2],
    updates: u32,
    last_was_zero: bool,
}

impl MeterAccumulator {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    pub(super) fn push(&mut self, levels: &MeterLevels) {
        self.updates = self.updates.saturating_add(1);
        for (current, next) in self.input.iter_mut().zip(levels.input) {
            *current = current.max(next);
        }
        for (current, next) in self.output.iter_mut().zip(levels.output) {
            *current = current.max(next);
        }
    }

    pub(super) fn has_updates(&self) -> bool {
        self.updates > 0
    }

    /// 周期の終わりに、たまった最大値を返して空にする。無音が続くときは最初の1回だけ返す。
    pub(super) fn take(&mut self) -> Option<MeterLevels> {
        let input = self.input.map(|value| value.clamp(0.0, 10.0));
        let output = self.output.map(|value| value.clamp(0.0, 10.0));
        let is_zero = input.iter().chain(output.iter()).all(|value| *value == 0.0);
        let send = !is_zero || !self.last_was_zero;
        self.input = [0.0; 2];
        self.output = [0.0; 2];
        self.updates = 0;
        self.last_was_zero = is_zero;
        send.then_some(MeterLevels { input, output })
    }

    /// 音声データが届かないときに、ゼロを1回だけ返す。
    pub(super) fn idle(&mut self) -> Option<MeterLevels> {
        if self.last_was_zero {
            return None;
        }
        self.last_was_zero = true;
        Some(MeterLevels {
            input: [0.0; 2],
            output: [0.0; 2],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(value: f32) -> MeterLevels {
        MeterLevels {
            input: [value; 2],
            output: [value; 2],
        }
    }

    #[test]
    fn take_keeps_peak_and_suppresses_repeated_zero() {
        let mut meter = MeterAccumulator::default();
        meter.push(&levels(0.2));
        meter.push(&levels(0.5));
        assert_eq!(meter.take().map(|l| l.input), Some([0.5; 2]));
        meter.push(&levels(0.0));
        assert!(meter.take().is_some());
        meter.push(&levels(0.0));
        assert!(meter.take().is_none());
        assert!(meter.idle().is_none());
    }

    /// 無音が続いてゼロの送信を省いている状態で、前の音声のピークも残っているとする。
    fn silent_with_pending_peak(engine: &mut super::super::Engine) {
        engine.meter.push(&levels(0.0));
        assert!(engine.meter.take().is_some());
        engine.meter.push(&levels(0.0));
        assert!(engine.meter.take().is_none());
        engine.meter.push(&levels(0.9));
    }

    fn assert_fresh(engine: &mut super::super::Engine) {
        // 前の音声の 0.9 を送らず、無音で始めても最初のゼロを1回送る。
        engine.meter.push(&levels(0.0));
        assert_eq!(engine.meter.take().map(|l| l.output), Some([0.0; 2]));
    }

    #[test]
    fn starting_a_stream_does_not_carry_previous_meter_state() {
        let mut engine = super::super::Engine::new();
        silent_with_pending_peak(&mut engine);
        let _producer = engine.prepare_meter_channel();
        assert!(engine.level_rx.is_some());
        assert_fresh(&mut engine);
    }

    #[test]
    fn stopping_a_stream_does_not_carry_previous_meter_state() {
        let mut engine = super::super::Engine::new();
        silent_with_pending_peak(&mut engine);
        engine.clear_audio_resources();
        assert!(engine.level_rx.is_none());
        assert_fresh(&mut engine);
    }
}

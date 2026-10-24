//! 1回の起動試行だけで使う能力snapshot。取得失敗も保持し、同じ試行では再問い合わせしない。
use anyhow::Result;
use cpal::{
    BufferSize, SampleFormat, StreamConfig, SupportedBufferSize, SupportedStreamConfig,
    SupportedStreamConfigRange,
};
use std::time::Instant;

pub(super) struct CapabilitySnapshot {
    default: SupportedStreamConfig,
    supported: Option<Vec<SupportedStreamConfigRange>>,
}

impl CapabilitySnapshot {
    pub(super) fn capture<I: Iterator<Item = SupportedStreamConfigRange>>(
        default: impl FnOnce() -> Result<SupportedStreamConfig>,
        supported: impl FnOnce() -> Result<I>,
    ) -> Result<Self> {
        let default = default()?;
        let supported = supported().ok().map(Iterator::collect);
        Ok(Self { default, supported })
    }

    pub(super) fn output_config(&self, rate: Option<u32>, buffer: Option<u32>) -> StreamConfig {
        let mut config = self.input_config(buffer);
        if let Some(rate) = rate {
            if self.supported.as_ref().is_some_and(|supported| {
                supported
                    .iter()
                    .any(|range| range.min_sample_rate() <= rate && range.max_sample_rate() >= rate)
            }) {
                // 既存方針どおり、defaultのch/形式を維持して出力rateだけを変更する。
                config.sample_rate = rate;
            }
        }
        config
    }

    pub(super) fn input_config(&self, buffer: Option<u32>) -> StreamConfig {
        let mut config = self.default.config();
        if let Some(frames) = buffer {
            config.buffer_size = BufferSize::Fixed(frames);
        }
        config
    }

    /// 入力のch/形式/bufferを保ち、同じF32構成で使えるrateだけを優先する。
    /// 対応一覧の取得失敗や別ch/形式を、同率対応と推測しない。
    pub(super) fn same_rate_input(
        &self,
        base: &StreamConfig,
        output_rate: u32,
    ) -> Option<StreamConfig> {
        if base.sample_rate == output_rate
            || base.channels != self.default.channels()
            || self.default.sample_format() != SampleFormat::F32
            || !self.supported.as_ref().is_some_and(|supported| {
                supported.iter().any(|range| {
                    range.channels() == self.default.channels()
                        && range.sample_format() == SampleFormat::F32
                        && range.min_sample_rate() <= output_rate
                        && range.max_sample_rate() >= output_rate
                })
            })
        {
            return None;
        }
        let mut config = base.clone();
        config.sample_rate = output_rate;
        Some(config)
    }

    pub(super) fn default_rate(&self) -> u32 {
        self.default.sample_rate()
    }

    /// 既定configそのもの、または同じ既定chの明示F32 rangeだけを証拠にする。
    /// defaultの形式が別でも、明示F32対応があればbuildでの受理を試せる。
    fn supports_default_channels_f32(&self, config: &StreamConfig) -> bool {
        config.channels > 0
            && config.channels == self.default.channels()
            && config.sample_rate > 0
            && ((self.default.sample_format() == SampleFormat::F32
                && config.sample_rate == self.default.sample_rate())
                || self.supported.as_ref().is_some_and(|ranges| {
                    ranges.iter().any(|range| {
                        range.channels() == config.channels
                            && range.sample_format() == SampleFormat::F32
                            && range.min_sample_rate() <= config.sample_rate
                            && range.max_sample_rate() >= config.sample_rate
                    })
                }))
    }

    /// ASIOの共有driverへ別rate/bufferを順に設定しない。入力の既定chは維持する。
    pub(super) fn asio_input_config(
        &self,
        output_capabilities: &Self,
        input: &StreamConfig,
        output: &StreamConfig,
    ) -> Result<StreamConfig> {
        anyhow::ensure!(
            output_capabilities.supports_default_channels_f32(output),
            "ASIO出力の既定ch・F32・選択rateの対応を確認できません"
        );
        let mut input = input.clone();
        input.sample_rate = output.sample_rate;
        input.buffer_size = output.buffer_size;
        anyhow::ensure!(
            self.supports_default_channels_f32(&input),
            "ASIO入力の既定ch・F32・共通rateの対応を確認できません"
        );
        Ok(input)
    }

    pub(super) fn default_buffer_range(&self) -> Option<(u32, u32)> {
        match self.default.buffer_size() {
            SupportedBufferSize::Range { min, max } => Some((*min, *max)),
            SupportedBufferSize::Unknown => None,
        }
    }

    pub(super) fn locked_buffer_override(&self, current_block_size: usize) -> Option<u32> {
        self.default_buffer_range().and_then(|(min, max)| {
            (min == max && min as usize != current_block_size).then_some(min)
        })
    }

    pub(super) fn max_channels(&self) -> u16 {
        self.supported
            .as_ref()
            .and_then(|supported| supported.iter().map(|range| range.channels()).max())
            .unwrap_or(2)
    }

    pub(super) fn buffer_range(&self) -> Option<(u32, u32)> {
        let mut min_buffer = u32::MAX;
        let mut max_buffer = 0;
        let mut found = false;
        for range in self.supported.iter().flatten() {
            if let SupportedBufferSize::Range { min, max } = range.buffer_size() {
                min_buffer = min_buffer.min(*min);
                max_buffer = max_buffer.max(*max);
                found = true;
            }
        }
        (found && min_buffer <= max_buffer).then_some((min_buffer, max_buffer))
    }
}

pub(super) fn timed<T>(phase: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = work();
    report_phase(phase, started);
    result
}

pub(super) fn report_phase(phase: &str, started: Instant) {
    log::debug!(
        "[StartupPhase] phase={phase} us={}",
        started.elapsed().as_micros()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::SampleFormat;
    use std::cell::Cell;

    #[test]
    fn asio_uses_one_output_selected_rate_for_both_build_configs_and_one_default_retry() {
        use super::super::lifecycle::StartupPolicy;
        let snapshot = |channels| CapabilitySnapshot {
            default: default(96_000, channels, SupportedBufferSize::Unknown),
            supported: Some(vec![range(
                channels,
                48_000,
                96_000,
                SupportedBufferSize::Unknown,
            )]),
        };
        let input = snapshot(2);
        let output = snapshot(22);
        let mut policy = StartupPolicy::default();
        let mut requested = 48_000;
        let mut builds = Vec::new();
        for rejected_output in [true, false] {
            let out = output.output_config(Some(requested), Some(512));
            let input = input
                .asio_input_config(&output, &input.input_config(Some(512)), &out)
                .unwrap();
            assert_eq!(input.sample_rate, out.sample_rate);
            assert_eq!((input.channels, out.channels), (2, 22));
            assert_eq!(input.buffer_size, out.buffer_size);
            // buildの代わりに純粋な設定伝達だけを記録する。実機の受理を偽装しない。
            builds.push(("output", out.sample_rate));
            if !rejected_output {
                builds.push(("input", input.sample_rate));
            }
            assert!(policy
                .retry_default_input(policy.prefer_same_rate_input(true))
                .is_none());
            if rejected_output {
                policy = policy.retry_default_output().unwrap();
                requested = output.default_rate();
            }
        }
        assert_eq!(
            builds,
            [("output", 48_000), ("output", 96_000), ("input", 96_000)]
        );
        assert!(policy.retry_default_output().is_none());
        let out = output.output_config(Some(48_000), Some(256));
        let input = input
            .asio_input_config(&output, &input.input_config(Some(256)), &out)
            .unwrap();
        assert_eq!((out.sample_rate, input.sample_rate), (48_000, 48_000));
    }

    #[test]
    fn asio_capability_evidence_distinguishes_native_f32_from_explicit_ranges_and_unknown() {
        let known = CapabilitySnapshot {
            default: default(96_000, 2, SupportedBufferSize::Unknown),
            supported: Some(vec![range(2, 48_000, 96_000, SupportedBufferSize::Unknown)]),
        };
        let out48 = known.output_config(Some(48_000), None);
        for supported in [
            None,
            Some(vec![]),
            Some(vec![range(1, 48_000, 48_000, SupportedBufferSize::Unknown)]),
            Some(vec![SupportedStreamConfigRange::new(
                2,
                48_000,
                48_000,
                SupportedBufferSize::Unknown,
                SampleFormat::I16,
            )]),
        ] {
            let unknown = CapabilitySnapshot {
                default: default(96_000, 2, SupportedBufferSize::Unknown),
                supported,
            };
            assert!(unknown
                .asio_input_config(&known, &unknown.input_config(None), &out48)
                .is_err());
            let out96 = known.output_config(None, None);
            // 取得できたdefault F32自体は、一覧失敗時にも既知能力。
            assert!(unknown
                .asio_input_config(&known, &unknown.input_config(None), &out96)
                .is_ok());
            assert!(known
                .asio_input_config(&unknown, &known.input_config(None), &out48)
                .is_err());
        }
        let different_format = CapabilitySnapshot {
            default: SupportedStreamConfig::new(
                2,
                96_000,
                SupportedBufferSize::Unknown,
                SampleFormat::I16,
            ),
            supported: Some(vec![range(2, 48_000, 48_000, SupportedBufferSize::Unknown)]),
        };
        assert!(different_format
            .asio_input_config(&known, &different_format.input_config(None), &out48)
            .is_ok());
        assert!(different_format
            .asio_input_config(
                &known,
                &different_format.input_config(None),
                &known.output_config(None, None)
            )
            .is_err());
        let mut wrong_channels = known.input_config(None);
        wrong_channels.channels = 1;
        assert!(known
            .asio_input_config(&known, &wrong_channels, &out48)
            .is_err());
    }

    #[test]
    fn asio_uses_effective_output_buffer_after_locked_override_without_promoting_default() {
        let output = CapabilitySnapshot {
            default: default(
                96_000,
                22,
                SupportedBufferSize::Range { min: 512, max: 512 },
            ),
            supported: Some(vec![range(
                22,
                48_000,
                96_000,
                SupportedBufferSize::Range { min: 512, max: 512 },
            )]),
        };
        let input = CapabilitySnapshot {
            default: default(96_000, 2, SupportedBufferSize::Unknown),
            supported: Some(vec![range(2, 48_000, 96_000, SupportedBufferSize::Unknown)]),
        };
        for requested in [128, 256] {
            let mut out = output.output_config(Some(48_000), Some(requested));
            out.buffer_size =
                BufferSize::Fixed(output.locked_buffer_override(requested as usize).unwrap());
            let coupled = input
                .asio_input_config(&output, &input.input_config(Some(requested)), &out)
                .unwrap();
            assert_eq!(
                (out.buffer_size, coupled.buffer_size),
                (BufferSize::Fixed(512), BufferSize::Fixed(512))
            );
            assert_eq!((out.sample_rate, coupled.sample_rate), (48_000, 48_000));
        }
        let default_out = output.output_config(None, None);
        let coupled = input
            .asio_input_config(&output, &input.input_config(Some(128)), &default_out)
            .unwrap();
        assert_eq!(
            (default_out.buffer_size, coupled.buffer_size),
            (BufferSize::Default, BufferSize::Default)
        );
    }

    fn default(rate: u32, channels: u16, buffer: SupportedBufferSize) -> SupportedStreamConfig {
        SupportedStreamConfig::new(channels, rate, buffer, SampleFormat::F32)
    }
    fn range(
        channels: u16,
        min_rate: u32,
        max_rate: u32,
        buffer: SupportedBufferSize,
    ) -> SupportedStreamConfigRange {
        SupportedStreamConfigRange::new(channels, min_rate, max_rate, buffer, SampleFormat::F32)
    }

    #[test]
    fn same_rate_input_keeps_default_channels_and_effective_buffer_at_range_boundaries() {
        let snapshot = CapabilitySnapshot {
            default: default(44_100, 2, SupportedBufferSize::Unknown),
            supported: Some(vec![range(2, 48_000, 96_000, SupportedBufferSize::Unknown)]),
        };
        for buffer in [None, Some(1024)] {
            let base = snapshot.input_config(buffer);
            for rate in [48_000, 96_000] {
                let selected = snapshot.same_rate_input(&base, rate).unwrap();
                assert_eq!(selected.sample_rate, rate);
                assert_eq!(selected.channels, 2);
                assert_eq!(selected.buffer_size, base.buffer_size);
            }
            assert_eq!(base.sample_rate, 44_100);
            for rate in [44_100, 47_999, 96_001] {
                assert!(snapshot.same_rate_input(&base, rate).is_none());
            }
        }
    }

    #[test]
    fn same_rate_input_does_not_infer_support_from_other_channels_formats_or_failed_query() {
        for supported in [
            None,
            Some(vec![]),
            Some(vec![range(1, 48_000, 48_000, SupportedBufferSize::Unknown)]),
            Some(vec![SupportedStreamConfigRange::new(
                2,
                48_000,
                48_000,
                SupportedBufferSize::Unknown,
                SampleFormat::I16,
            )]),
        ] {
            let snapshot = CapabilitySnapshot {
                default: default(44_100, 2, SupportedBufferSize::Unknown),
                supported,
            };
            assert!(snapshot
                .same_rate_input(&snapshot.input_config(Some(256)), 48_000)
                .is_none());
        }
        let snapshot = CapabilitySnapshot {
            default: SupportedStreamConfig::new(
                2,
                44_100,
                SupportedBufferSize::Unknown,
                SampleFormat::I16,
            ),
            supported: Some(vec![range(2, 48_000, 48_000, SupportedBufferSize::Unknown)]),
        };
        assert!(snapshot
            .same_rate_input(&snapshot.input_config(None), 48_000)
            .is_none());
    }

    #[test]
    fn single_queries_supply_selection_channels_ranges_lock_and_fallback() {
        let defaults = Cell::new(0);
        let supported = Cell::new(0);
        let snapshot = CapabilitySnapshot::capture(
            || {
                defaults.set(defaults.get() + 1);
                Ok(default(
                    48_000,
                    2,
                    SupportedBufferSize::Range { min: 512, max: 512 },
                ))
            },
            || {
                supported.set(supported.get() + 1);
                Ok(vec![
                    range(
                        8,
                        44_100,
                        96_000,
                        SupportedBufferSize::Range {
                            min: 128,
                            max: 1024,
                        },
                    ),
                    range(
                        4,
                        48_000,
                        192_000,
                        SupportedBufferSize::Range { min: 64, max: 2048 },
                    ),
                    range(2, 48_000, 96_000, SupportedBufferSize::Unknown),
                ]
                .into_iter())
            },
        )
        .unwrap();
        for _ in 0..3 {
            let output = snapshot.output_config(Some(96_000), Some(256));
            assert_eq!((output.sample_rate, output.channels), (96_000, 2));
            assert_eq!(output.buffer_size, BufferSize::Fixed(256));
            assert_eq!(snapshot.input_config(Some(256)).sample_rate, 48_000);
            let preferred = snapshot
                .same_rate_input(&snapshot.input_config(Some(256)), 96_000)
                .unwrap();
            assert_eq!((preferred.sample_rate, preferred.channels), (96_000, 2));
            assert_eq!(snapshot.max_channels(), 8);
            assert_eq!(snapshot.buffer_range(), Some((64, 2048)));
            assert_eq!(snapshot.default_buffer_range(), Some((512, 512)));
            assert_eq!(snapshot.locked_buffer_override(256), Some(512));
            assert_eq!(snapshot.locked_buffer_override(512), None);
            assert_eq!(snapshot.default_rate(), 48_000);
            assert_eq!(
                snapshot.output_config(Some(384_000), None).sample_rate,
                48_000
            );
        }
        assert_eq!((defaults.get(), supported.get()), (1, 1));
    }

    #[test]
    fn failed_supported_is_not_queried_again_and_next_attempt_is_fresh() {
        let defaults = Cell::new(0);
        let supported = Cell::new(0);
        for attempt in 1..=2 {
            let snapshot = CapabilitySnapshot::capture(
                || {
                    defaults.set(defaults.get() + 1);
                    Ok(default(44_100 * attempt, 6, SupportedBufferSize::Unknown))
                },
                || -> Result<std::vec::IntoIter<SupportedStreamConfigRange>> {
                    supported.set(supported.get() + 1);
                    Err(anyhow::anyhow!("injected failure"))
                },
            )
            .unwrap();
            assert_eq!(
                snapshot.output_config(Some(192_000), Some(512)).sample_rate,
                44_100 * attempt
            );
            assert_eq!(snapshot.max_channels(), 2);
            assert!(snapshot
                .same_rate_input(&snapshot.input_config(None), 96_000)
                .is_none());
            assert_eq!(snapshot.buffer_range(), None);
            assert_eq!(snapshot.default_buffer_range(), None);
            assert_eq!(snapshot.default_rate(), 44_100 * attempt);
            assert_eq!(snapshot.locked_buffer_override(512), None);
        }
        assert_eq!((defaults.get(), supported.get()), (2, 2));
    }

    #[test]
    fn default_failure_aborts_without_supported_query_and_new_attempt_retries() {
        let calls = Cell::new(0);
        for _ in 0..2 {
            assert!(CapabilitySnapshot::capture(
                || {
                    calls.set(calls.get() + 1);
                    Err(anyhow::anyhow!("default unavailable"))
                },
                || -> Result<std::iter::Empty<SupportedStreamConfigRange>> {
                    panic!("default failure must abort the attempt")
                }
            )
            .is_err());
        }
        assert_eq!(calls.get(), 2);
    }
}

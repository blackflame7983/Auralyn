use super::*;
use crate::dsp_verification_allocator::allocation_counts;

fn settings(enabled: bool) -> Settings {
    Settings {
        enabled,
        mode: NoiseControlMode::Low,
        strength: 1.0,
        voice_guard: true,
    }
}

fn analysis(speech: bool) -> Analysis {
    Analysis {
        speech,
        profile_rms: None,
        learned_mix: 0.6,
        has_learned_mix: false,
    }
}

#[test]
fn known_delay_impulses_have_one_aligned_peak_at_every_supported_rate() {
    for rate in [8_000, 44_100, 48_000, 96_000, 192_000, 384_000] {
        let delay = NoiseGeometry::checked(rate).unwrap().frames * 2 - 1;
        let input: Vec<_> = (0..delay * 4)
            .map(|n| {
                if n == 3 {
                    [0.75, -0.25]
                } else if n == delay + 9 {
                    [-0.25, 0.5]
                } else {
                    [0.0; 2]
                }
            })
            .collect();
        for wet in [0.0, 0.15, 0.6, 0.82, 1.0] {
            let mut mix = AlignedMix::new(delay, 1);
            for (n, &dry) in input.iter().enumerate() {
                let processed = if n >= delay {
                    input[n - delay]
                } else {
                    [0.0; 2]
                };
                let actual = mix.process(
                    MixFrame {
                        dry,
                        wet,
                        protect_voice: false,
                    },
                    processed,
                );
                if n < delay {
                    assert!(actual.is_none());
                } else {
                    for (a, b) in actual.unwrap().into_iter().zip(processed) {
                        assert!((a - b).abs() < 1e-7, "rate={rate}, wet={wet}, sample={n}");
                    }
                }
            }
        }
    }
}

#[test]
fn mix_and_voice_guard_follow_the_input_frame_instead_of_current_time() {
    let mut mix = AlignedMix::new(7, 1);
    for n in 0..50 {
        let wet = if n < 12 { 0.6 } else { 0.82 };
        let actual = mix.process(
            MixFrame {
                dry: [1.0; 2],
                wet,
                protect_voice: n >= 12,
            },
            [0.0; 2],
        );
        if n >= 7 {
            let expected = if n - 7 < 12 { 0.4 } else { 0.18 };
            assert!((actual.unwrap()[0] - expected).abs() < 1e-6);
        }
    }
}

#[test]
fn original_modes_strength_and_voice_guard_targets_are_preserved() {
    let cases = [
        (NoiseControlMode::Low, 1.0, false, false, None, 0.6),
        (NoiseControlMode::Low, 0.25, true, true, None, 0.15),
        (NoiseControlMode::High, 1.25, true, false, None, 1.0),
        (NoiseControlMode::High, 1.0, true, true, None, 0.82),
        (NoiseControlMode::Smart, 1.0, false, true, None, 0.74),
        (NoiseControlMode::Smart, 1.0, false, true, Some(0.01), 0.776),
        (NoiseControlMode::Venue, 1.0, true, true, Some(0.01), 0.6192),
        (
            NoiseControlMode::Venue,
            1.0,
            false,
            true,
            Some(0.01),
            0.9116,
        ),
    ];
    for (mode, strength, speech, guard, profile_rms, expected) in cases {
        let mut control = RtNoiseControl::prepare(
            48_000,
            Settings {
                enabled: true,
                mode,
                strength,
                voice_guard: guard,
            },
        )
        .unwrap();
        control.begin_block(Analysis {
            speech,
            profile_rms,
            has_learned_mix: profile_rms.is_some(),
            learned_mix: 0.82,
        });
        assert!((control.frame.wet - expected).abs() < 1e-6);
        assert_eq!(control.frame.protect_voice, speech && guard);
        assert_eq!(
            control.gate_threshold.is_some(),
            profile_rms.is_some()
                && !speech
                && matches!(mode, NoiseControlMode::Smart | NoiseControlMode::Venue)
        );
    }
}

#[test]
fn wet_changes_ramp_but_never_exceed_the_delayed_voice_guard_cap() {
    let mut mix = AlignedMix::new(1, 10);
    let frame = |wet, protect_voice| MixFrame {
        dry: [1.0; 2],
        wet,
        protect_voice,
    };
    mix.process(frame(0.0, false), [0.0; 2]);
    assert_eq!(mix.process(frame(1.0, false), [0.0; 2]), Some([1.0; 2]));
    for step in 1..=10 {
        let y = mix.process(frame(1.0, false), [0.0; 2]).unwrap()[0];
        assert!((y - (1.0 - step as f32 / 10.0)).abs() < 1e-6);
    }
    mix.process(frame(0.82, true), [0.0; 2]);
    let protected = mix.process(frame(0.82, true), [0.0; 2]).unwrap()[0];
    assert!((protected - 0.18).abs() < 1e-6);
    mix.process(frame(1.0, false), [0.0; 2]);
    for step in 1..=10 {
        let y = mix.process(frame(1.0, false), [0.0; 2]).unwrap()[0];
        assert!((y - 0.18 * (1.0 - step as f32 / 10.0)).abs() < 1e-6);
    }
}

#[test]
fn real_nr_cold_start_matches_delayed_dry_and_the_unchanged_denoiser() {
    for rate in [8_000, 44_100, 48_000, 96_000] {
        let mut control = RtNoiseControl::prepare(rate, settings(true)).unwrap();
        control.begin_block(analysis(false));
        let mut reference = RtNoiseReducer::prepare(rate).unwrap();
        let delay = control.aligned.history.len();
        let fade = control.gain.length;
        let input: Vec<_> = (0..delay * 5)
            .map(|n| {
                [
                    (n as f32 * 0.041).sin() * 0.2,
                    (n as f32 * 0.017).cos() * 0.1,
                ]
            })
            .collect();
        for (n, &x) in input.iter().enumerate() {
            let wet = reference.process_sample(x[0], x[1]);
            let actual = control.process_sample(x[0], x[1]);
            if n < delay {
                assert_eq!(actual, [0.0; 2]);
            } else {
                let gain = ((n - delay + 1) as f32 / fade as f32).min(1.0);
                let dry = input[n - delay];
                for (ch, w) in [wet.0, wet.1].into_iter().enumerate() {
                    let expected = (dry[ch] * 0.4 + w * 0.6) * gain;
                    assert!(
                        (actual[ch] - expected).abs() < 1e-6,
                        "rate={rate} sample={n}"
                    );
                }
            }
        }
    }
}

#[test]
fn off_is_undelayed_and_on_off_switch_only_when_the_old_path_is_silent() {
    let mut control = RtNoiseControl::prepare(48_000, settings(false)).unwrap();
    control.begin_block(analysis(false));
    assert_eq!(control.process_sample(0.3, -0.2), [0.3, -0.2]);
    let fade = control.gain.length;
    let delay = control.aligned.history.len();
    control.configure(settings(true));
    for n in 0..fade {
        let y = control.process_sample(0.3, -0.2);
        assert!((y[0] - 0.3 * (1.0 - (n + 1) as f32 / fade as f32)).abs() < 1e-6);
        assert!(!control.path_enabled);
    }
    for _ in 0..delay {
        assert_eq!(control.process_sample(0.3, -0.2), [0.0; 2]);
        assert!(control.path_enabled);
    }
    for _ in 0..fade * 2 {
        control.process_sample(0.3, -0.2);
    }
    assert_eq!(control.gain.value, 1.0);
    control.configure(settings(false));
    for _ in 0..fade {
        control.process_sample(0.3, -0.2);
    }
    assert_eq!(control.gain.value, 0.0);
    for n in 0..fade {
        let actual = control.process_sample(-0.4, 0.1);
        assert!(!control.path_enabled);
        assert!((actual[0] - -0.4 * (n + 1) as f32 / fade as f32).abs() < 1e-6);
    }
    assert_eq!(control.process_sample(-0.4, 0.1), [-0.4, 0.1]);
}

#[test]
fn cancelled_switches_do_not_reset_active_nr_history() {
    let mut control = RtNoiseControl::prepare(48_000, settings(true)).unwrap();
    control.begin_block(analysis(false));
    for n in 0..3000 {
        control.process_sample((n as f32 * 0.071).sin() * 0.2, 0.0);
    }
    control.configure(settings(false));
    for _ in 0..37 {
        control.process_sample(0.1, 0.0);
    }
    let position = control.aligned.position;
    control.configure(settings(true));
    control.process_sample(0.1, 0.0);
    assert_eq!(
        control.aligned.position,
        (position + 1) % control.aligned.history.len()
    );
    for _ in 0..control.gain.length {
        control.process_sample(0.1, 0.0);
    }
    assert_eq!(control.gain.value, 1.0);
}

#[test]
fn mode_changes_keep_nr_history_and_full_wet_still_matches_the_original() {
    let high = Settings {
        mode: NoiseControlMode::High,
        voice_guard: false,
        ..settings(true)
    };
    let mut control = RtNoiseControl::prepare(48_000, high).unwrap();
    let mut reference = RtNoiseReducer::prepare(48_000).unwrap();
    control.begin_block(analysis(false));
    for n in 0..7000 {
        if n == 1500 {
            control.configure(settings(true));
            control.begin_block(analysis(false));
        }
        if n == 3000 {
            control.configure(high);
            control.begin_block(analysis(false));
        }
        let x = [
            (n as f32 * 0.061).sin() * 0.2,
            (n as f32 * 0.073).sin() * 0.1,
        ];
        let actual = control.process_sample(x[0], x[1]);
        let expected = reference.process_sample(x[0], x[1]);
        if n > 4500 {
            assert_eq!(actual, [expected.0, expected.1]);
        }
    }
}

#[test]
fn reset_discards_old_audio_and_controls_and_all_rt_paths_allocate_nothing() {
    for rate in [8_000, 44_100, 48_000, 96_000, 192_000, 384_000] {
        let mut control = RtNoiseControl::prepare(rate, settings(true)).unwrap();
        let count = control.aligned.history.len() * 3 + control.gain.length * 4;
        assert_eq!(
            allocation_counts(|| {
                control.begin_block(analysis(false));
                for n in 0..count {
                    if n % 137 == 0 {
                        control.configure(Settings {
                            enabled: n % 411 != 0,
                            mode: NoiseControlMode::Venue,
                            strength: 0.75,
                            voice_guard: true,
                        });
                        control.begin_block(Analysis {
                            speech: n % 274 == 0,
                            profile_rms: Some(0.01),
                            has_learned_mix: true,
                            learned_mix: 0.82,
                        });
                    }
                    let y = control.process_sample(0.2, -0.1);
                    assert!(y.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
                }
                control.configure(settings(true));
                control.reset_state();
                control.begin_block(analysis(false));
                for _ in 0..count {
                    assert_eq!(control.process_sample(0.0, 0.0), [0.0; 2]);
                }
                control.configure(settings(false));
                for _ in 0..count {
                    control.process_sample(0.1, -0.1);
                }
                assert_eq!(control.process_sample(0.25, -0.25), [0.25, -0.25]);
            }),
            (0, 0)
        );
    }
}

#[test]
fn invalid_samples_do_not_poison_history_or_restart() {
    let mut control = RtNoiseControl::prepare(48_000, settings(true)).unwrap();
    control.begin_block(analysis(false));
    for n in 0..6000 {
        let x = if n % 7 == 0 {
            f32::NAN
        } else if n % 13 == 0 {
            f32::INFINITY
        } else {
            0.1
        };
        assert!(control.process_sample(x, -x).iter().all(|v| v.is_finite()));
    }
    control.reset_state();
    for _ in 0..3000 {
        assert_eq!(control.process_sample(0.0, 0.0), [0.0; 2]);
    }
}

#[test]
fn callback_fragmentation_keeps_the_same_signal_correspondence() {
    let mut a = RtNoiseControl::prepare(44_100, settings(true)).unwrap();
    let mut b = RtNoiseControl::prepare(44_100, settings(true)).unwrap();
    a.begin_block(analysis(true));
    for n in 0..8192 {
        if n % 137 == 0 {
            b.begin_block(analysis(true));
        }
        let x = (n as f32 * 0.037).sin() * 0.2;
        assert_eq!(a.process_sample(x, -x), b.process_sample(x, -x));
    }
}

#[test]
fn learned_gate_is_applied_to_both_corresponding_paths() {
    let mut control = RtNoiseControl::prepare(
        48_000,
        Settings {
            mode: NoiseControlMode::Smart,
            ..settings(true)
        },
    )
    .unwrap();
    control.begin_block(Analysis {
        speech: false,
        profile_rms: Some(0.01),
        has_learned_mix: true,
        learned_mix: 0.82,
    });
    let mut reference = RtNoiseReducer::prepare(48_000).unwrap();
    let delay = control.aligned.history.len();
    let input: Vec<_> = (0..6000)
        .map(|n| (n as f32 * 0.071).sin() * 0.002 * 0.72)
        .collect();
    for (n, &gated) in input.iter().enumerate() {
        let actual = control.process_sample(gated / 0.72, gated / 0.72);
        let wet = reference.process_sample(gated, gated).0;
        if n > delay + control.gain.length {
            let expected = input[n - delay] * 0.224 + wet * 0.776;
            assert!((actual[0] - expected).abs() < 1e-7);
        }
    }
}

#[test]
fn invalid_environment_does_not_strengthen_or_discard_an_explicitly_accepted_mix() {
    let mut control = RtNoiseControl::prepare(
        48_000,
        Settings {
            mode: NoiseControlMode::Smart,
            strength: 1.0,
            ..settings(true)
        },
    )
    .unwrap();
    for mix in [0.55, 0.68, 0.82, 0.92] {
        control.begin_block(Analysis {
            speech: false,
            profile_rms: Some(0.01),
            learned_mix: mix,
            has_learned_mix: true,
        });
        let before = control.frame.wet;
        control.begin_block(Analysis {
            speech: false,
            profile_rms: None,
            learned_mix: mix,
            has_learned_mix: true,
        });
        assert_eq!(control.frame.wet, before);
        assert!(control.gate_threshold.is_none());
    }
}

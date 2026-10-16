use super::RtNoiseReducer;
use crate::dsp_verification_allocator::allocation_counts;
use nnnoiseless::DenoiseState;
use nnnoiseless_reference::DenoiseState as OriginalState;

#[cfg(feature = "dsp-verification")]
pub(super) fn run_all() {
    // 最適化された通常バイナリでも計測器が確保・解放を検出することを確認する。
    assert_eq!(
        allocation_counts(|| drop(std::hint::black_box(vec![0_u8; 64]))),
        (1, 1)
    );
    cold_dsp_on_new_thread_matches_registry_version_without_allocating();
    in_place_reset_matches_fresh_registry_state_and_retains_owned_model();
    borrowed_custom_model_survives_repeated_reset_without_allocating();
    cloned_fft_workspace_keeps_history_after_original_reset_and_drop();
    engine_reset_at_partial_frames_matches_fresh_reducer_without_allocating();
}

// 測定区間外だけで呼ぶ。指定時に出力ビット列を保存し、profile間で直接比較する。
fn write_snapshot(name: &str, bits: &[u32]) {
    if let Some(dir) = std::env::var_os("AURALYN_DSP_SNAPSHOT_DIR") {
        let bytes: Vec<_> = bits.iter().flat_map(|bits| bits.to_le_bytes()).collect();
        std::fs::write(std::path::PathBuf::from(dir).join(name), bytes).unwrap();
    }
}

fn frames(kind: usize, count: usize) -> Vec<[f32; DenoiseState::FRAME_SIZE]> {
    (0..count)
        .map(|frame| {
            std::array::from_fn(|i| {
                let n = frame * DenoiseState::FRAME_SIZE + i;
                match kind {
                    0 => 0.0,
                    1 => 0.001,
                    2 => (n as f32 * 0.071).sin() * 20_000.0,
                    3 => ((n * 13 % 107) as f32 - 53.0) * 400.0,
                    4 => {
                        if n % 199 == 0 {
                            32_767.0
                        } else {
                            0.0
                        }
                    }
                    _ => {
                        if n % 101 < 50 {
                            32_767.0
                        } else {
                            -32_768.0
                        }
                    }
                }
            })
        })
        .collect()
}

#[cfg_attr(test, test)]
fn cold_dsp_on_new_thread_matches_registry_version_without_allocating() {
    for kind in 0..6 {
        // 構築は呼出側で済ませ、未使用の状態を新しい処理スレッドへ移す。
        let mut actual = DenoiseState::new();
        let mut original = OriginalState::new();
        let input = frames(kind, 32);
        std::thread::spawn(move || {
            let mut output = [0.0; DenoiseState::FRAME_SIZE];
            let mut expected = output;
            let mut snapshot = Vec::new();
            for (i, frame) in input.iter().enumerate() {
                let mut vad = 0.0;
                assert_eq!(
                    allocation_counts(|| {
                        vad = actual.process_frame(&mut output, frame);
                    }),
                    (0, 0)
                );
                let mut expected_vad = 0.0;
                let original_counts = allocation_counts(|| {
                    expected_vad = original.process_frame(&mut expected, frame);
                });
                if i == 0 {
                    // 固定中の参照版がTLS初期化を実際に踏んだことも確認する。
                    assert!(original_counts.0 > 0);
                }
                assert_eq!(vad.to_bits(), expected_vad.to_bits());
                assert!(
                    output
                        .iter()
                        .zip(expected)
                        .all(|(a, b)| a.to_bits() == b.to_bits())
                );
                snapshot.push(vad.to_bits());
                snapshot.extend(output.iter().map(|sample| sample.to_bits()));
            }
            write_snapshot(&format!("cold-{kind}.bin"), &snapshot);
        })
        .join()
        .unwrap();
    }
}

#[cfg_attr(test, test)]
fn in_place_reset_matches_fresh_registry_state_and_retains_owned_model() {
    let mut weights = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../third_party/nnnoiseless-0.5.2/src/weights.rnn"
    ))
    .to_vec();
    // 最終バイトはVAD出力層のbias。標準モデルへの置換も検出できるよう変える。
    *weights.last_mut().unwrap() = 127;
    for custom in [false, true] {
        let mut actual = if custom {
            DenoiseState::from_model(nnnoiseless::RnnModel::from_bytes(&weights).unwrap())
        } else {
            DenoiseState::new()
        };
        let input = frames(3, 32);
        for dirty_frames in [0, 1, 7, 32] {
            let address = actual.as_ref() as *const _;
            let mut output = [0.0; DenoiseState::FRAME_SIZE];
            for frame in &input[..dirty_frames] {
                actual.process_frame(&mut output, frame);
            }
            assert_eq!(allocation_counts(|| actual.reset()), (0, 0));
            assert_eq!(actual.as_ref() as *const _, address);
            let mut reference = if custom {
                OriginalState::from_model(
                    nnnoiseless_reference::RnnModel::from_bytes(&weights).unwrap(),
                )
            } else {
                OriginalState::new()
            };
            let mut expected = output;
            let mut snapshot = Vec::new();
            for frame in &input {
                let mut vad = 0.0;
                assert_eq!(
                    allocation_counts(|| {
                        vad = actual.process_frame(&mut output, frame);
                    }),
                    (0, 0)
                );
                let expected_vad = reference.process_frame(&mut expected, frame);
                assert_eq!(vad.to_bits(), expected_vad.to_bits());
                assert!(
                    output
                        .iter()
                        .zip(expected)
                        .all(|(a, b)| a.to_bits() == b.to_bits())
                );
                snapshot.push(vad.to_bits());
                snapshot.extend(output.iter().map(|sample| sample.to_bits()));
            }
            write_snapshot(&format!("reset-{custom}-{dirty_frames}.bin"), &snapshot);
        }
    }
}

#[cfg_attr(test, test)]
fn borrowed_custom_model_survives_repeated_reset_without_allocating() {
    let mut weights = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../third_party/nnnoiseless-0.5.2/src/weights.rnn"
    ))
    .to_vec();
    *weights.last_mut().unwrap() = 127;
    let model = nnnoiseless::RnnModel::from_bytes(&weights).unwrap();
    let original_model = nnnoiseless_reference::RnnModel::from_bytes(&weights).unwrap();
    let mut actual = DenoiseState::with_model(&model);
    let input = frames(3, 32);
    let mut output = [0.0; DenoiseState::FRAME_SIZE];
    let mut expected = output;
    // 独自モデルが標準と異なることを陽性対照で確認する。
    let custom_vad = actual.process_frame(&mut output, &input[0]);
    let default_vad = OriginalState::new().process_frame(&mut expected, &input[0]);
    assert_ne!(custom_vad.to_bits(), default_vad.to_bits());
    for reset in 0..3 {
        assert_eq!(allocation_counts(|| actual.reset()), (0, 0));
        let mut reference = OriginalState::with_model(&original_model);
        let mut snapshot = Vec::new();
        for frame in &input {
            let mut vad = 0.0;
            assert_eq!(
                allocation_counts(|| vad = actual.process_frame(&mut output, frame)),
                (0, 0)
            );
            let expected_vad = reference.process_frame(&mut expected, frame);
            assert_eq!(vad.to_bits(), expected_vad.to_bits());
            assert!(
                output
                    .iter()
                    .zip(expected)
                    .all(|(a, b)| a.to_bits() == b.to_bits())
            );
            snapshot.push(vad.to_bits());
            snapshot.extend(output.iter().map(|sample| sample.to_bits()));
        }
        write_snapshot(&format!("borrowed-{reset}.bin"), &snapshot);
    }
}

#[cfg_attr(test, test)]
fn cloned_fft_workspace_keeps_history_after_original_reset_and_drop() {
    let mut actual = DenoiseState::new();
    let mut reference = OriginalState::new();
    let input = frames(2, 32);
    let mut output = [0.0; DenoiseState::FRAME_SIZE];
    let mut expected = output;
    for frame in &input[..7] {
        actual.process_frame(&mut output, frame);
        reference.process_frame(&mut expected, frame);
    }
    // Cloneと最終破棄は測定外。履歴のコピーと作業領域・計画の独立した寿命を確認する。
    let mut cloned = actual.clone();
    assert_eq!(allocation_counts(|| actual.reset()), (0, 0));
    for frame in &input[7..14] {
        actual.process_frame(&mut output, frame);
    }
    drop(actual);
    std::thread::spawn(move || {
        let mut snapshot = Vec::new();
        for frame in &input[7..] {
            let mut vad = 0.0;
            assert_eq!(
                allocation_counts(|| vad = cloned.process_frame(&mut output, frame)),
                (0, 0)
            );
            let expected_vad = reference.process_frame(&mut expected, frame);
            assert_eq!(vad.to_bits(), expected_vad.to_bits());
            assert!(
                output
                    .iter()
                    .zip(expected)
                    .all(|(a, b)| a.to_bits() == b.to_bits())
            );
            snapshot.push(vad.to_bits());
            snapshot.extend(output.iter().map(|sample| sample.to_bits()));
        }
        write_snapshot("clone.bin", &snapshot);
    })
    .join()
    .unwrap();
}

#[cfg_attr(test, test)]
fn engine_reset_at_partial_frames_matches_fresh_reducer_without_allocating() {
    for rate in [8_000, 44_100, 48_000, 96_000, 192_000] {
        let mut actual = RtNoiseReducer::new(rate);
        let input: Vec<_> = (0..8192)
            .map(|i| {
                (
                    ((i * 13 % 107) as f32 - 53.0) * 0.009,
                    (i as f32 * 0.051).sin() * 0.2,
                )
            })
            .collect();
        std::thread::spawn(move || {
            for dirty_samples in [0, 1, 440, 480, 511, 2000] {
                let mut fresh = RtNoiseReducer::new(rate);
                assert_eq!(
                    allocation_counts(|| {
                        for &(l, r) in &input[..dirty_samples] {
                            actual.process_sample(l, r);
                        }
                        actual.reset_state();
                    }),
                    (0, 0)
                );
                let mut output = Vec::with_capacity(input.len());
                let mut expected = Vec::with_capacity(input.len());
                assert_eq!(
                    allocation_counts(|| {
                        for &(l, r) in &input {
                            output.push(actual.process_sample(l, r));
                            expected.push(fresh.process_sample(l, r));
                        }
                    }),
                    (0, 0)
                );
                for (&(a, b), (x, y)) in output.iter().zip(expected) {
                    assert_eq!((a.to_bits(), b.to_bits()), (x.to_bits(), y.to_bits()));
                }
                let snapshot: Vec<_> = output
                    .iter()
                    .flat_map(|(l, r)| [l.to_bits(), r.to_bits()])
                    .collect();
                write_snapshot(&format!("engine-{rate}-{dirty_samples}.bin"), &snapshot);
            }
        })
        .join()
        .unwrap();
    }
}

//! 許諾済みのローカル素材を使う明示評価。通常のテストでは実行しない。
use std::{path::PathBuf, sync::atomic::AtomicBool};

#[test]
#[ignore = "AURALYN_NR_EVALUATION_INPUTとOUTPUTを指定した素材評価専用"]
fn export_same_input_noise_candidates() {
    let input =
        PathBuf::from(std::env::var_os("AURALYN_NR_EVALUATION_INPUT").expect("評価入力が必要です"));
    let output = PathBuf::from(
        std::env::var_os("AURALYN_NR_EVALUATION_OUTPUT").expect("新規の評価出力先が必要です"),
    );
    assert!(input.is_absolute() && output.is_absolute());
    let mut reader = hound::WavReader::open(&input).expect("評価WAVを読めません");
    let spec = reader.spec();
    assert_eq!(spec.channels, 2);
    assert_eq!(spec.sample_format, hound::SampleFormat::Float);
    assert_eq!(spec.bits_per_sample, 32);
    let raw: Vec<f32> = reader
        .samples::<f32>()
        .collect::<Result<_, _>>()
        .expect("WAVの形式が不正です");
    assert!(!raw.is_empty() && raw.iter().all(|v| v.is_finite()));
    assert!(raw.len().is_multiple_of(2) && raw.len() / 2 <= spec.sample_rate as usize * 10);
    std::fs::create_dir(&output).expect("出力先は未作成のディレクトリにしてください");
    let current = crate::audio_engine::noise_candidate::Config {
        enabled: true,
        ..Default::default()
    };
    let variants = [
        (
            "off",
            crate::audio_engine::noise_candidate::Config::default(),
        ),
        ("current", current.clone()),
        (
            "weaker",
            current.variant(crate::audio_engine::noise_candidate::Variant::Weaker),
        ),
        (
            "stronger",
            current.variant(crate::audio_engine::noise_candidate::Variant::Stronger),
        ),
    ];
    let mut records = Vec::new();
    for (name, config) in variants {
        let mut rendered = vec![0.0f32; raw.len()];
        let delay = super::noise_control::render_candidate(
            &raw,
            spec.sample_rate,
            &config,
            &AtomicBool::new(false),
            |index, frame| {
                rendered[index * 2] = frame[0];
                rendered[index * 2 + 1] = frame[1];
            },
        )
        .expect("現行NRの候補生成に失敗しました");
        assert!(rendered.iter().all(|v| v.is_finite()));
        if name == "off" {
            assert_eq!(raw, rendered);
        }
        let file = format!("{name}.wav");
        let mut writer =
            hound::WavWriter::create(output.join(&file), spec).expect("候補WAVを作れません");
        for value in &rendered {
            writer.write_sample(*value).expect("WAVを書けません");
        }
        writer.finalize().expect("WAVを確定できません");
        let peak = rendered.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        records.push(serde_json::json!({"name":name,"file":file,"settings":config,"correspondenceShiftSamples":delay,
            "peak":peak,"frames":raw.len()/2,"sampleRate":spec.sample_rate}));
    }
    std::fs::write(
        output.join("variants.json"),
        serde_json::to_vec_pretty(&records).unwrap(),
    )
    .expect("比較条件を保存できません");
}

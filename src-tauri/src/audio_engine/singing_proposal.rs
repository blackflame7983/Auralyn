//! 封印済みrawの非RT解析。音声・部屋の識別や品質改善を保証しない暫定ルール。
use super::{
    builtin::{Config, Preset},
    singing::SingingParams,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

pub const RULE_VERSION: &str = "singing-rules-v1";
pub const RULE_VERSION_V2: &str = "singing-rules-v2";
macro_rules! choice {
    ($name:ident,$default:ident $(,$other:ident)*) => {
        #[derive(Clone,Copy,Debug,Default,PartialEq,Eq,Serialize,Deserialize)]
        #[serde(rename_all="lowercase")]
        pub enum $name { #[default] $default, $($other),* }
    };
}
choice!(DynamicsWish, Natural, Even);
choice!(LowCutWish, Preserve, Tidy);
choice!(BrightnessWish, Keep, Brighter, Softer);
choice!(RoomWish, Unknown, Reflective, Dry);
choice!(ReverbWish, Keep, None, Short, Wide);
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub dynamics: DynamicsWish,
    pub low_cut: LowCutWish,
    pub brightness: BrightnessWish,
    pub room: RoomWish,
    pub reverb: ReverbWish,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub shared_activity_windows: usize,
    pub hpf_energy_loss_db: f64,
    pub control_spread_db: f64,
    pub candidate_spread_db: f64,
    pub level_loss_db: f64,
    pub max_gain_reduction_db: f64,
    pub pre_clamp_peak: f64,
    pub pre_clamp_over_count: u64,
    pub final_peak_before_tail_fade: f64,
}
const MIN_SECONDS: u32 = 3;
const ACTIVITY_DB: f64 = -45.0;
const MIN_ACTIVE_WINDOWS: usize = 50;
const MAX_WINDOWS: usize = 1501;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub code: String,
    pub args: BTreeMap<String, f64>,
    pub fallback_ja: String,
}
impl Message {
    pub(crate) fn new(code: &str, text: &str) -> Self {
        Self {
            code: code.into(),
            args: BTreeMap::new(),
            fallback_ja: text.into(),
        }
    }
    fn number(mut self, key: &str, value: f64) -> Self {
        self.args.insert(key.into(), value);
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub sample_rate: u32,
    pub source_frames: usize,
    pub duration_seconds: f64,
    pub channel_peak: [f64; 2],
    pub channel_rms_db: [f64; 2],
    pub window_ms: u32,
    pub activity_threshold_db: f64,
    pub total_windows: usize,
    pub active_windows: usize,
    pub active_fraction: f64,
    pub active_rms_p10_db: f64,
    pub active_rms_p50_db: f64,
    pub active_rms_p90_db: f64,
    pub active_window_spread_db: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    /// BuiltinSnapshotのepoch。試聴sessionのepochとは区別する。
    pub epoch: String,
    pub recording_id: u64,
    pub base_revision: String,
    pub rule_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Preferences>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<Evaluation>,
    pub config: Config,
    pub metrics: Metrics,
    pub reasons: Vec<Message>,
    pub limitations: Vec<Message>,
}
#[derive(Clone)]
pub(crate) struct Seed {
    pub preferences: Option<Preferences>,
    pub preferences_revision: Option<u64>,
    pub epoch: String,
    pub recording_id: u64,
    pub base_revision: String,
}
fn db(energy: f64) -> f64 {
    10.0 * energy.max(1e-20).log10()
}

pub(crate) fn analyze(
    id: &str,
    raw: &[f32],
    rate: u32,
    base: &Config,
    seed: &Seed,
    cancel: &AtomicBool,
) -> Result<Proposal, Message> {
    let frames = raw.len() / 2;
    if !raw.len().is_multiple_of(2)
        || !(8_000..=192_000).contains(&rate)
        || frames > rate as usize * 30
        || (seed.preferences.is_some()
            && frames.div_ceil((rate as usize / 50).max(1)) > MAX_WINDOWS)
    {
        return Err(Message::new(
            "proposal.unsupportedRecording",
            "録音の長さまたはレートが提案の対応範囲外です。",
        ));
    }
    if frames < rate as usize * MIN_SECONDS as usize {
        return Err(Message::new(
            "proposal.tooShort",
            "3秒以上録音してから提案を作成してください。",
        )
        .number("minimumSeconds", MIN_SECONDS as f64));
    }
    let window = (rate as usize / 50).max(1);
    let mut active = Vec::with_capacity(MAX_WINDOWS);
    let mut total = 0usize;
    let mut sum = [0.0f64; 2];
    let mut peaks = [0.0f64; 2];
    for samples in raw.chunks(window * 2) {
        if cancel.load(Ordering::Acquire) {
            return Err(Message::new(
                "proposal.cancelled",
                "提案の作成を中止しました。",
            ));
        }
        let mut energy = [0.0f64; 2];
        for (frame_index, frame) in samples.chunks_exact(2).enumerate() {
            if frame_index % 256 == 0 {
                cancelled(cancel)?;
            }
            for ch in 0..2 {
                let value = frame[ch] as f64;
                if !value.is_finite() {
                    return Err(Message::new(
                        "proposal.nonfinite",
                        "録音に不正な値があるため提案を作成できません。",
                    ));
                }
                if value.abs() >= 0.999 {
                    return Err(Message::new(
                        "proposal.sampleCeiling",
                        "録音のピークが上限付近です。入力音量を確認して録音し直してください。",
                    ));
                }
                energy[ch] += value * value;
                peaks[ch] = peaks[ch].max(value.abs());
            }
        }
        sum[0] += energy[0];
        sum[1] += energy[1];
        // 左右を足してから二乗しない。逆相や片chの声を消さない。
        let level = db((energy[0] + energy[1]) / samples.len().max(1) as f64);
        total += 1;
        if level >= ACTIVITY_DB {
            active.push(level);
        }
    }
    if peaks.iter().all(|peak| *peak < 1e-5) {
        return Err(Message::new(
            "proposal.silent",
            "録音がほぼ無音です。入力を確認して録音し直してください。",
        ));
    }
    if active.len() < MIN_ACTIVE_WINDOWS {
        return Err(Message::new(
            "proposal.insufficientActivity",
            "提案に使える音量の区間が不足しています。声を1秒以上含めて録音し直してください。",
        )
        .number("minimumActiveSeconds", 1.0));
    }
    active.sort_by(f64::total_cmp);
    // nearest-rank。有限値だけを格納し、空配列は上で拒否する。
    let percentile =
        |percent: usize| active[(active.len() * percent).div_ceil(100).saturating_sub(1)];
    let (p10, p50, p90) = (percentile(10), percentile(50), percentile(90));
    let spread = p90 - p10;
    let dynamics = if spread >= 9.0 { 0.35 } else { 0.20 };
    let mut config = base.clone();
    config.active = true;
    config.preset = Preset::Singing;
    config.singing = Some(SingingParams {
        low_cut_hz: 80.0,
        dynamics,
        brightness_db: 0.0,
    });
    config.reverb = Some(super::reverb::ReverbParams {
        enabled: false,
        ..base.reverb.unwrap_or_default()
    });
    let config = config.normalize().map_err(|_| {
        Message::new(
            "proposal.invalidConfig",
            "内蔵処理の設定を確認できません。現在値を再取得してください。",
        )
    })?;
    let metrics = Metrics {
        sample_rate: rate,
        source_frames: frames,
        duration_seconds: frames as f64 / rate as f64,
        channel_peak: peaks,
        channel_rms_db: sum.map(|s| db(s / frames as f64)),
        window_ms: 20,
        activity_threshold_db: ACTIVITY_DB,
        total_windows: total,
        active_windows: active.len(),
        active_fraction: active.len() as f64 / total as f64,
        active_rms_p10_db: p10,
        active_rms_p50_db: p50,
        active_rms_p90_db: p90,
        active_window_spread_db: spread,
    };
    if cancel.load(Ordering::Acquire) {
        return Err(Message::new(
            "proposal.cancelled",
            "提案の作成を中止しました。",
        ));
    }
    let proposal = Proposal {
        id: id.into(), epoch: seed.epoch.clone(), recording_id: seed.recording_id,
        base_revision: seed.base_revision.clone(), rule_version: RULE_VERSION.into(), config, metrics,
        preferences:None, preferences_revision:None,evaluation:None,
        reasons: vec![
            Message::new("proposal.dynamicsFromWindowSpread", "20ms区間の音量差を使い、控えめなコンプの候補を選びました。品質改善を保証する値ではありません。").number("spreadDb", spread).number("dynamics", dynamics as f64),
            Message::new("proposal.fixedStartingPoints", "低音整理80Hz・明るさ0dB・残響OFFは測定から決めた最適値ではなく、比較を始めるための初期候補です。"),
        ],
        limitations: vec![
            Message::new("proposal.notSpeechOrNoiseDetection", "活動区間は音量だけで選んでいます。声とノイズ、伴奏の区別やSNRの測定はしていません。"),
            Message::new("proposal.roomAndTasteUnknown", "部屋の残響や好みは録音だけでは決められません。残響・明るさは手動で調整して聞き比べてください。"),
            Message::new("proposal.rawTapOnly", "解析対象は入力音量とチャンネル選択後、NR・内蔵処理・VST前の録音です。送出音や他アプリへの到達を評価するものではありません。"),
            Message::new("proposal.listeningUnverified", "この暫定ルールは本人の歌唱音声で聴感を確認していません。適用前に候補を聞き比べてください。"),
        ],
    };
    if let Some(preferences) = &seed.preferences {
        evaluate_preferences(
            proposal,
            raw,
            rate,
            base,
            preferences,
            seed.preferences_revision,
            cancel,
        )
    } else {
        Ok(proposal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(raw: &[f32], rate: u32, cancel: bool) -> Result<Proposal, Message> {
        analyze(
            "p1",
            raw,
            rate,
            &Config::default(),
            &Seed {
                preferences: None,
                preferences_revision: None,
                epoch: "e".into(),
                recording_id: 1,
                base_revision: "2".into(),
            },
            &AtomicBool::new(cancel),
        )
    }
    fn tone(rate: u32, inverse: bool, varying: bool) -> Vec<f32> {
        (0..rate as usize * 4)
            .flat_map(|i| {
                let amp = if varying && (i / (rate as usize / 2)).is_multiple_of(2) {
                    0.05
                } else {
                    0.3
                };
                let x = amp * (std::f32::consts::TAU * 220.0 * i as f32 / rate as f32).sin();
                [x, if inverse { -x } else { x }]
            })
            .collect()
    }
    #[test]
    fn proposal_energy_preserves_inverse_and_single_channel_and_rates() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            let normal = run(&tone(rate, false, true), rate, false).unwrap();
            let opposite = run(&tone(rate, true, true), rate, false).unwrap();
            assert_eq!(
                normal.metrics.channel_rms_db,
                opposite.metrics.channel_rms_db
            );
            assert_eq!(
                normal.metrics.active_windows,
                opposite.metrics.active_windows
            );
            assert_eq!(normal.config.singing.unwrap().dynamics, 0.35);
            let mut mono = tone(rate, false, false);
            for f in mono.chunks_exact_mut(2) {
                f[1] = 0.;
            }
            let p = run(&mono, rate, false).unwrap();
            assert!(p.metrics.active_windows >= 50);
            assert_eq!(p.config.singing.unwrap().dynamics, 0.20);
            assert!(!p.config.reverb.unwrap().enabled);
        }
    }
    #[test]
    fn proposal_rejects_invalid_ceiling_silence_short_activity_and_cancel() {
        let rate = 8_000;
        let raw = tone(rate, true, false);
        assert_eq!(
            run(&raw[..100], rate, false).unwrap_err().code,
            "proposal.tooShort"
        );
        for (v, code) in [
            (f32::NAN, "proposal.nonfinite"),
            (f32::INFINITY, "proposal.nonfinite"),
            (1.0, "proposal.sampleCeiling"),
        ] {
            let mut x = raw.clone();
            x[123] = v;
            assert_eq!(run(&x, rate, false).unwrap_err().code, code);
        }
        assert_eq!(
            run(&vec![0.; raw.len()], rate, false).unwrap_err().code,
            "proposal.silent"
        );
        assert_eq!(
            run(&vec![1e-4; raw.len()], rate, false).unwrap_err().code,
            "proposal.insufficientActivity"
        );
        assert_eq!(
            run(&raw, rate, true).unwrap_err().code,
            "proposal.cancelled"
        );
    }
}

fn cancelled(cancel: &AtomicBool) -> Result<(), Message> {
    if cancel.load(Ordering::Acquire) {
        Err(Message::new(
            "proposal.cancelled",
            "提案の作成を中止しました。",
        ))
    } else {
        Ok(())
    }
}
struct GridResult {
    hp_energy: f64,
    gain_energy: f64,
    output_energy: f64,
    spread: f64,
    max_gr: f64,
    pre_peak: f64,
    over: u64,
    final_peak: f64,
}
fn evaluate_grid(
    raw: &[f32],
    rate: u32,
    config: &Config,
    mask: &[bool],
    with_tail: bool,
    cancel: &AtomicBool,
) -> Result<GridResult, Message> {
    evaluate_grid_checked(raw, rate, config, mask, with_tail, || cancelled(cancel))
}
fn evaluate_grid_checked(
    raw: &[f32],
    rate: u32,
    config: &Config,
    mask: &[bool],
    with_tail: bool,
    mut checkpoint: impl FnMut() -> Result<(), Message>,
) -> Result<GridResult, Message> {
    use super::singing::{Coefficients, SingingChain};
    checkpoint()?;
    let source = raw.len() / 2;
    let frames = if with_tail {
        super::voice_check::candidate::render_frames(source,rate,config).map_err(|_|Message::new("proposal.tailBudget", "希望する残響を含む候補が容量上限を超えます。録音を短くするか残響の希望を変更してください。"))?
    } else {
        source
    };
    let mut chain = SingingChain::new(
        Coefficients::prepare(config.singing.unwrap_or_default(), rate)
            .map_err(|_| Message::new("proposal.invalidConfig", "候補の係数を準備できません。"))?,
        true,
    );
    let mut reverb = if with_tail {
        Some(
            super::reverb::Reverb::new(config.reverb.unwrap_or_default(), rate)
                .map_err(|_| Message::new("proposal.invalidConfig", "残響を準備できません。"))?,
        )
    } else {
        None
    };
    let window = (rate as usize / 50).max(1);
    let mut windows = vec![0.0f64; mask.len()];
    let mut result = GridResult {
        hp_energy: 0.0,
        gain_energy: 0.0,
        output_energy: 0.0,
        spread: 0.0,
        max_gr: 0.0,
        pre_peak: 0.0,
        over: 0,
        final_peak: 0.0,
    };
    for i in 0..frames {
        if i % 256 == 0 {
            checkpoint()?;
        }
        let input = if i < source {
            [raw[i * 2], raw[i * 2 + 1]]
        } else {
            [0.0; 2]
        };
        let output = chain.process_observed(input, input, |o| {
            result.max_gr = result
                .max_gr
                .max(-20.0 * f64::from(o.gain.max(1e-20)).log10());
            for value in o.pre_clamp {
                result.pre_peak = result.pre_peak.max(f64::from(value.abs()));
                if value.abs() > 0.98 {
                    result.over += 1;
                }
            }
            if i < source && mask[i / window] {
                let hp = o.hp.map(|x| f64::from(x).powi(2)).iter().sum::<f64>();
                let gained = o.gained.map(|x| f64::from(x).powi(2)).iter().sum::<f64>();
                result.hp_energy += hp;
                result.gain_energy += gained;
                windows[i / window] += gained;
            }
        });
        let output = if let Some(r) = &mut reverb {
            r.process(output, false)
        } else {
            output
        };
        if i < source && mask[i / window] {
            result.output_energy += output.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>();
        }
        for value in output {
            if !value.is_finite() {
                return Err(Message::new(
                    "proposal.unsafeCandidate",
                    "候補の数値を安全に確認できません。",
                ));
            }
            result.final_peak = result.final_peak.max(f64::from(value.abs()));
        }
    }
    let mut levels: Vec<f64> = windows
        .into_iter()
        .enumerate()
        .filter(|(i, _)| mask[*i])
        .map(|(i, e)| db(e / ((source - i * window).min(window) * 2) as f64))
        .collect();
    levels.sort_by(f64::total_cmp);
    if levels.is_empty() {
        return Err(Message::new(
            "proposal.insufficientActivity",
            "評価できる活動区間がありません。",
        ));
    }
    let q = |p: usize| levels[(levels.len() * p).div_ceil(100).saturating_sub(1)];
    result.spread = q(90) - q(10);
    checkpoint()?;
    Ok(result)
}
fn evaluate_preferences(
    mut proposal: Proposal,
    raw: &[f32],
    rate: u32,
    base: &Config,
    preferences: &Preferences,
    revision: Option<u64>,
    cancel: &AtomicBool,
) -> Result<Proposal, Message> {
    if !revision.is_some_and(|r| (1..=9_007_199_254_740_991).contains(&r)) {
        return Err(Message::new(
            "proposal.invalidPreferences",
            "希望の世代を確認できません。",
        ));
    }
    let window = (rate as usize / 50).max(1);
    let mut mask = Vec::with_capacity(MAX_WINDOWS);
    let mut raw_energy = 0.0;
    for samples in raw.chunks(window * 2) {
        let mut energy = [0.0; 2];
        for (i, frame) in samples.chunks_exact(2).enumerate() {
            if i % 256 == 0 {
                cancelled(cancel)?;
            }
            for ch in 0..2 {
                energy[ch] += f64::from(frame[ch]).powi(2);
            }
        }
        let active = db((energy[0] + energy[1]) / samples.len() as f64) >= ACTIVITY_DB;
        mask.push(active);
        if active {
            raw_energy += energy[0] + energy[1];
        }
        if mask.len() > MAX_WINDOWS {
            return Err(Message::new(
                "proposal.unsupportedRecording",
                "評価する区間数が上限を超えています。",
            ));
        }
    }
    let mut config = base.clone();
    config.active = true;
    config.preset = Preset::Singing;
    config.reverb = Some(super::reverb::ReverbParams {
        enabled: false,
        ..Default::default()
    });
    let mut params = SingingParams {
        low_cut_hz: 40.0,
        dynamics: 0.0,
        brightness_db: 0.0,
    };
    let mut selected_hp = None;
    for cut in [40.0, 60.0, 80.0, 100.0] {
        params.low_cut_hz = cut;
        config.singing = Some(params);
        let e = evaluate_grid(raw, rate, &config, &mask, false, cancel)?;
        let loss = db(raw_energy) - db(e.hp_energy);
        let meets = match preferences.low_cut {
            LowCutWish::Preserve => loss <= 0.25,
            LowCutWish::Tidy => (0.15..=1.0).contains(&loss),
        };
        if meets {
            selected_hp = Some((cut, loss));
            break;
        }
    }
    let (cut, hp_loss) = if let Some(selected) = selected_hp {
        selected
    } else {
        params.low_cut_hz = 40.0;
        config.singing = Some(params);
        let e = evaluate_grid(raw, rate, &config, &mask, false, cancel)?;
        proposal.reasons.push(Message::new("proposal.lowCutUnmet", "低域の希望に対するenergy目標は満たせませんでした。最弱の40Hzを比較候補とし、目標未達を明示します。"));
        (40.0, db(raw_energy) - db(e.hp_energy))
    };
    params.low_cut_hz = cut;
    params.dynamics = 0.0;
    config.singing = Some(params);
    let control = evaluate_grid(raw, rate, &config, &mask, false, cancel)?;
    let mut dynamics = 0.0;
    if preferences.dynamics == DynamicsWish::Even {
        let mut met = false;
        for value in [0.0, 0.15, 0.25, 0.35, 0.50] {
            params.dynamics = value;
            config.singing = Some(params);
            let e = evaluate_grid(raw, rate, &config, &mask, false, cancel)?;
            let loss = db(control.gain_energy) - db(e.gain_energy);
            if control.spread - e.spread >= 1.0
                && (0.0..=3.0).contains(&loss)
                && e.max_gr <= 6.0
                && e.over == 0
            {
                dynamics = value;
                met = true;
                break;
            }
        }
        if !met {
            proposal.reasons.push(Message::new("proposal.dynamicsUnmet", "音量差の目標を安全な弱いコンプでは満たせませんでした。音を小さくしただけの改善と扱わず、dynamics0で比較します。"));
        }
    }
    params.dynamics = dynamics;
    params.brightness_db = match preferences.brightness {
        BrightnessWish::Keep => base.singing.unwrap_or_default().brightness_db,
        BrightnessWish::Brighter => 1.0,
        BrightnessWish::Softer => -1.0,
    };
    config.singing = Some(params);
    config.reverb = match preferences.reverb {
        ReverbWish::Keep => base.reverb,
        ReverbWish::None => Some(super::reverb::ReverbParams {
            enabled: false,
            ..base.reverb.unwrap_or_default()
        }),
        ReverbWish::Short | ReverbWish::Wide => {
            let wide = preferences.reverb == ReverbWish::Wide;
            let dry = preferences.room == RoomWish::Dry;
            Some(super::reverb::ReverbParams {
                enabled: true,
                mix: if wide && dry {
                    0.10
                } else if wide && preferences.room == RoomWish::Unknown {
                    0.07
                } else {
                    0.05
                },
                decay_seconds: if wide && dry {
                    1.2
                } else if wide && preferences.room == RoomWish::Unknown {
                    0.9
                } else {
                    0.6
                },
                damping: 0.6,
            })
        }
    };
    config = config
        .normalize()
        .map_err(|_| Message::new("proposal.invalidConfig", "希望する設定を確認できません。"))?;
    let final_e = evaluate_grid(raw, rate, &config, &mask, true, cancel)?;
    let final_loss = db(control.output_energy) - db(final_e.output_energy);
    if final_loss > 3.0
        || final_e.over > 0
        || final_e.pre_peak > 0.980001
        || final_e.final_peak > 0.980001
        || final_e.max_gr > 6.0
    {
        return Err(Message::new("proposal.unsafeCandidate", "希望する候補はclamp前ピークまたは減衰の制約を満たしません。入力音量や希望を変更してください。"));
    }
    cancelled(cancel)?;
    proposal.rule_version = RULE_VERSION_V2.into();
    proposal.preferences = Some(preferences.clone());
    proposal.preferences_revision = revision;
    proposal.evaluation = Some(Evaluation {
        shared_activity_windows: mask.iter().filter(|v| **v).count(),
        hpf_energy_loss_db: hp_loss,
        control_spread_db: control.spread,
        candidate_spread_db: final_e.spread,
        level_loss_db: final_loss,
        max_gain_reduction_db: final_e.max_gr,
        pre_clamp_peak: final_e.pre_peak,
        pre_clamp_over_count: final_e.over,
        final_peak_before_tail_fade: final_e.final_peak,
    });
    if preferences.reverb == ReverbWish::Wide && preferences.room == RoomWish::Reflective {
        proposal.limitations.push(Message::new("proposal.roomConservative","響く部屋との自己申告のため、広めの希望にも短い控えめな残響を候補にしています。部屋の実測に基づく最適化ではありません。"));
    }
    proposal.config = config;
    proposal.reasons.retain(|m| {
        m.code != "proposal.dynamicsFromWindowSpread" && m.code != "proposal.fixedStartingPoints"
    });
    proposal.reasons.push(Message::new("proposal.measuredGrid", "同じraw活動区間と同じHPFのdynamics0対照で、固定gridから希望を満たす最弱候補を比較しました。閾値は暫定の工学的制約です。").number("lowCutHz",f64::from(cut)).number("dynamics",f64::from(dynamics)));
    proposal.limitations.push(Message::new("proposal.preferencesOnly", "明るさは本人希望、残響は本人希望と部屋の自己申告に基づきます。部屋のRT60や個人最適な音質を測定した値ではありません。"));
    Ok(proposal)
}

#[cfg(test)]
mod preference_tests {
    use super::*;
    fn signal(rate: u32, high: f32, low: f32, frequency: f32) -> Vec<f32> {
        (0..rate as usize * 3)
            .flat_map(|i| {
                let amp = if (i / (rate as usize / 2)).is_multiple_of(2) {
                    high
                } else {
                    low
                };
                let x = amp * (std::f32::consts::TAU * frequency * i as f32 / rate as f32).sin();
                [x, -x]
            })
            .collect()
    }
    fn run(raw: &[f32], base: &Config, p: Preferences) -> Result<Proposal, Message> {
        analyze(
            "v2",
            raw,
            8000,
            base,
            &Seed {
                epoch: "epoch".into(),
                recording_id: 7,
                base_revision: "4".into(),
                preferences: Some(p),
                preferences_revision: Some(2),
            },
            &AtomicBool::new(false),
        )
    }
    #[test]
    fn preference_defaults_preserve_current_brightness_reverb_and_channel_energy_symmetry() {
        let raw = signal(8000, 0.1, 0.1, 400.0);
        let base = Config {
            singing: Some(SingingParams {
                brightness_db: 0.5,
                ..Default::default()
            }),
            reverb: Some(super::super::reverb::ReverbParams {
                enabled: true,
                mix: 0.01,
                decay_seconds: 0.3,
                ..Default::default()
            }),
            ..Default::default()
        };
        let p = run(
            &raw,
            &base,
            Preferences {
                room: RoomWish::Reflective,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p.rule_version, RULE_VERSION_V2);
        assert_eq!(p.preferences_revision, Some(2));
        assert_eq!(p.config.reverb, base.reverb);
        let params = p.config.singing.unwrap();
        assert_eq!(
            (params.low_cut_hz, params.dynamics, params.brightness_db),
            (40.0, 0.0, 0.5)
        );
        let reversed: Vec<_> = raw.chunks_exact(2).flat_map(|f| [f[1], f[0]]).collect();
        let stereo: Vec<_> = raw.chunks_exact(2).flat_map(|f| [f[0], f[0]]).collect();
        for data in [&reversed, &stereo] {
            let q = run(data, &base, Preferences::default()).unwrap();
            assert_eq!(p.config, q.config);
            assert_eq!(p.metrics.active_windows, q.metrics.active_windows);
            assert_eq!(
                p.evaluation.as_ref().unwrap().hpf_energy_loss_db,
                q.evaluation.unwrap().hpf_energy_loss_db
            );
        }
        let mono: Vec<_> = raw.chunks_exact(2).flat_map(|f| [f[0], 0.0]).collect();
        let m = run(&mono, &Config::default(), Preferences::default()).unwrap();
        assert_eq!(m.config.singing.unwrap().dynamics, 0.0);
        assert_eq!(m.metrics.active_windows, p.metrics.active_windows);
    }
    #[test]
    fn v2_standard_rates_and_nonstandard_window_budget_are_explicit_without_changing_v1() {
        let seed = Seed {
            epoch: "e".into(),
            recording_id: 1,
            base_revision: "1".into(),
            preferences: Some(Default::default()),
            preferences_revision: Some(1),
        };
        for rate in [44100, 48000, 96000, 192000] {
            let raw = signal(rate, 0.05, 0.05, 400.0);
            let p = analyze(
                "standard",
                &raw,
                rate,
                &Config::default(),
                &seed,
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(p.rule_version, RULE_VERSION_V2);
            assert!(p.metrics.total_windows <= MAX_WINDOWS);
            assert_eq!(
                p.metrics.active_windows,
                p.evaluation.unwrap().shared_activity_windows
            );
        }
        let rate = 8049;
        let frames = MAX_WINDOWS * (rate as usize / 50);
        let accepted = vec![0.05; frames * 2];
        let p = analyze(
            "boundary",
            &accepted,
            rate,
            &Config::default(),
            &seed,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(p.metrics.total_windows, MAX_WINDOWS);
        let over = vec![f32::NAN; (frames + 1) * 2];
        assert_eq!(
            analyze(
                "over",
                &over,
                rate,
                &Config::default(),
                &seed,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "proposal.unsupportedRecording"
        );
        let old = Seed {
            preferences: None,
            preferences_revision: None,
            ..seed
        };
        assert_eq!(
            analyze(
                "v1",
                &over,
                rate,
                &Config::default(),
                &old,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "proposal.nonfinite"
        );
    }
    #[test]
    fn low_absolute_level_and_low_tone_report_unmet_instead_of_forcing_stronger_processing() {
        let p = run(
            &signal(8000, 0.02, 0.01, 400.0),
            &Config::default(),
            Preferences {
                dynamics: DynamicsWish::Even,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p.config.singing.unwrap().dynamics, 0.0);
        assert!(p.reasons.iter().any(|m| m.code == "proposal.dynamicsUnmet"));
        assert_eq!(p.evaluation.unwrap().max_gain_reduction_db, 0.0);
        let p = run(
            &signal(8000, 0.1, 0.1, 20.0),
            &Config::default(),
            Preferences::default(),
        )
        .unwrap();
        assert_eq!(p.config.singing.unwrap().low_cut_hz, 40.0);
        assert!(p.reasons.iter().any(|m| m.code == "proposal.lowCutUnmet"));
        assert!(p.evaluation.unwrap().hpf_energy_loss_db > 0.25);
    }
    #[test]
    fn even_grid_uses_same_hpf_control_and_selects_a_safe_weak_candidate() {
        let raw = signal(8000, 0.35, 0.03, 400.0);
        let p = run(
            &raw,
            &Config::default(),
            Preferences {
                dynamics: DynamicsWish::Even,
                ..Default::default()
            },
        )
        .unwrap();
        let params = p.config.singing.unwrap();
        assert!([0.15, 0.25, 0.35, 0.50].contains(&params.dynamics));
        let e = p.evaluation.unwrap();
        assert!(e.control_spread_db - e.candidate_spread_db >= 1.0);
        assert!(e.level_loss_db <= 3.0);
        assert!(e.max_gain_reduction_db <= 6.0);
        assert_eq!(e.pre_clamp_over_count, 0);
        let mask = vec![true; 150];
        let cancel = AtomicBool::new(false);
        let mut check = p.config.clone();
        check.singing.as_mut().unwrap().dynamics = 0.0;
        let control = evaluate_grid(&raw, 8000, &check, &mask, false, &cancel).unwrap();
        for weaker in [0.0, 0.15, 0.25, 0.35, 0.50]
            .into_iter()
            .filter(|v| *v < params.dynamics)
        {
            check.singing.as_mut().unwrap().dynamics = weaker;
            let before = evaluate_grid(&raw, 8000, &check, &mask, false, &cancel).unwrap();
            assert!(
                control.spread - before.spread < 1.0,
                "a weaker setting already met the fixed target"
            );
        }
        assert_eq!(e.shared_activity_windows, p.metrics.active_windows);
    }
    #[test]
    fn final_brightness_clamp_is_refusal_not_compressor_success_and_none_is_not_room_mapping() {
        let raw = signal(8000, 0.97, 0.97, 3000.0);
        assert_eq!(
            run(
                &raw,
                &Config::default(),
                Preferences {
                    brightness: BrightnessWish::Brighter,
                    ..Default::default()
                }
            )
            .unwrap_err()
            .code,
            "proposal.unsafeCandidate"
        );
        let raw = signal(8000, 0.1, 0.1, 400.0);
        let a = run(
            &raw,
            &Config::default(),
            Preferences {
                room: RoomWish::Dry,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(a.config.reverb, None);
        let b = run(
            &raw,
            &Config::default(),
            Preferences {
                room: RoomWish::Dry,
                reverb: ReverbWish::Short,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(b.config.reverb.unwrap().enabled);
        let c = run(
            &raw,
            &Config::default(),
            Preferences {
                room: RoomWish::Reflective,
                reverb: ReverbWish::None,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!c.config.reverb.unwrap().enabled);
    }
    #[test]
    fn grid_cancel_is_checked_mid_processing_and_tail_budget_rejects_before_pcm_allocation() {
        let raw = signal(8000, 0.1, 0.1, 400.0);
        let config = Config {
            active: true,
            preset: Preset::Singing,
            singing: Some(SingingParams::default()),
            ..Default::default()
        };
        let mask = vec![true; 150];
        let mut checks = 0;
        let result = evaluate_grid_checked(&raw, 8000, &config, &mask, false, || {
            checks += 1;
            if checks == 8 {
                Err(Message::new("proposal.cancelled", "中止"))
            } else {
                Ok(())
            }
        });
        assert_eq!(result.err().unwrap().code, "proposal.cancelled");
        assert_eq!(checks, 8);
        let mut config = config;
        config.reverb = Some(super::super::reverb::ReverbParams {
            enabled: true,
            decay_seconds: 2.5,
            ..Default::default()
        });
        let max = 64 * 1024 * 1024 / 16;
        let tail = config.reverb.unwrap().tail_frames(192000).unwrap();
        assert_eq!(
            super::super::voice_check::candidate::render_frames(max - tail, 192000, &config)
                .unwrap(),
            max
        );
        assert!(super::super::voice_check::candidate::render_frames(
            max - tail + 1,
            192000,
            &config
        )
        .is_err());
        let e = evaluate_grid(&raw, 8000, &config, &mask, true, &AtomicBool::new(false)).unwrap();
        assert!(e.final_peak.is_finite());
        assert_eq!(e.over, 0);
    }
}

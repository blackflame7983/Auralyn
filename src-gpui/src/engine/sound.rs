//! 音づくり・ピーク保護・周囲の音の測定と、音づくりの保存。

use super::*;

impl Control {
    /// エンジンの統計から音づくりの設定を読み、画面へ送る。子が落ちていたら、先に読み直す（落ちた子の既定値を読まない）。
    pub(super) fn read_sound(&mut self) {
        self.current_sound();
    }

    /// 歌向けの値・残響・歯擦音の抑制。統計に無いので内蔵処理の状態から読む。
    /// 止まっていて読めなければ、最後に読んだ値（無ければ既定）。
    fn builtin_values(&mut self) -> (Singing, Reverb, DeEsser) {
        let last = self
            .sound
            .map_or_else(Default::default, |s| (s.singing, s.reverb, s.deesser));
        match self.host.builtin_effects(BuiltinRequest::Snapshot) {
            Ok(snapshot) => (
                snapshot.config.singing.map_or(last.0, |p| Singing {
                    low_cut_hz: p.low_cut_hz,
                    dynamics: p.dynamics,
                    brightness_db: p.brightness_db,
                }),
                snapshot.config.reverb.map_or(last.1, |p| Reverb {
                    enabled: p.enabled,
                    mix: p.mix,
                    decay_seconds: p.decay_seconds,
                    damping: p.damping,
                }),
                // OFF（`None`）でも量は最後の値を保つ。
                snapshot.config.deesser.map_or(
                    DeEsser {
                        on: false,
                        ..last.2
                    },
                    |p| DeEsser {
                        on: true,
                        amount: p.amount,
                    },
                ),
            ),
            Err(e) => {
                log::info!("内蔵処理の状態を読めません: {e}");
                last
            }
        }
    }

    /// [`Self::read_sound`] と同じく読んで送り、読めた値と、ノイズ低減の種類がまだ無い（空）かを返す。読めなければ `None`。
    fn current_sound(&mut self) -> Option<(Sound, bool)> {
        self.recover();
        match self.host.get_engine_runtime_stats() {
            Ok(stats) => {
                let (singing, reverb, deesser) = self.builtin_values();
                let sound = Sound {
                    noise_on: stats.noise_reduction_enabled,
                    noise_mode: NoiseMode::parse(&stats.noise_reduction_mode),
                    strength: stats.noise_control_strength,
                    voice_guard: stats.noise_voice_guard,
                    effects_on: stats.built_in_effects_enabled,
                    preset: Preset::parse(&stats.built_in_effects_preset),
                    amount: stats.built_in_effects_amount,
                    singing,
                    reverb,
                    deesser,
                }
                .normalized();
                self.sound = Some(sound);
                let _ = self.notices.send(Notice::Sound(sound));
                Some((sound, stats.noise_reduction_mode.is_empty()))
            }
            Err(e) => {
                self.fail("get_engine_runtime_stats", e);
                None
            }
        }
    }

    /// 制限を読む（`config` があれば変えてから読む）。読めなければ `None` を送る。
    /// 止まっているときは読めないのが普通なので、読むだけの失敗は帯に出さない。
    pub(super) fn peak(&mut self, limit: Limit, config: Option<PeakConfig>) {
        let answered = config.is_some();
        let peak = match self.limit(limit, config) {
            Ok(peak) => Some(peak),
            Err(e) if answered => {
                // 断られても状態は読めることがある。
                self.fail(limit_command(limit), e);
                self.limit(limit, None).ok()
            }
            Err(e) => {
                log::info!("{} の状態を読めません: {e}", limit_command(limit));
                None
            }
        };
        let _ = self.notices.send(Notice::Peak {
            limit,
            peak,
            answered,
        });
    }

    /// ホストの制限を読む（`config` があれば変えてから）。2つの制限は設定の形が同じ。
    fn limit(&mut self, limit: Limit, config: Option<PeakConfig>) -> anyhow::Result<Peak> {
        Ok(match limit {
            Limit::Sample => {
                let snapshot = self.host.peak_protection(config)?;
                Peak {
                    enabled: snapshot.config.enabled,
                    ceiling_db: snapshot.config.ceiling_db,
                    release_ms: snapshot.config.release_ms,
                    running: snapshot.running,
                    pending: snapshot.pending,
                    lookahead: None,
                }
            }
            Limit::TruePeak => {
                let config = config.map(|c| TruePeakConfig {
                    enabled: c.enabled,
                    ceiling_db: c.ceiling_db,
                    release_ms: c.release_ms,
                });
                let snapshot = self.host.broadcast_true_peak(config)?;
                Peak {
                    enabled: snapshot.config.enabled,
                    ceiling_db: snapshot.config.ceiling_db,
                    release_ms: snapshot.config.release_ms,
                    running: snapshot.running,
                    pending: snapshot.pending,
                    lookahead: Some(Lookahead {
                        applied: snapshot.applied,
                        reduction_db: snapshot.reduction_db.max(0.0),
                        samples: snapshot.added_latency_samples,
                    }),
                }
            }
        })
    }

    /// 測定を頼み、そのあとの状態を読んで送る。読むだけの失敗は、止まっているときの普通のことなので帯に出さない。
    pub(super) fn measure(&mut self, action: &measurement::Action) {
        use measurement::Action;
        let request = match action.clone() {
            Action::Read => None,
            Action::Start(Take { epoch, generation }) => {
                Some(MeasureRequest::Start { epoch, generation })
            }
            Action::Cancel(Take { epoch, generation }) => {
                Some(MeasureRequest::Cancel { epoch, generation })
            }
            Action::Approve(Take { epoch, generation }) => Some(MeasureRequest::Approve {
                epoch,
                generation,
                acknowledged_quiet: true,
            }),
        };
        if let Some(request) = request {
            if let Err(e) = self.host.noise_measurement(request) {
                self.fail("noise_measurement", e);
            } else if matches!(action, Action::Approve(_)) {
                // 採用すると抑制の値が変わるので、音づくりも読み直す。
                self.read_sound();
            }
        }
        let reading = match self.host.noise_measurement(MeasureRequest::Snapshot) {
            Ok(snapshot) => reading(snapshot),
            Err(e) => {
                log::info!("測定の状態を読めません: {e}");
                None
            }
        };
        let _ = self.notices.send(Notice::Measurement(reading));
    }

    /// 今の設定の一部だけを変える（ON/OFF だけ、または天井と復帰時間だけ）。
    pub(super) fn set_peak(&mut self, limit: Limit, change: impl FnOnce(PeakConfig) -> PeakConfig) {
        match self.limit(limit, None) {
            Ok(peak) => self.peak(
                limit,
                Some(change(PeakConfig {
                    enabled: peak.enabled,
                    ceiling_db: peak.ceiling_db,
                    release_ms: peak.release_ms,
                })),
            ),
            Err(e) => {
                self.fail(limit_command(limit), e);
                let _ = self.notices.send(Notice::Peak {
                    limit,
                    peak: None,
                    answered: true,
                });
            }
        }
    }

    /// 変わった区画だけを送る。終わったら、エンジンが受け付けた結果を読み直して画面へ送り、保存する。
    pub(super) fn set_sound(&mut self, change: Change) {
        if self.sound.is_none() {
            self.read_sound();
        }
        let Some(before) = self.sound else {
            return;
        };
        self.apply_sound(before.with(change), Some(before));
        self.reread_and_save_sound();
    }

    /// ノイズ低減の ON/OFF を反転する。画面の値でなく、いまのエンジンの値から決める（Tauri 版のショートカットと同じ）。
    /// 種類がまだ無ければ「弱」で入れる（Tauri 版と同じ）。分からない種類は書き換えないので、切り替えずに断る。
    pub(super) fn toggle_noise(&mut self) {
        let Some((before, unset)) = self.current_sound() else {
            return;
        };
        let mut next = before.with(Change::NoiseOn(!before.noise_on));
        if next.noise_mode.is_none() {
            if !unset {
                return self.fail(
                    "set_noise_control_config",
                    anyhow::anyhow!("unknown noise reduction mode"),
                );
            }
            next.noise_mode = Some(NoiseMode::Low);
        }
        self.apply_sound(next, Some(before));
        self.reread_and_save_sound();
    }

    /// エンジンが受け付けた音づくりを読み、次の起動のために保存する。
    /// 読む前に `sound` を消さない（子が落ちていたら、読み直しで前の設定を送り直すのに使う）。
    pub(super) fn reread_and_save_sound(&mut self) {
        self.read_sound();
        if let Some(sound) = self.sound {
            self.save_sound(sound);
        }
    }

    /// `before` が `None`（起動時の読み直しなど）なら、両方の区画を送る。分からない種類は送らない。
    /// 何を送るかは `Sound::effects_request`。断られなければ、送った値を「最後の値」として持つ
    /// （エンジンが持たない値＝歌向けでないときの歌向けの値・OFF の歯擦音の量は、次に読むときこの値を使う）。
    pub(super) fn apply_sound(&mut self, next: Sound, before: Option<Sound>) {
        let mut accepted = true;
        // 種類が分からない（エンジンが知らない名前を返した）ときは送らない。種類を「弱」に書き換えないため。
        if let Some(mode) = next
            .noise_mode
            .filter(|_| before.is_none_or(|before| next.noise_differs(&before)))
        {
            if let Err(e) = self.host.set_noise_control_config(
                next.noise_on,
                mode.key().to_owned(),
                next.strength,
                next.voice_guard,
            ) {
                accepted = false;
                self.fail("set_noise_control_config", e);
            }
        }
        if let Some(request) = next.effects_request(before) {
            let preset = request.preset.map(|p| p.key().to_owned());
            let singing = request.singing.map(|s| SingingParams {
                low_cut_hz: s.low_cut_hz,
                dynamics: s.dynamics,
                brightness_db: s.brightness_db,
            });
            let reverb = request.reverb.map(|r| ReverbParams {
                enabled: r.enabled,
                mix: r.mix,
                decay_seconds: r.decay_seconds,
                damping: r.damping,
            });
            let result = match request.deesser {
                Some(deesser) => self.host.set_built_in_effects_from_profile(
                    request.active,
                    preset,
                    request.amount,
                    singing,
                    reverb,
                    deesser.map(|amount| DeEsserParams { amount }),
                ),
                None => self.host.set_built_in_effects_with_reverb(
                    request.active,
                    preset,
                    request.amount,
                    singing,
                    reverb,
                ),
            };
            if let Err(e) = result {
                accepted = false;
                self.fail("set_built_in_effects", e);
            }
        }
        if accepted {
            self.sound = Some(next);
        }
    }

    /// 起動したら、音を始める前に、保存した音づくりをエンジンへ送る。
    pub(super) fn restore_sound(&mut self) {
        let text = match std::fs::read_to_string(self.config_dir.join(SOUND_FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => return self.fail("read_sound", e.into()),
        };
        match serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| sound_from_json(&value))
        {
            Some(sound) => self.apply_sound(sound, None),
            None => self.fail("read_sound", anyhow::anyhow!("{SOUND_FILE} を読めません")),
        }
    }

    pub(super) fn save_sound(&self, sound: Sound) {
        let path = self.config_dir.join(SOUND_FILE);
        if let Err(e) = store::write_atomic(&path, sound_to_json(sound).to_string().as_bytes()) {
            self.fail("save_sound", e.into());
        }
    }
}

pub(super) fn sound_to_json(sound: Sound) -> serde_json::Value {
    serde_json::json!({
        "noiseOn": sound.noise_on,
        "noiseMode": sound.noise_mode.map(NoiseMode::key),
        "strength": sound.strength,
        "voiceGuard": sound.voice_guard,
        "effectsOn": sound.effects_on,
        "preset": sound.preset.map(Preset::key),
        "amount": sound.amount,
        "singing": {
            "lowCutHz": sound.singing.low_cut_hz,
            "dynamics": sound.singing.dynamics,
            "brightnessDb": sound.singing.brightness_db,
        },
        "reverb": {
            "enabled": sound.reverb.enabled,
            "mix": sound.reverb.mix,
            "decaySeconds": sound.reverb.decay_seconds,
            "damping": sound.reverb.damping,
        },
        "deesser": {
            "on": sound.deesser.on,
            "amount": sound.deesser.amount,
        },
    })
}

/// 形の違う保存は `None`（読めないと知らせ、上書きは次に変えたときだけ）。
/// 歌向けの値・残響・歯擦音の抑制は後から足したので、無ければ既定にする。
pub(super) fn sound_from_json(value: &serde_json::Value) -> Option<Sound> {
    let text = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    let flag = |key: &str| value.get(key).and_then(serde_json::Value::as_bool);
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_f64);
    Some(
        Sound {
            noise_on: flag("noiseOn")?,
            noise_mode: text("noiseMode").and_then(NoiseMode::parse),
            strength: number("strength")? as f32,
            voice_guard: flag("voiceGuard")?,
            effects_on: flag("effectsOn")?,
            preset: text("preset").and_then(Preset::parse),
            amount: number("amount")? as f32,
            singing: singing_from_json(value),
            reverb: reverb_from_json(value),
            deesser: DeEsser {
                on: value
                    .pointer("/deesser/on")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                amount: value
                    .pointer("/deesser/amount")
                    .and_then(serde_json::Value::as_f64)
                    .map_or(DeEsser::default().amount, |n| n as f32),
            },
        }
        .normalized(),
    )
}

fn singing_from_json(value: &serde_json::Value) -> Singing {
    let d = Singing::default();
    let number = |key: &str, default: f32| {
        value
            .pointer(&format!("/singing/{key}"))
            .and_then(serde_json::Value::as_f64)
            .map_or(default, |n| n as f32)
    };
    Singing {
        low_cut_hz: number("lowCutHz", d.low_cut_hz),
        dynamics: number("dynamics", d.dynamics),
        brightness_db: number("brightnessDb", d.brightness_db),
    }
}

fn reverb_from_json(value: &serde_json::Value) -> Reverb {
    let d = Reverb::default();
    let number = |key: &str, default: f32| {
        value
            .pointer(&format!("/reverb/{key}"))
            .and_then(serde_json::Value::as_f64)
            .map_or(default, |n| n as f32)
    };
    Reverb {
        enabled: value
            .pointer("/reverb/enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(d.enabled),
        mix: number("mix", d.mix),
        decay_seconds: number("decaySeconds", d.decay_seconds),
        damping: number("damping", d.damping),
    }
}

/// エンジンの測定の状態を画面の形にする。知らない状態は読めないものとする。
pub(super) fn reading(snapshot: Snapshot) -> Option<Measurement> {
    Some(Measurement {
        state: measurement::State::parse(&snapshot.state)?,
        take: Take {
            epoch: snapshot.epoch,
            generation: snapshot.generation,
        },
        progress: snapshot.progress,
        quality: snapshot.quality.iter().map(|q| Quality::parse(q)).collect(),
        previous: snapshot.previous_available,
    })
}

/// 失敗を帯に出すときの命令の名前（ホストの命令と同じ）。
fn limit_command(limit: Limit) -> &'static str {
    match limit {
        Limit::Sample => "peak_protection",
        Limit::TruePeak => "broadcast_true_peak",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_engine() {
        let singing = SingingParams::default();
        assert_eq!(
            Singing::default(),
            Singing {
                low_cut_hz: singing.low_cut_hz,
                dynamics: singing.dynamics,
                brightness_db: singing.brightness_db,
            }
        );
        let reverb = ReverbParams::default();
        assert_eq!(
            Reverb::default(),
            Reverb {
                enabled: reverb.enabled,
                mix: reverb.mix,
                decay_seconds: reverb.decay_seconds,
                damping: reverb.damping,
            }
        );
    }

    #[test]
    fn sound_survives_the_save_file() {
        let sound = Sound {
            noise_on: true,
            noise_mode: Some(NoiseMode::High),
            strength: 0.8,
            voice_guard: false,
            effects_on: true,
            preset: Some(Preset::Singing),
            amount: 0.5,
            singing: Singing {
                low_cut_hz: 100.0,
                dynamics: 0.5,
                brightness_db: -1.0,
            },
            reverb: Reverb {
                enabled: true,
                mix: 0.1,
                decay_seconds: 2.0,
                damping: 0.25,
            },
            deesser: DeEsser {
                on: true,
                amount: 0.3,
            },
        };
        assert_eq!(sound_from_json(&sound_to_json(sound)), Some(sound));
        let mut old = sound_to_json(sound);
        old.as_object_mut().unwrap().remove("reverb");
        assert_eq!(sound_from_json(&old).unwrap().reverb, Reverb::default());
        assert_eq!(sound_from_json(&serde_json::json!({"noiseOn": true})), None);
    }
}

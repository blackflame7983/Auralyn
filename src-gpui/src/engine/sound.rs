//! 音づくり・ピーク保護・周囲の音の測定と、音づくりの保存。

use super::*;

impl Control {
    /// エンジンの統計から音づくりの設定を読み、画面へ送る。子が落ちていたら、先に読み直す（落ちた子の既定値を読まない）。
    pub(super) fn read_sound(&mut self) {
        self.recover();
        match self.host.get_engine_runtime_stats() {
            Ok(stats) => {
                let sound = Sound {
                    noise_on: stats.noise_reduction_enabled,
                    noise_mode: NoiseMode::parse(&stats.noise_reduction_mode),
                    strength: stats.noise_control_strength,
                    voice_guard: stats.noise_voice_guard,
                    effects_on: stats.built_in_effects_enabled,
                    preset: Preset::parse(&stats.built_in_effects_preset),
                    amount: stats.built_in_effects_amount,
                }
                .normalized();
                self.sound = Some(sound);
                let _ = self.notices.send(Notice::Sound(sound));
            }
            Err(e) => self.fail("get_engine_runtime_stats", e),
        }
    }

    /// ピーク保護を読む（`config` があれば変えてから読む）。読めなければ `None` を送る。
    /// 止まっているときは読めないのが普通なので、読むだけの失敗は帯に出さない。
    pub(super) fn peak(&mut self, config: Option<PeakConfig>) {
        let peak = match self.host.peak_protection(config) {
            Ok(snapshot) => Some(Peak {
                enabled: snapshot.config.enabled,
                ceiling_db: snapshot.config.ceiling_db,
                release_ms: snapshot.config.release_ms,
                running: snapshot.running,
                pending: snapshot.pending,
            }),
            Err(e) if config.is_some() => {
                // 断られても状態は読めることがある（読めないなら、読み直しが `None` を送る）。
                self.fail("peak_protection", e);
                return self.peak(None);
            }
            Err(e) => {
                log::info!("ピーク保護の状態を読めません: {e}");
                None
            }
        };
        let _ = self.notices.send(Notice::Peak(peak));
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
    pub(super) fn set_peak(&mut self, change: impl FnOnce(PeakConfig) -> PeakConfig) {
        match self.host.peak_protection(None) {
            Ok(snapshot) => self.peak(Some(change(snapshot.config))),
            Err(e) => {
                self.fail("peak_protection", e);
                self.peak(None);
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

    /// エンジンが受け付けた音づくりを読み、次の起動のために保存する。
    /// 読む前に `sound` を消さない（子が落ちていたら、読み直しで前の設定を送り直すのに使う）。
    pub(super) fn reread_and_save_sound(&mut self) {
        self.read_sound();
        if let Some(sound) = self.sound {
            self.save_sound(sound);
        }
    }

    /// `before` が `None`（起動時の読み直しなど）なら、両方の区画を送る。歌向け・分からない種類など、この画面で変えない種類は送らない。
    pub(super) fn apply_sound(&mut self, next: Sound, before: Option<Sound>) {
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
                self.fail("set_noise_control_config", e);
            }
        }
        if next.effects_editable() && before.is_none_or(|before| next.effects_differ(&before)) {
            let preset = next.preset.map(|p| p.key().to_owned());
            if let Err(e) = self
                .host
                .set_built_in_effects(next.effects_on, preset, next.amount)
            {
                self.fail("set_built_in_effects", e);
            }
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
    })
}

/// 形の違う保存は `None`（読めないと知らせ、上書きは次に変えたときだけ）。
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
        }
        .normalized(),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_survives_the_save_file() {
        let sound = Sound {
            noise_on: true,
            noise_mode: Some(NoiseMode::High),
            strength: 0.8,
            voice_guard: false,
            effects_on: true,
            preset: Some(Preset::Warm),
            amount: 0.5,
        };
        assert_eq!(sound_from_json(&sound_to_json(sound)), Some(sound));
        assert_eq!(sound_from_json(&serde_json::json!({"noiseOn": true})), None);
    }
}

//! 中核の出来事（Tauri の emit と同じ名前・本文）を、メーターの値と画面への通知にする。

use super::*;

pub(super) fn on_event(
    event: &str,
    payload: serde_json::Value,
    levels: &Mutex<LevelSlot>,
    notices: &flume::Sender<Notice>,
) {
    let notice = match event {
        "audio-level" => {
            let pair = |key: &str| -> Option<[f32; 2]> {
                let values = payload.get(key)?.as_array()?;
                match values.as_slice() {
                    [l, r] => Some([l.as_f64()? as f32, r.as_f64()? as f32]),
                    _ => None,
                }
            };
            // 形が違う値は NaN にして、画面で「更新が止まった」として扱わせる。
            let input = pair("input").unwrap_or([f32::NAN; 2]);
            let output = pair("output").unwrap_or([f32::NAN; 2]);
            let processed = payload
                .get("processed")
                .filter(|value| !value.is_null())
                .map(|_| pair("processed").unwrap_or([f32::NAN; 2]));
            let mut slot = levels.lock().unwrap_or_else(|e| e.into_inner());
            slot.seq += 1;
            slot.input = input;
            slot.output = output;
            slot.processed = processed;
            slot.received_at = Some(Instant::now());
            return;
        }
        "audio-stopped" => Notice::Stopped,
        "audio-error" | "audio-stream-error" => Notice::StreamError(
            payload
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| payload.to_string()),
        ),
        "voice-check-state" => {
            let ms = |key: &str| payload.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            Notice::Recording(Recording {
                state: VoiceState::parse(
                    payload.get("state").and_then(|v| v.as_str()).unwrap_or(""),
                ),
                position_ms: ms("position_ms"),
                duration_ms: ms("duration_ms"),
            })
        }
        "global-mute-changed" => Notice::Muted(payload.as_bool().unwrap_or(true)),
        "global-bypass-changed" => Notice::Bypassed(payload.as_bool().unwrap_or(false)),
        _ => return,
    };
    let _ = notices.send(notice);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_event_updates_slot_without_notice() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, rx) = flume::unbounded();
        on_event(
            "audio-level",
            serde_json::json!({"input": [0.25, 0.5], "output": [0.75, 1.0], "stream_generation": "1:3"}),
            &levels,
            &tx,
        );
        let slot = *levels.lock().unwrap();
        assert_eq!(slot.seq, 1);
        assert_eq!(slot.input, [0.25, 0.5]);
        assert_eq!(slot.output, [0.75, 1.0]);
        assert_eq!(slot.processed, None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn level_event_reads_processed_beside_input_and_output() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, _rx) = flume::unbounded();
        on_event(
            "audio-level",
            serde_json::json!({"input": [0.25, 0.5], "output": [0.0, 0.0], "processed": [0.5, 0.4],
                "reduction_db": {"noise": -12.0}, "speech": true}),
            &levels,
            &tx,
        );
        assert_eq!(levels.lock().unwrap().processed, Some([0.5, 0.4]));

        on_event(
            "audio-level",
            serde_json::json!({"input": [0.1, 0.1], "output": [0.1, 0.1], "processed": "x"}),
            &levels,
            &tx,
        );
        assert!(levels.lock().unwrap().processed.unwrap()[0].is_nan());
    }

    #[test]
    fn malformed_level_becomes_nan() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, _rx) = flume::unbounded();
        on_event(
            "audio-level",
            serde_json::json!({"input": [0.1]}),
            &levels,
            &tx,
        );
        assert!(levels.lock().unwrap().input[0].is_nan());
    }

    #[test]
    fn mute_and_stop_events_become_notices() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, rx) = flume::unbounded();
        on_event("global-mute-changed", serde_json::json!(true), &levels, &tx);
        on_event("audio-stopped", serde_json::json!({}), &levels, &tx);
        on_event(
            "audio-conditions-changed",
            serde_json::json!(null),
            &levels,
            &tx,
        );
        assert!(matches!(rx.try_recv(), Ok(Notice::Muted(true))));
        assert!(matches!(rx.try_recv(), Ok(Notice::Stopped)));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn voice_check_state_becomes_a_recording() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, rx) = flume::unbounded();
        on_event(
            "voice-check-state",
            serde_json::json!({"state": "ready", "position_ms": 0, "duration_ms": 4200}),
            &levels,
            &tx,
        );
        let Ok(Notice::Recording(recording)) = rx.try_recv() else {
            panic!("録音の状態が届かない");
        };
        assert_eq!(recording.state, VoiceState::Ready);
        assert_eq!(recording.duration_ms, 4200);
    }
}

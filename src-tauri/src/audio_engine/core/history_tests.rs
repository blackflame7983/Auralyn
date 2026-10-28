//! 履歴を録音やストリームの寿命と分ける回帰検査。実機streamは起動しない。
use super::*;

#[test]
fn gain_history_reports_original_invalidation_cause_and_fresh_engine_is_not_created() {
    use crate::audio_engine::history::Reason;
    let mut fresh = Engine::new();
    assert_eq!(
        fresh
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_reason,
        Some(Reason::NotCreated)
    );
    let mut engine = engine_with_history();
    assert_eq!(
        engine
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_reason,
        None
    );
    engine.request_output_gain(0.8).unwrap(); // 同じ値でも手動編集は別操作。
    assert_eq!(
        engine
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_reason,
        Some(Reason::SettingsChanged)
    );
    engine.clear_audio_resources();
    assert_eq!(
        engine
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_reason,
        Some(Reason::SettingsChanged)
    );
    let mut stopped = engine_with_history();
    stopped.clear_audio_resources();
    assert_eq!(
        stopped
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_reason,
        Some(Reason::StreamChanged)
    );
    let mut failed = engine_with_history();
    failed.stream_failed.store(true, Ordering::Release);
    failed.clear_audio_resources();
    assert_eq!(
        failed
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_reason,
        Some(Reason::StreamFailed)
    );
}

fn engine_with_history() -> Engine {
    let mut engine = Engine::new();
    engine.gain_revision = 41;
    engine.output_gain_revision = 41;
    engine.output_gain = 0.8;
    engine.output_gain_initialized = true;
    engine.gain_history = Some(auto_gain::History {
        id: 7,
        revision: 41,
        before: 0.6,
        after: 0.8,
        applied: true,
    });
    engine
        .gain_shared
        .applied_revision
        .store(41, Ordering::Release);
    engine
        .gain_shared
        .confirmed_gain
        .store(0.8_f32.to_bits(), Ordering::Release);
    engine.gain_shared.settled.store(true, Ordering::Release);
    engine
}

#[test]
fn cancel_drops_recording_but_keeps_latest_gain_history() {
    let mut engine = engine_with_history();
    engine.gain_shared.requested.store(9, Ordering::Release);
    engine.gain_shared.active.store(9, Ordering::Release);
    engine.gain_session = Some(GainSession {
        id: 9,
        revision: 41,
        phase: "recording".into(),
        target: -20.0,
        before: 0.8,
        rate: 48_000,
        samples: vec![[0.1, 0.1]; 16],
        proposal: None,
        error: None,
        started: Instant::now(),
    });

    let state = engine
        .auto_gain_command(auto_gain::Request::Cancel)
        .unwrap();
    assert!(engine.gain_session.is_none());
    assert_eq!(engine.gain_shared.requested.load(Ordering::Acquire), 0);
    assert_eq!(engine.gain_shared.active.load(Ordering::Acquire), 0);
    let history = engine.gain_history.as_ref().expect("設定履歴を保持");
    assert_eq!((history.id, history.revision), (7, 41));
    assert_eq!((history.before, history.after), (0.6, 0.8));
    assert!(history.applied);
    assert_eq!(state.history_id, Some(7));
    assert_eq!(engine.output_gain, 0.8);
    // 実ストリームなしでは履歴は保持しつつ実行可能とは表示しない。
    assert!(!state.undo_available && !state.redo_available);
}

#[test]
fn manual_gain_changes_invalidate_history_even_if_values_return_to_original() {
    let mut engine = engine_with_history();
    engine.request_output_gain(0.6).unwrap();
    engine.request_output_gain(0.8).unwrap();
    assert_eq!(engine.output_gain, 0.8);
    assert!(engine.gain_history.is_none());
    assert!(engine.gain_revision > 41);
    let revision = engine.gain_revision;
    let epoch = engine.builtin.snapshot(false).epoch;
    let rejected = engine.auto_gain_command(auto_gain::Request::UndoHistory {
        id: 7,
        revision,
        epoch,
    });
    assert!(rejected.is_err());
    assert_eq!(engine.output_gain, 0.8);
    assert_eq!(engine.gain_revision, revision);
}

#[test]
fn rejected_begin_preserves_original_history_and_gain() {
    let mut engine = engine_with_history();
    // 目標不正と停止中・反映未確認の両方で、検証前に原本を消費しない。
    for target in [-99.0, -20.0] {
        assert!(engine
            .auto_gain_command(auto_gain::Request::Begin {
                target,
                revision: 41,
            })
            .is_err());
        let history = engine.gain_history.as_ref().expect("開始失敗後の原本");
        assert_eq!(
            (history.id, history.revision, history.applied),
            (7, 41, true)
        );
        assert_eq!((history.before, history.after), (0.6, 0.8));
        assert_eq!(engine.output_gain, 0.8);
        assert_eq!(engine.gain_revision, 41);
    }
}

#[test]
fn unconfirmed_redo_is_not_available_or_applied_while_stream_is_stopped() {
    let mut engine = engine_with_history();
    engine.output_gain = 0.6;
    engine.gain_history.as_mut().unwrap().applied = false;
    engine.gain_shared.settled.store(false, Ordering::Release);
    let status = engine
        .auto_gain_command(auto_gain::Request::Status)
        .unwrap();
    assert_eq!(status.history_id, Some(7));
    assert!(!status.undo_available && !status.redo_available);
    let epoch = status.history_epoch.unwrap();
    assert!(engine
        .auto_gain_command(auto_gain::Request::RedoHistory {
            id: 7,
            revision: 41,
            epoch,
        })
        .is_err());
    assert_eq!(engine.output_gain, 0.6);
    assert_eq!(engine.gain_revision, 41);
    assert!(!engine.gain_history.as_ref().unwrap().applied);
    assert!(engine.pending_audio_msgs.is_empty());
}

#[test]
fn gain_history_rejects_old_engine_even_when_id_and_revision_repeat() {
    let mut old_engine = engine_with_history();
    let old = old_engine
        .auto_gain_command(auto_gain::Request::Status)
        .unwrap();
    let mut restarted = engine_with_history();
    assert_eq!(
        old.history_id,
        restarted
            .auto_gain_command(auto_gain::Request::Status)
            .unwrap()
            .history_id
    );
    assert_eq!(old.revision, restarted.gain_revision);
    for redo in [false, true] {
        let request = if redo {
            auto_gain::Request::RedoHistory {
                id: 7,
                revision: 41,
                epoch: old.history_epoch.clone().unwrap(),
            }
        } else {
            auto_gain::Request::UndoHistory {
                id: 7,
                revision: 41,
                epoch: old.history_epoch.clone().unwrap(),
            }
        };
        let error = restarted.auto_gain_command(request).unwrap_err();
        assert!(error.to_string().contains("世代"));
        assert_eq!(restarted.output_gain, 0.8);
        assert!(restarted.gain_history.as_ref().unwrap().applied);
    }
}

#[test]
fn noise_pending_waits_for_audio_thread_ack_even_when_queue_is_empty() {
    let mut engine = Engine::new();
    assert!(!engine.voice_preview_context().noise_pending);
    engine.noise_command_revision = 5;
    engine.noise_applied_revision.store(4, Ordering::Release);
    assert!(engine.pending_audio_msgs.is_empty());
    assert!(engine.command_tx.is_none());
    assert!(engine.voice_preview_context().noise_pending);
    engine.noise_applied_revision.store(5, Ordering::Release);
    assert!(!engine.voice_preview_context().noise_pending);
}

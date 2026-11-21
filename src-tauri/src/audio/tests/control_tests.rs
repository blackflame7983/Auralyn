//! `AudioControl`（入口）と`Admission`（受付の記録）の試験。K11：記録は勝敗にも並べ替えにも使われない。
use super::control::{AudioControl, Entry, EntryKind, Phase};
use super::*;

fn control() -> AudioControl {
    AudioControl::new(AudioHost::new(
        std::env::temp_dir().join("auralyn-control-unit"),
    ))
}

fn summary(control: &AudioControl) -> Vec<(u64, &'static str, Phase)> {
    control
        .admission()
        .records()
        .iter()
        .map(|record| (record.seq, record.entry.name, record.phase))
        .collect()
}

#[test]
fn lock_records_the_acceptance_then_the_grant_with_the_entry_name() {
    let control = control();
    drop(control.lock(Entry::command("a")).unwrap());
    drop(
        control
            .lock(Entry::new(EntryKind::Tray, "mute_toggle"))
            .unwrap(),
    );
    assert_eq!(
        summary(&control),
        [
            (1, "a", Phase::Accepted),
            (1, "a", Phase::LockGranted),
            (2, "mute_toggle", Phase::Accepted),
            (2, "mute_toggle", Phase::LockGranted),
        ]
    );
    assert_eq!(control.admission().accepted_of(EntryKind::Tray), 1);
}

// K11：受付の記録は A→B だが、実際にロックを取る順は B→A。結果はロックを取った順で決まる。
#[test]
fn k11_the_result_follows_the_lock_order_not_the_recorded_acceptance_order() {
    let control = control();
    let a = control.admit(Entry::command("A"));
    let b = control.admit(Entry::command("B"));
    assert!(a.seq() < b.seq());
    b.lock().unwrap().is_global_muted = true;
    a.lock().unwrap().is_global_muted = false;
    assert!(
        !control
            .lock(Entry::command("read"))
            .unwrap()
            .is_global_muted,
        "A が先に受け付けられていても、後からロックを取った A の書き込みが残る"
    );
    let log = summary(&control);
    let accepted: Vec<_> = log
        .iter()
        .filter(|(_, _, phase)| *phase == Phase::Accepted)
        .map(|(_, name, _)| *name)
        .collect();
    let granted: Vec<_> = log
        .iter()
        .filter(|(_, _, phase)| *phase == Phase::LockGranted)
        .map(|(_, name, _)| *name)
        .collect();
    assert_eq!(&accepted[..2], ["A", "B"], "記録は A→B のまま");
    assert_eq!(&granted[..2], ["B", "A"], "ロックを取った順は B→A");
}

// 採番と記録の追加が別区間だと、A が番号 1 を得て中断した間に B（番号 2）が先に記録され、記録の順が番号と逆になる。
#[test]
fn the_record_order_matches_the_acceptance_numbers_when_a_thread_is_interrupted_after_numbering() {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let control = control();
    let (a_numbered_tx, a_numbered_rx) = mpsc::channel::<()>();
    let (b_done_tx, b_done_rx) = mpsc::channel::<()>();
    let a_numbered_tx = Mutex::new(a_numbered_tx);
    let b_done_rx = Mutex::new(b_done_rx);
    control.admission().set_after_seq_hook(Arc::new(move |seq| {
        if seq != 1 {
            return;
        }
        a_numbered_tx.lock().unwrap().send(()).unwrap();
        // 修正前は B がすぐ終わって通知が届く。修正後は B が記録のロックで待つため、時間切れで進む。
        let _ = b_done_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_millis(300));
    }));
    let a_control = control.clone();
    let a = std::thread::spawn(move || a_control.admit(Entry::command("A")).seq());
    a_numbered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let b_control = control.clone();
    let b = std::thread::spawn(move || {
        let seq = b_control.admit(Entry::command("B")).seq();
        b_done_tx.send(()).unwrap();
        seq
    });
    assert_eq!(a.join().unwrap(), 1);
    assert_eq!(b.join().unwrap(), 2);
    let seqs: Vec<u64> = control
        .admission()
        .records()
        .iter()
        .map(|record| record.seq)
        .collect();
    assert_eq!(seqs, [1, 2], "記録は受付番号の順に並ぶ");
}

#[test]
fn note_records_without_taking_the_lock() {
    let control = control();
    let held = control.lock(Entry::command("holder")).unwrap();
    control.note(Entry::new(EntryKind::Quit, "quit_app"));
    drop(held);
    assert_eq!(control.admission().accepted_of(EntryKind::Quit), 1);
    assert!(summary(&control).contains(&(2, "quit_app", Phase::Accepted)));
}

#[test]
fn the_log_is_bounded() {
    let control = control();
    for _ in 0..400 {
        drop(control.lock(Entry::command("x")).unwrap());
    }
    assert_eq!(control.admission().records().len(), 256);
    assert_eq!(control.admission().accepted(), 400);
}

#[test]
fn the_scheduler_goes_through_the_entry_and_stops_when_the_state_is_dropped() {
    let control = control();
    control.start_mode_vst_scheduler();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while control.admission().accepted_of(EntryKind::Scheduler) < 2 {
        assert!(std::time::Instant::now() < deadline, "scheduler never ran");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        control
            .admission()
            .records()
            .iter()
            .all(|record| record.entry.kind != EntryKind::Scheduler),
        "10ms ごとの更新で、直近の操作の記録を押し出さない"
    );
    let weak = control.downgrade();
    drop(control);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while weak.upgrade().is_some() {
        assert!(
            std::time::Instant::now() < deadline,
            "scheduler kept the host alive"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn the_post_mix_child_host_is_built_only_through_the_control_module() {
    let child = control::post_mix_child_host(std::env::temp_dir().join("auralyn-post-child-unit"));
    assert!(child.post_role);
}

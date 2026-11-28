//! 制御スレッドのイベント形状・配送確認。実winitの遅延測定ではない。
use super::*;
use std::sync::mpsc;

// 同じ現在のCommand型でBox候補を測り、追加確保との交換を比較する。
#[derive(Debug)]
enum BoxedUserEvent {
    Command(Box<Command>),
    Shutdown,
    Timer,
}

#[test]
fn boxed_command_reduces_timer_and_shutdown_event_storage() {
    let old = std::mem::size_of::<UserEvent>();
    let new = std::mem::size_of::<BoxedUserEvent>();
    assert!(new < old, "旧={old}, 新={new}");
    assert!(new <= 2 * std::mem::size_of::<usize>(), "新={new}");
    eprintln!("BoxedUserEvent bytes: 旧={old}, 新={new}");
}

#[test]
fn boxed_control_events_preserve_order_and_command_payload() {
    let commands = [
        Command::SetInputChannels { left: 6, right: 7 },
        Command::SetInputGain { value: 0.25 },
        Command::SetChannelScan { active: true },
    ];
    let (old_tx, old_rx) = mpsc::channel();
    let (new_tx, new_rx) = mpsc::channel();
    old_tx.send(UserEvent::Timer).unwrap();
    new_tx.send(BoxedUserEvent::Timer).unwrap();
    for command in commands {
        old_tx.send(UserEvent::Command(command.clone())).unwrap();
        // stdin読取スレッドと同じ場所でBox化し、dispatch時に所有値を取り出す。
        new_tx
            .send(BoxedUserEvent::Command(Box::new(command)))
            .unwrap();
    }
    old_tx.send(UserEvent::Shutdown).unwrap();
    new_tx.send(BoxedUserEvent::Shutdown).unwrap();
    drop(old_tx);
    drop(new_tx);
    let mut delivered = 0;
    for (old, new) in old_rx.into_iter().zip(new_rx) {
        delivered += 1;
        match (old, new) {
            (UserEvent::Timer, BoxedUserEvent::Timer)
            | (UserEvent::Shutdown, BoxedUserEvent::Shutdown) => {}
            (UserEvent::Command(old), BoxedUserEvent::Command(new)) => {
                let dispatched = *new;
                assert_eq!(
                    serde_json::to_value(old).unwrap(),
                    serde_json::to_value(dispatched).unwrap()
                );
            }
            _ => panic!("イベント種別または配送順が変わった"),
        }
    }
    assert_eq!(delivered, 5);
}

#[test]
fn boxed_control_command_adds_one_non_rt_allocation() {
    use crate::dsp_verification_allocator::allocation_counts;
    let command = Command::SetInputGain { value: 0.25 };
    let old = allocation_counts(|| {
        let event = std::hint::black_box(UserEvent::Command(command.clone()));
        std::hint::black_box(event);
    });
    let new = allocation_counts(|| {
        let event = std::hint::black_box(BoxedUserEvent::Command(Box::new(command.clone())));
        std::hint::black_box(event);
    });
    assert_eq!(old, (0, 0));
    assert_eq!(new, (1, 1));
}

#[test]
#[ignore = "非RT制御イベント配送の手動比較"]
fn measure_control_event_delivery() {
    use std::{collections::VecDeque, hint::black_box, time::Instant};
    let command = Command::SetInputGain { value: 0.25 };
    let iterations = 50_000;
    let mut old_queue = VecDeque::with_capacity(iterations * 2 + 1);
    let mut new_queue = VecDeque::with_capacity(iterations * 2 + 1);
    let begin = Instant::now();
    for _ in 0..iterations {
        old_queue.push_back(UserEvent::Timer);
        old_queue.push_back(UserEvent::Command(command.clone()));
    }
    old_queue.push_back(UserEvent::Shutdown);
    while let Some(event) = old_queue.pop_front() {
        black_box(event);
    }
    let old = begin.elapsed();
    let begin = Instant::now();
    for _ in 0..iterations {
        new_queue.push_back(BoxedUserEvent::Timer);
        new_queue.push_back(BoxedUserEvent::Command(Box::new(command.clone())));
    }
    new_queue.push_back(BoxedUserEvent::Shutdown);
    while let Some(event) = new_queue.pop_front() {
        black_box(event);
    }
    let new = begin.elapsed();
    eprintln!("制御イベント配送 {iterations}組+終了: 旧={old:?}, Box={new:?}");
}

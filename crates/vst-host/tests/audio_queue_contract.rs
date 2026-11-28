use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::HeapRb;
use std::thread;
use std::time::{Duration, Instant};
use vst_host_lib::audio_engine::core::AudioThreadMessage;

#[test]
fn stereo_frames_remain_aligned_across_wraparound() {
    // 入力と出力のブロック長が異なる場合も、左右の順序と未消費フレームを保つ。
    let (mut producer, mut consumer) = HeapRb::<f32>::new(8).split();
    assert_eq!(producer.push_slice(&[1.0, -1.0, 2.0, -2.0, 3.0, -3.0]), 6);
    let mut first = [0.0; 4];
    assert_eq!(consumer.pop_slice(&mut first), 4);
    assert_eq!(first, [1.0, -1.0, 2.0, -2.0]);
    assert_eq!(producer.push_slice(&[4.0, -4.0, 5.0, -5.0, 6.0, -6.0]), 6);
    assert_eq!(producer.vacant_len(), 0);
    assert_eq!(producer.try_push(7.0), Err(7.0));
    let mut remaining = [0.0; 8];
    assert_eq!(consumer.pop_slice(&mut remaining), 8);
    assert_eq!(remaining, [3.0, -3.0, 4.0, -4.0, 5.0, -5.0, 6.0, -6.0]);
    assert_eq!(consumer.occupied_len(), 0);
}

#[test]
fn audio_commands_arrive_in_order_under_backpressure() {
    // 制御スレッドと音声スレッド間で、満杯時の再試行でも欠落・重複させない。
    const COUNT: usize = 20_000;
    let (mut producer, mut consumer) = HeapRb::<AudioThreadMessage>::new(16).split();
    let deadline = Instant::now() + Duration::from_secs(10);
    let sender = thread::spawn(move || {
        for index in 0..COUNT {
            let mut message = AudioThreadMessage::SetInputGain(index as f32);
            loop {
                match producer.try_push(message) {
                    Ok(()) => break,
                    Err(returned) => message = returned,
                }
                assert!(Instant::now() < deadline, "送信がタイムアウトした");
                thread::yield_now();
            }
        }
    });
    for index in 0..COUNT {
        let message = loop {
            if let Some(message) = consumer.try_pop() {
                break message;
            }
            assert!(Instant::now() < deadline, "受信がタイムアウトした");
            thread::yield_now();
        };
        match message {
            AudioThreadMessage::SetInputGain(value) => assert_eq!(value, index as f32),
            _ => panic!("予期しない音声コマンド"),
        }
    }
    sender.join().expect("送信スレッドが失敗した");
    assert!(consumer.try_pop().is_none());
}

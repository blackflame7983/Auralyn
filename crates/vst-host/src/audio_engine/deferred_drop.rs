use ringbuf::traits::Producer;

/// 非RT側の回収キューが満杯でも、所有値を1件だけ保持する。
/// flush_toがfalseの間は呼出側で新しい所有値の受信を止めること。
pub(super) struct DeferredDrop<T> {
    pending: Option<T>,
}

impl<T> DeferredDrop<T> {
    pub(super) fn new() -> Self {
        Self { pending: None }
    }

    pub(super) fn flush_to(&mut self, queue: &mut impl Producer<Item = T>) -> bool {
        if let Some(value) = self.pending.take() {
            self.pending = queue.try_push(value).err();
        }
        self.pending.is_none()
    }

    /// 直前のflush_toがtrueの場合に限って呼ぶ。
    pub(super) fn defer(&mut self, value: T, queue: &mut impl Producer<Item = T>) {
        debug_assert!(self.pending.is_none());
        self.pending = queue.try_push(value).err();
    }
}

#[cfg(test)]
mod tests {
    use super::DeferredDrop;
    use crate::vst_host::instance::allocation_counts;
    use ringbuf::{
        traits::{Consumer, Producer, Split},
        HeapRb,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Tracked(Arc<AtomicUsize>);
    impl Drop for Tracked {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn full_queue_holds_value_and_resumes_without_rt_drop_or_allocation() {
        let drops = Arc::new(AtomicUsize::new(0));
        let (mut producer, mut consumer) = HeapRb::new(1).split();
        assert!(producer.try_push(Tracked(drops.clone())).is_ok());
        let value = Tracked(drops.clone());
        let mut deferred = DeferredDrop::new();
        assert_eq!(
            allocation_counts(|| {
                assert!(deferred.flush_to(&mut producer));
                deferred.defer(value, &mut producer);
                for _ in 0..128 {
                    assert!(!deferred.flush_to(&mut producer));
                }
            }),
            (0, 0)
        );
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(consumer.try_pop());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(
            allocation_counts(|| assert!(deferred.flush_to(&mut producer))),
            (0, 0)
        );
        drop(consumer.try_pop());
        assert_eq!(drops.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn rejected_values_are_destroyed_on_consumer_thread() {
        struct ThreadTracked {
            expected: std::thread::ThreadId,
            dropped: Arc<AtomicUsize>,
        }
        impl Drop for ThreadTracked {
            fn drop(&mut self) {
                assert_eq!(std::thread::current().id(), self.expected);
                self.dropped.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let (mut producer, mut consumer) = HeapRb::new(1).split();
        let value = ThreadTracked {
            expected: std::thread::current().id(),
            dropped: dropped.clone(),
        };
        std::thread::spawn(move || {
            let mut deferred = DeferredDrop::new();
            assert_eq!(
                allocation_counts(|| {
                    deferred.defer(value, &mut producer);
                    assert!(deferred.flush_to(&mut producer));
                }),
                (0, 0)
            );
        })
        .join()
        .unwrap();
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(consumer.try_pop());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn repeated_backpressure_preserves_every_owned_value_in_order() {
        struct Numbered {
            id: usize,
            drops: Arc<AtomicUsize>,
        }
        impl Drop for Numbered {
            fn drop(&mut self) {
                self.drops.fetch_add(1, Ordering::SeqCst);
            }
        }
        let drops = Arc::new(AtomicUsize::new(0));
        let mut incoming = (0..96)
            .map(|id| Numbered {
                id,
                drops: drops.clone(),
            })
            .collect::<Vec<_>>()
            .into_iter();
        let (mut producer, mut consumer) = HeapRb::new(2).split();
        let mut deferred = DeferredDrop::new();
        let mut received = Vec::new();
        for callback in 0..512 {
            let before = drops.load(Ordering::SeqCst);
            assert_eq!(
                allocation_counts(|| {
                    while deferred.flush_to(&mut producer) {
                        let Some(value) = incoming.next() else {
                            break;
                        };
                        deferred.defer(value, &mut producer);
                    }
                }),
                (0, 0)
            );
            assert_eq!(drops.load(Ordering::SeqCst), before);
            // 非RT側の回収が間欠的でも、RT側は保持して次のcallbackで再試行する。
            if callback % 3 == 0 {
                if let Some(value) = consumer.try_pop() {
                    received.push(value.id);
                    drop(value);
                }
            }
            if received.len() == 96 {
                break;
            }
        }
        assert_eq!(received, (0..96).collect::<Vec<_>>());
        assert_eq!(drops.load(Ordering::SeqCst), 96);
        assert!(incoming.next().is_none());
        assert!(deferred.flush_to(&mut producer));
        assert!(consumer.try_pop().is_none());
    }
}

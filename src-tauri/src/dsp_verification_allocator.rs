use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    // 他の並列テストを数えず、測定対象スレッドだけを追跡する。
    static ALLOCATIONS: Cell<Option<(usize, usize)>> = const { Cell::new(None) };
}

struct CountingAllocator;

fn record_allocation(deallocation: bool) {
    let _ = ALLOCATIONS.try_with(|counter| {
        if let Some((allocs, frees)) = counter.get() {
            counter.set(Some(if deallocation {
                (allocs, frees.saturating_add(1))
            } else {
                (allocs.saturating_add(1), frees)
            }));
        }
    });
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(false);
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(false);
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation(false);
        record_allocation(true);
        System.realloc(ptr, layout, size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        record_allocation(true);
        System.dealloc(ptr, layout);
    }
}

// テストと明示的な検証featureだけで有効。通常製品のallocatorは変更しない。
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

pub(crate) fn allocation_counts(run: impl FnOnce()) -> (usize, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ALLOCATIONS.with(|counter| counter.set(None));
        }
    }
    let _reset = Reset;
    ALLOCATIONS.with(|counter| counter.set(Some((0, 0))));
    run();
    ALLOCATIONS.with(|counter| counter.replace(None).unwrap())
}

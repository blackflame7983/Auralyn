//! このexampleのPCM変換だけをthread単位で計測する。OS内部の確保を証明するものではない。
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

thread_local! {
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static COUNTS: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
}
struct Allocator;
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;
fn record(allocated: bool) {
    if ACTIVE.try_with(Cell::get).unwrap_or(false) {
        let _ = COUNTS.try_with(|count| {
            let (alloc, free) = count.get();
            count.set((
                alloc + usize::from(allocated),
                free + usize::from(!allocated),
            ));
        });
    }
}
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(true);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(true);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(true);
        record(false);
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record(false);
        unsafe { System.dealloc(pointer, layout) }
    }
}
pub fn measure(operation: impl FnOnce()) -> (usize, usize) {
    COUNTS.with(|count| count.set((0, 0)));
    ACTIVE.with(|active| active.set(true));
    operation();
    ACTIVE.with(|active| active.set(false));
    COUNTS.with(Cell::get)
}

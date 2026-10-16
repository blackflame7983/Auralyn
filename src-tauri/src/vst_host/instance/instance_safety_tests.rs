use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, UnsafeCell};

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

// cfg(test)の子モジュール内だけで有効。製品のallocatorは変更しない。
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocation_counts(run: impl FnOnce()) -> (usize, usize) {
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

#[repr(C)]
struct MockProcessor {
    vtbl: *const IAudioProcessorVtbl,
    calls: usize,
    fail: bool,
}

unsafe extern "system" fn query(_: *mut c_void, _: *const TUID, _: *mut *mut c_void) -> i32 {
    K_NO_INTERFACE
}
unsafe extern "system" fn ref_count(_: *mut c_void) -> u32 {
    1
}
unsafe extern "system" fn arrangements(
    _: *mut c_void,
    _: *mut c_void,
    _: i32,
    _: *mut c_void,
    _: i32,
) -> i32 {
    0
}
unsafe extern "system" fn arrangement(_: *mut c_void, _: i32, _: i32, _: *mut c_void) -> i32 {
    0
}
unsafe extern "system" fn sample_size(_: *mut c_void, _: i32) -> i32 {
    0
}
unsafe extern "system" fn samples(_: *mut c_void) -> u32 {
    0
}
unsafe extern "system" fn setup(_: *mut c_void, _: *mut c_void) -> i32 {
    0
}
unsafe extern "system" fn process(this: *mut c_void, data: *mut c_void) -> i32 {
    let mock = &mut *(this as *mut MockProcessor);
    mock.calls += 1;
    if mock.fail {
        return K_RESULT_FALSE;
    }
    let data = &*(data as *const ProcessData);
    let input = &*data.inputs;
    let output = &*data.outputs;
    for channel in 0..output.num_channels as usize {
        for frame in 0..data.num_samples as usize {
            *(*output.channel_buffers32.add(channel)).add(frame) =
                *(*input.channel_buffers32.add(channel)).add(frame) * 0.5;
        }
    }
    K_RESULT_OK
}

static VTABLE: IAudioProcessorVtbl = IAudioProcessorVtbl {
    base: FUnknownVtbl {
        query_interface: query,
        add_ref: ref_count,
        release: ref_count,
    },
    set_bus_arrangements: arrangements,
    get_bus_arrangement: arrangement,
    can_process_sample_size: sample_size,
    get_latency_samples: samples,
    setup_processing: setup,
    set_processing: sample_size,
    process,
    get_tail_samples: samples,
};

struct Fixture {
    // processorのreleaseが完了してからmockを破棄する。
    processor: VstProcessor,
    mock: Box<UnsafeCell<MockProcessor>>,
}

fn fixture() -> Fixture {
    let mock = Box::new(UnsafeCell::new(MockProcessor {
        vtbl: &VTABLE,
        calls: 0,
        fail: false,
    }));
    let processor = VstProcessor {
        ptr: mock.get().cast(),
        // VSTのインストールに依存せず、DLL保持フィールドだけを構成する。
        _library: Arc::new(unsafe { PluginLibrary::load("kernel32.dll", false) }.unwrap()),
        scratch_inputs: vec![vec![0.0; 4]; 2],
        scratch_outputs: vec![vec![0.0; 4]; 2],
        input_ptrs: Vec::with_capacity(2),
        output_ptrs: Vec::with_capacity(2),
        bus_inputs: Vec::with_capacity(2),
        bus_outputs: Vec::with_capacity(2),
        active_flag: Arc::new(AtomicBool::new(true)),
        max_block_size: 4,
        _num_channels: 2,
    };
    Fixture { processor, mock }
}

impl Fixture {
    fn calls(&self) -> usize {
        // 模擬FFIと同じテストスレッド上で、呼出し完了後だけ読み取る。
        unsafe { (*self.mock.get()).calls }
    }

    fn fail(&mut self) {
        unsafe { (*self.mock.get()).fail = true };
    }
}

#[test]
fn invalid_planar_blocks_never_reach_plugin_and_available_output_is_silenced() {
    for (input, mut output, frames) in [
        (vec![vec![1.0; 3], vec![1.0; 4]], vec![vec![9.0; 5]; 2], 4),
        (vec![vec![1.0; 4]; 2], vec![vec![9.0; 4], vec![9.0; 3]], 4),
        (vec![vec![1.0; 5]; 2], vec![vec![9.0; 5]; 2], 5),
        (vec![], vec![vec![9.0; 4]; 2], 4),
        (vec![vec![1.0; 4]; 2], vec![], 4),
        (vec![vec![1.0; 4]; 2], vec![vec![9.0; 4]; 2], usize::MAX),
        (vec![vec![1.0; 4]; 2], vec![vec![9.0; 4]; 2], 0),
    ] {
        let mut test = fixture();
        test.processor.process_planar(&input, &mut output, frames);
        assert_eq!(test.calls(), 0);
        for channel in output {
            assert!(channel[..frames.min(channel.len())]
                .iter()
                .all(|s| *s == 0.0));
            assert!(channel[frames.min(channel.len())..]
                .iter()
                .all(|s| *s == 9.0));
        }
    }
}

#[test]
fn valid_planar_block_preserves_channels_and_tail_and_silences_unused_channels() {
    let mut test = fixture();
    let input = vec![vec![2.0, 4.0, 6.0, 8.0], vec![-2.0, -4.0, -6.0, -8.0]];
    let mut output = vec![vec![9.0; 5], vec![9.0; 5], vec![9.0; 2]];
    test.processor.process_planar(&input, &mut output, 4);
    assert_eq!(test.calls(), 1);
    assert_eq!(
        output,
        [
            vec![1.0, 2.0, 3.0, 4.0, 9.0],
            vec![-1.0, -2.0, -3.0, -4.0, 9.0],
            vec![0.0; 2]
        ]
    );
    assert_eq!(test.processor.input_ptrs.capacity(), 2);
    assert_eq!(test.processor.bus_outputs.capacity(), 2);
}

#[test]
fn plugin_failure_and_inactive_or_missing_processor_do_not_leave_stale_audio() {
    let mut test = fixture();
    let input = vec![vec![1.0; 4]; 2];
    let mut output = vec![vec![9.0; 5]; 2];
    test.fail();
    test.processor.process_planar(&input, &mut output, 4);
    assert_eq!(test.calls(), 1);
    assert_eq!(output, vec![vec![0.0, 0.0, 0.0, 0.0, 9.0]; 2]);
    test.processor.active_flag.store(false, Ordering::SeqCst);
    let mut short = vec![vec![9.0; 2]; 2];
    test.processor.process_planar(&input, &mut short, 4);
    assert_eq!(test.calls(), 1);
    assert_eq!(short, [vec![0.0; 2], vec![0.0; 2]]);
    test.processor.active_flag.store(true, Ordering::SeqCst);
    test.processor.ptr = std::ptr::null_mut();
    output.iter_mut().for_each(|channel| channel.fill(9.0));
    test.processor.process_planar(&input, &mut output, 4);
    assert_eq!(test.calls(), 1);
    assert_eq!(output, vec![vec![0.0, 0.0, 0.0, 0.0, 9.0]; 2]);
}

#[test]
fn editor_rectangles_reject_overflow_reversal_and_empty_sizes() {
    let valid = ViewRect {
        left: 10,
        top: 20,
        right: 320,
        bottom: 460,
    };
    assert_eq!(valid.checked_size(), Some((310, 440)));
    for rect in [
        ViewRect {
            left: 0,
            top: 0,
            right: i32::MIN,
            bottom: 100,
        },
        ViewRect {
            left: i32::MIN,
            top: 0,
            right: i32::MAX,
            bottom: 100,
        },
        ViewRect {
            left: 0,
            top: i32::MIN,
            right: 100,
            bottom: i32::MAX,
        },
        ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 100,
        },
    ] {
        assert_eq!(rect.checked_size(), None);
        let mut rect = rect;
        // extern callback内でpanicせず、無効引数を返すことも確認する。
        assert_eq!(
            unsafe { host_resize_view(std::ptr::null_mut(), std::ptr::null_mut(), &mut rect) },
            K_INVALID_ARGUMENT
        );
    }
}

#[test]
fn planar_callback_paths_do_not_allocate_or_free() {
    // 測定器が実際の確保・解放を検出することを先に確認する。
    assert_eq!(
        allocation_counts(|| drop(std::hint::black_box(vec![0_u8; 64]))),
        (1, 1)
    );
    let mut test = fixture();
    let input = vec![vec![1.0; 4]; 2];
    let short_input = vec![vec![1.0; 3]; 2];
    let mut output = vec![vec![9.0; 4]; 2];
    // 初回のポインタ配列構築も含め、準備済みバッファ以外を確保しない。
    assert_eq!(
        allocation_counts(|| {
            test.processor.process_planar(&input, &mut output, 4);
            test.processor.process_planar(&short_input, &mut output, 4);
            test.processor.process_planar(&input, &mut output, 5);
            test.processor.process_planar(&input, &mut output, 0);
            test.fail();
            test.processor.process_planar(&input, &mut output, 4);
            test.processor.active_flag.store(false, Ordering::SeqCst);
            test.processor.process_planar(&input, &mut output, 4);
            test.processor.active_flag.store(true, Ordering::SeqCst);
            test.processor.ptr = std::ptr::null_mut();
            test.processor.process_planar(&input, &mut output, 4);
        }),
        (0, 0)
    );
    assert_eq!(test.calls(), 2);
}

#[test]
fn interleaved_channel_order_short_buffers_and_rt_allocation_are_preserved() {
    for channels in [1, 2, 4] {
        for input_len in [0, channels * 4 - 1, channels * 4] {
            let mut test = fixture();
            let input: Vec<f32> = (0..input_len).map(|i| i as f32 - 3.0).collect();
            let mut output = vec![9.0; channels * 4 + 1];
            assert_eq!(
                allocation_counts(|| {
                    test.processor.process(&input, &mut output, channels, 4);
                }),
                (0, 0)
            );
            for (i, sample) in output[..channels * 4].iter().enumerate() {
                let expected = if i % channels < channels.min(2) {
                    input.get(i).copied().unwrap_or(0.0) * 0.5
                } else {
                    0.0
                };
                assert_eq!(sample.to_bits(), expected.to_bits());
            }
            assert_eq!(output[channels * 4], 9.0);
            assert_eq!(test.calls(), 1);
        }
    }
}

#[test]
fn native_window_resize_rejects_frame_overflow_and_preserves_normal_client_size() {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WS_OVERLAPPEDWINDOW,
    };
    struct Window(HWND);
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    unsafe {
        // 非表示の標準ウィンドウ。巨大なサイズを実際に適用しないことも確認する。
        let window = Window(
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Auralyn size boundary test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                100,
                100,
                None,
                None,
                None,
                None,
            )
            .unwrap(),
        );
        let hwnd = window.0 .0 as isize;
        assert!(resize_hwnd_client(hwnd, 310, 440));
        let mut client = RECT::default();
        GetClientRect(window.0, &mut client).unwrap();
        assert_eq!((client.right, client.bottom), (310, 440));
        let mut before = RECT::default();
        GetWindowRect(window.0, &mut before).unwrap();

        let mut frame = RECT {
            left: 0,
            top: 0,
            right: 100,
            bottom: 100,
        };
        AdjustWindowRectEx(&mut frame, WS_OVERLAPPEDWINDOW, false, WINDOW_EX_STYLE(0)).unwrap();
        assert!(frame.left < 0 && frame.top < 0);
        let huge_width = i32::MAX - (frame.right - 100);
        let huge_height = i32::MAX - (frame.bottom - 100);
        assert!(!resize_hwnd_client(hwnd, huge_width, 440));
        assert!(!resize_hwnd_client(hwnd, 310, huge_height));
        assert!(!resize_hwnd_client(hwnd, i32::MAX, i32::MAX));
        assert!(!resize_hwnd_client(hwnd, 0, 440));
        let mut after = RECT::default();
        GetWindowRect(window.0, &mut after).unwrap();
        assert_eq!(
            (after.left, after.top, after.right, after.bottom),
            (before.left, before.top, before.right, before.bottom)
        );
    }
}

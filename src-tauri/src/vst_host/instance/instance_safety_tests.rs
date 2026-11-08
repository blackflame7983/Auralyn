use super::*;
pub(crate) use crate::dsp_verification_allocator::allocation_counts;
use crate::vst_host::c_api::ProcessData;
use std::cell::UnsafeCell;
use windows::Win32::UI::WindowsAndMessaging::{AdjustWindowRectEx, GetWindowRect, WINDOW_EX_STYLE};

#[test]
fn malformed_plugin_paths_fail_before_loading_a_library() {
    for path in ["", ".", "..", "C:\\"] {
        assert!(VstInstance::load(path).is_err());
    }
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
        // SAFETY: OS の kernel32 を DLL 保持の試験用にロードし、VST の初期化関数は呼ばない。
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
        input_channels: 2,
        output_channels: 2,
    };
    Fixture { processor, mock }
}

impl Fixture {
    fn calls(&self) -> usize {
        // 模擬FFIと同じテストスレッド上で、呼出し完了後だけ読み取る。
        // SAFETY: mock は Fixture が所有し、同期したモック呼び出し後に同じテストスレッドから読む。
        unsafe { (*self.mock.get()).calls }
    }

    fn fail(&mut self) {
        // SAFETY: mock は Fixture が所有し、同期したモック呼び出しの間に同じテストスレッドから書く。
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
            // SAFETY: rect は有効な書き込み可能領域で、残りの null 引数はこのコールバックが参照しない。
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
fn invalid_interleaved_blocks_never_reach_plugin_or_leave_stale_audio() {
    for (channels, frames) in [(0, 4), (2, 0), (2, 5), (usize::MAX, 2), (2, usize::MAX)] {
        let mut test = fixture();
        let mut output = [9.0; 8];
        assert_eq!(
            allocation_counts(|| test.processor.process(&[], &mut output, channels, frames)),
            (0, 0)
        );
        assert_eq!(test.calls(), 0);
        assert_eq!(output, [0.0; 8]);
    }
    let mut test = fixture();
    let mut output = [9.0; 8];
    test.processor.ptr = std::ptr::null_mut();
    test.processor.process(&[], &mut output, 2, 4);
    assert_eq!(test.calls(), 0);
    assert_eq!(output, [0.0; 8]);
}

#[test]
fn huge_channel_count_is_bounded_by_available_output() {
    let mut test = fixture();
    let mut output = [9.0; 4];
    assert_eq!(
        allocation_counts(|| test
            .processor
            .process(&[2.0, 4.0], &mut output, usize::MAX, 1)),
        (0, 0)
    );
    assert_eq!(test.calls(), 1);
    assert_eq!(output, [1.0, 2.0, 0.0, 0.0]);
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
            // SAFETY: Window は作成済み HWND を所有し、同じテストスレッドの drop で一度破棄する。
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    // SAFETY: 標準 STATIC クラスと NUL 終端文字列を使用し、生成した HWND は同じスレッドの Window が破棄する。
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

/// 遅延線の1チャンネル分。テストの L はこれ以下にする。
const SCRIPT_DELAY_CAP: usize = 512;

/// テストが指定した値を出す合成 processor。mock はヒープ上に残り、processor より後で破棄する。
#[repr(C)]
struct ScriptMock {
    vtbl: *const IAudioProcessorVtbl,
    calls: u32,
    saw_non_finite: bool,
    scale: f32,
    replace: bool,
    replace_value: f32,
    /// 255 は全チャンネル。それ以外は対象チャンネルだけを置き換える。
    replace_channel: u8,
    /// `get_latency_samples` が返す申告遅延。0 のときは遅延線を通さない。
    latency: u32,
    /// 0 以外なら出力へ一極の残響尾を足す。
    decay: f32,
    state: [f32; 2],
    delay: [f32; SCRIPT_DELAY_CAP * 2],
    delay_pos: [u16; 2],
}

unsafe extern "system" fn script_process(this: *mut c_void, data: *mut c_void) -> i32 {
    let mock = &mut *(this as *mut ScriptMock);
    mock.calls = mock.calls.saturating_add(1);
    let data = &*(data as *const ProcessData);
    if data.inputs.is_null() || data.outputs.is_null() {
        return K_RESULT_FALSE;
    }
    let input = &*data.inputs;
    let output = &*data.outputs;
    let channels = output.num_channels.max(0) as usize;
    let frames = data.num_samples.max(0) as usize;
    for channel in 0..channels {
        let in_ptr = *input.channel_buffers32.add(channel);
        let out_ptr = *output.channel_buffers32.add(channel);
        if in_ptr.is_null() || out_ptr.is_null() {
            return K_RESULT_FALSE;
        }
        for frame in 0..frames {
            let sample = *in_ptr.add(frame);
            if !sample.is_finite() {
                mock.saw_non_finite = true;
            }
            let mut written = sample * mock.scale;
            if mock.replace
                && (mock.replace_channel == 255 || mock.replace_channel == channel as u8)
            {
                written = mock.replace_value;
            }
            if channel < 2 {
                let latency = (mock.latency as usize).min(SCRIPT_DELAY_CAP);
                if latency > 0 {
                    let pos = mock.delay_pos[channel] as usize;
                    let base = channel * SCRIPT_DELAY_CAP;
                    let read = (pos + SCRIPT_DELAY_CAP - latency) % SCRIPT_DELAY_CAP;
                    let delayed = mock.delay[base + read];
                    mock.delay[base + pos] = written;
                    mock.delay_pos[channel] = ((pos + 1) % SCRIPT_DELAY_CAP) as u16;
                    written = delayed;
                }
                if mock.decay != 0.0 {
                    let next = mock.state[channel] * mock.decay + written;
                    mock.state[channel] = next;
                    written = next;
                }
            }
            *out_ptr.add(frame) = written;
        }
    }
    K_RESULT_OK
}

unsafe extern "system" fn script_latency(this: *mut c_void) -> u32 {
    let mock = &*(this as *const ScriptMock);
    mock.latency
}

static SCRIPT_VTABLE: IAudioProcessorVtbl = IAudioProcessorVtbl {
    base: FUnknownVtbl {
        query_interface: query,
        add_ref: ref_count,
        release: ref_count,
    },
    set_bus_arrangements: arrangements,
    get_bus_arrangement: arrangement,
    can_process_sample_size: sample_size,
    get_latency_samples: script_latency,
    setup_processing: setup,
    set_processing: sample_size,
    process: script_process,
    get_tail_samples: samples,
};

pub(crate) struct ScriptedVst {
    mock: Box<UnsafeCell<ScriptMock>>,
    processor: Option<VstProcessor>,
}

impl ScriptedVst {
    pub(crate) fn scale(scale: f32) -> Self {
        Self::create(scale, false, 0.0, 255)
    }

    pub(crate) fn non_finite(value: f32, channel: Option<usize>) -> Self {
        Self::create(1.0, true, value, channel.map(|ch| ch as u8).unwrap_or(255))
    }

    /// 全チャンネルを定数で置き換える。
    pub(crate) fn constant(value: f32) -> Self {
        Self::create(1.0, true, value, 255)
    }

    /// L サンプル遅らせ、`get_latency_samples` で L を申告する。
    pub(crate) fn delay(latency: u32) -> Self {
        let vst = Self::create(1.0, false, 0.0, 255);
        // SAFETY: mock は ScriptedVst が所有し、process 前の同じテストスレッドから書く。
        unsafe { (*vst.mock.get()).latency = latency.min(SCRIPT_DELAY_CAP as u32) };
        vst
    }

    /// 入力へ減衰する内部状態を足す。decay は 1 未満を想定する。
    pub(crate) fn tail(decay: f32) -> Self {
        let vst = Self::create(1.0, false, 0.0, 255);
        // SAFETY: mock は ScriptedVst が所有し、process 前の同じテストスレッドから書く。
        unsafe { (*vst.mock.get()).decay = decay };
        vst
    }

    fn create(scale: f32, replace: bool, replace_value: f32, replace_channel: u8) -> Self {
        let mock = Box::new(UnsafeCell::new(ScriptMock {
            vtbl: &SCRIPT_VTABLE,
            calls: 0,
            saw_non_finite: false,
            scale,
            replace,
            replace_value,
            replace_channel,
            latency: 0,
            decay: 0.0,
            state: [0.0; 2],
            delay: [0.0; SCRIPT_DELAY_CAP * 2],
            delay_pos: [0; 2],
        }));
        let max_block = 4_096;
        let processor = VstProcessor {
            ptr: mock.get().cast(),
            // SAFETY: kernel32 を DLL 保持の試験用にロードし、VST の初期化関数は呼ばない。
            _library: Arc::new(unsafe { PluginLibrary::load("kernel32.dll", false) }.unwrap()),
            scratch_inputs: vec![vec![0.0; max_block]; 2],
            scratch_outputs: vec![vec![0.0; max_block]; 2],
            input_ptrs: Vec::with_capacity(4),
            output_ptrs: Vec::with_capacity(4),
            bus_inputs: Vec::with_capacity(4),
            bus_outputs: Vec::with_capacity(4),
            active_flag: Arc::new(AtomicBool::new(true)),
            max_block_size: max_block,
            _num_channels: 2,
            input_channels: 2,
            output_channels: 2,
        };
        Self {
            mock,
            processor: Some(processor),
        }
    }

    pub(crate) fn take(&mut self) -> VstProcessor {
        self.processor.take().expect("synthetic processor")
    }

    pub(crate) fn calls(&self) -> u32 {
        // SAFETY: mock は ScriptedVst が所有し、process が戻ったあと同じテストスレッドから読む。
        unsafe { (*self.mock.get()).calls }
    }

    pub(crate) fn saw_non_finite(&self) -> bool {
        // SAFETY: mock は ScriptedVst が所有し、process が戻ったあと同じテストスレッドから読む。
        unsafe { (*self.mock.get()).saw_non_finite }
    }

    /// vtable の `get_latency_samples` が返す申告値。
    pub(crate) fn declared_latency(&self) -> u32 {
        // SAFETY: mock は ScriptedVst が所有し、process の外から同じテストスレッドで vtable を呼ぶ。
        unsafe {
            let mock = &*self.mock.get();
            let vtbl = &*mock.vtbl;
            (vtbl.get_latency_samples)(self.mock.get().cast())
        }
    }
}

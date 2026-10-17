mod common;
use common::{Current, Dsp, FRAME_SIZE, KINDS, Registry};
use serde::{Deserialize, Serialize};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
    process::Command,
};

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
struct Usage {
    live_bytes: i64,
    peak_bytes: i64,
}

thread_local! { static USAGE: Cell<Option<Usage>> = const { Cell::new(None) }; }
struct RequestedHeap;

fn record(delta: i64) {
    let _ = USAGE.try_with(|cell| {
        if let Some(mut usage) = cell.get() {
            usage.live_bytes = usage.live_bytes.saturating_add(delta);
            usage.peak_bytes = usage.peak_bytes.max(usage.live_bytes);
            cell.set(Some(usage));
        }
    });
}

// 時間測定バイナリにはこのallocatorを含めない。Layout要求サイズの生存量だけを測る。
unsafe impl GlobalAlloc for RequestedHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            record(layout.size() as i64);
        }
        ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() {
            record(layout.size() as i64);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        record(-(layout.size() as i64));
        System.dealloc(ptr, layout);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(ptr, layout, size);
        if !next.is_null() {
            record(size as i64 - layout.size() as i64);
        }
        next
    }
}

#[global_allocator]
static ALLOCATOR: RequestedHeap = RequestedHeap;

fn snapshot() -> Usage {
    let result = USAGE.with(|cell| cell.get().unwrap());
    assert!(
        result.live_bytes >= 0,
        "計測外の領域を誤って解放集計していないこと"
    );
    result
}

fn begin_phase() {
    USAGE.with(|cell| {
        let mut usage = cell.get().unwrap();
        usage.peak_bytes = usage.live_bytes;
        cell.set(Some(usage));
    });
}

#[derive(Serialize, Deserialize)]
struct Row {
    implementation: String,
    states: usize,
    state_layout_bytes: usize,
    after_new: Usage,
    after_first: Usage,
    after_steady: Usage,
    after_reset: Usage,
    after_drop: Usage,
    reset_output_hashes: Vec<u64>,
}

fn measure<C: Dsp>(implementation: String, count: usize) -> Row {
    std::thread::spawn(move || {
        // fixtureのVec本体は計測開始前に確保し、終了後に破棄する。
        let mut states = Vec::with_capacity(count);
        let mut reset_output_hashes = Vec::with_capacity(count);
        let input = common::input(3, 0);
        let mut output = [0.0; FRAME_SIZE];
        USAGE.with(|cell| cell.set(Some(Usage::default())));
        for _ in 0..count {
            states.push(C::new());
        }
        let after_new = snapshot();
        begin_phase();
        for state in &mut states {
            black_box(state.process(&mut output, &input));
        }
        let after_first = snapshot();
        begin_phase();
        for frame in 1..65 {
            let input = common::input(3, frame);
            for state in &mut states {
                black_box(state.process(&mut output, &input));
            }
        }
        let after_steady = snapshot();
        begin_phase();
        for state in &mut states {
            state.reset();
        }
        let after_reset = snapshot();
        for state in &mut states {
            reset_output_hashes.push(common::hash(state.process(&mut output, &input), &output));
        }
        states.clear();
        let after_drop = snapshot();
        // TLSキャッシュの破棄とfixtureの解放はスコープ外。生存量はthread終了前を記録する。
        USAGE.with(|cell| cell.set(None));
        black_box(&states);
        Row {
            implementation,
            states: count,
            state_layout_bytes: C::state_size(),
            after_new,
            after_first,
            after_steady,
            after_reset,
            after_drop,
            reset_output_hashes,
        }
    })
    .join()
    .unwrap()
}

fn positive_control() {
    std::thread::spawn(|| {
        USAGE.with(|cell| cell.set(Some(Usage::default())));
        let mut bytes = black_box(vec![0_u8; 4096]);
        assert_eq!(snapshot().live_bytes, 4096);
        bytes.reserve_exact(4096);
        let grown = bytes.capacity() as i64;
        assert_eq!(snapshot().live_bytes, grown);
        bytes.truncate(16);
        bytes.shrink_to_fit();
        assert_eq!(snapshot().live_bytes, bytes.capacity() as i64);
        drop(bytes);
        assert_eq!(snapshot().live_bytes, 0);
        assert_eq!(snapshot().peak_bytes, grown);
        USAGE.with(|cell| cell.set(None));
    })
    .join()
    .unwrap();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    common::configuration()?;
    positive_control();
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--case") {
        if args.len() != 3 {
            return Err("--case <current|registry> <states>".into());
        }
        let count: usize = args[2].parse()?;
        if ![1, 2, 8].contains(&count) {
            return Err("状態数は1・2・8を指定してください".into());
        }
        let row = match args[1].as_str() {
            "current" => measure::<Current>(args[1].clone(), count),
            "registry" => measure::<Registry>(args[1].clone(), count),
            _ => return Err("実装名が不正です".into()),
        };
        println!("{}", serde_json::to_string(&row)?);
        return Ok(());
    }
    if !args.is_empty() {
        return Err("引数なしで実行してください".into());
    }
    common::validate();
    let mut rows = Vec::<Row>::new();
    for count in [1, 2, 8] {
        for implementation in ["current", "registry"] {
            let output = Command::new(std::env::current_exe()?)
                .args(["--case", implementation, &count.to_string()])
                .output()?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
            }
            rows.push(serde_json::from_slice(&output.stdout)?);
        }
        assert_eq!(
            rows[rows.len() - 1].reset_output_hashes,
            rows[rows.len() - 2].reset_output_hashes
        );
    }
    println!(
        "{}",
        serde_json::to_string(
            &serde_json::json!({"metric":"live Rust Layout request bytes; excludes allocator overhead, stack, static model and OS RSS",
        "memory_input":"noise","frames_before_reset":65,"validation_inputs":KINDS,"rows":rows})
        )?
    );
    Ok(())
}

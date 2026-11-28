// 試験用の VST3。指定した操作で落ちる、または固まる（#462 の実機確認用）。配布しない。
// 元: coupler-rs/vst3-rs の examples/gain.rs（MIT OR Apache-2.0）https://github.com/coupler-rs/vst3-rs
// 指定: %TEMP%\auralyn-crash-vst3.txt に操作名（落ちる）か hang:<操作名>（固まる）。手順は docs/TESTING.md。

use std::ffi::{c_char, c_void, CString};
use std::sync::atomic::{AtomicU8, Ordering};
use std::{ptr, slice};

use vst3::{uid, Class, ComRef, ComWrapper, Steinberg::Vst::*, Steinberg::*};

const NORMAL: u8 = 0;
const ABORT: u8 = 1;
const HANG: u8 = 2;

/// 音声エンジンの中でだけ判定する。スキャナーなど、ほかのプロセスでは常に通常動作。
fn requested(operation: &str) -> u8 {
    let in_engine = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with("audio_engine"))
        })
        .unwrap_or(false);
    if !in_engine {
        return NORMAL;
    }
    let Ok(text) = std::fs::read_to_string(std::env::temp_dir().join("auralyn-crash-vst3.txt"))
    else {
        return NORMAL;
    };
    let text = text.trim_start_matches('\u{feff}').trim();
    if text == operation {
        ABORT
    } else if text.strip_prefix("hang:") == Some(operation) {
        HANG
    } else {
        NORMAL
    }
}

fn act(mode: u8) {
    match mode {
        ABORT => std::process::abort(),
        // 眠らずに回り続け、止まった位置を VST の DLL の中にする（Host の制御停止の記録に DLL 名が出る）。
        HANG => loop {
            std::hint::spin_loop();
        },
        _ => {}
    }
}

fn trip(operation: &str) {
    act(requested(operation));
}

fn copy_cstring(src: &str, dst: &mut [c_char]) {
    let c_string = CString::new(src).unwrap_or_default();
    let bytes = c_string.as_bytes_with_nul();
    for (src, dst) in bytes.iter().zip(dst.iter_mut()) {
        *dst = *src as c_char;
    }
    if bytes.len() > dst.len() {
        if let Some(last) = dst.last_mut() {
            *last = 0;
        }
    }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut len = 0;
    for (src, dst) in src.encode_utf16().zip(dst.iter_mut()) {
        *dst = src as TChar;
        len += 1;
    }
    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

const PLUGIN_NAME: &str = "Auralyn Crash Test";
const STATE_BYTES: &[u8; 8] = b"AURALYN1";

struct CrashProcessor {
    // 音声スレッドでファイルを読まないよう、process の指定は setupProcessing で控える。
    process_mode: AtomicU8,
}

impl Class for CrashProcessor {
    type Interfaces = (IComponent, IAudioProcessor);
}

impl CrashProcessor {
    const CID: TUID = uid(0x7A1C4E52, 0x93B84D10, 0xA5E6C2F0, 0x4B18D3E7);
}

impl IPluginBaseTrait for CrashProcessor {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        trip("load");
        kResultOk
    }

    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}

impl IComponentTrait for CrashProcessor {
    unsafe fn getControllerClassId(&self, class_id: *mut TUID) -> tresult {
        // SAFETY: ホストが有効な TUID の書き込み先を渡す（VST3 の規約）。
        unsafe { *class_id = CrashController::CID };
        kResultOk
    }

    unsafe fn setIoMode(&self, _mode: IoMode) -> tresult {
        kResultOk
    }

    unsafe fn getBusCount(&self, media_type: MediaType, dir: BusDirection) -> i32 {
        if media_type == MediaTypes_::kAudio as MediaType
            && (dir == BusDirections_::kInput as BusDirection
                || dir == BusDirections_::kOutput as BusDirection)
        {
            1
        } else {
            0
        }
    }

    unsafe fn getBusInfo(
        &self,
        media_type: MediaType,
        dir: BusDirection,
        index: i32,
        bus: *mut BusInfo,
    ) -> tresult {
        if media_type != MediaTypes_::kAudio as MediaType || index != 0 {
            return kInvalidArgument;
        }
        let (direction, name) = if dir == BusDirections_::kInput as BusDirection {
            (BusDirections_::kInput, "Input")
        } else if dir == BusDirections_::kOutput as BusDirection {
            (BusDirections_::kOutput, "Output")
        } else {
            return kInvalidArgument;
        };
        // SAFETY: ホストが有効な BusInfo の書き込み先を渡す。
        let bus = unsafe { &mut *bus };
        bus.mediaType = MediaTypes_::kAudio as MediaType;
        bus.direction = direction as BusDirection;
        bus.channelCount = 2;
        copy_wstring(name, &mut bus.name);
        bus.busType = BusTypes_::kMain as BusType;
        bus.flags = BusInfo_::BusFlags_::kDefaultActive as u32;
        kResultOk
    }

    unsafe fn getRoutingInfo(
        &self,
        _in_info: *mut RoutingInfo,
        _out_info: *mut RoutingInfo,
    ) -> tresult {
        kNotImplemented
    }

    unsafe fn activateBus(
        &self,
        _media_type: MediaType,
        _dir: BusDirection,
        _index: i32,
        _state: TBool,
    ) -> tresult {
        kResultOk
    }

    unsafe fn setActive(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn setState(&self, _state: *mut IBStream) -> tresult {
        trip("set_state");
        kResultOk
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        trip("get_state");
        // 復元で setState が呼ばれるよう、空でない状態を返す。
        // SAFETY: state はホストが渡した IBStream へのポインター。null なら None になる。
        let Some(stream) = (unsafe { ComRef::from_raw(state) }) else {
            return kInvalidArgument;
        };
        let mut written = 0;
        // SAFETY: 書き込み元は有効な 8 バイト。stream はホストが渡した生きている IBStream。
        unsafe {
            stream.write(
                STATE_BYTES.as_ptr() as *mut c_void,
                STATE_BYTES.len() as i32,
                &mut written,
            )
        }
    }
}

impl IAudioProcessorTrait for CrashProcessor {
    unsafe fn setBusArrangements(
        &self,
        inputs: *mut SpeakerArrangement,
        num_ins: i32,
        outputs: *mut SpeakerArrangement,
        num_outs: i32,
    ) -> tresult {
        if num_ins != 1 || num_outs != 1 {
            return kResultFalse;
        }
        // SAFETY: 本数が 1 のとき、ホストは有効な配列を渡す。
        let stereo = unsafe { *inputs == SpeakerArr::kStereo && *outputs == SpeakerArr::kStereo };
        if stereo {
            kResultTrue
        } else {
            kResultFalse
        }
    }

    unsafe fn getBusArrangement(
        &self,
        dir: BusDirection,
        index: i32,
        arr: *mut SpeakerArrangement,
    ) -> tresult {
        if index != 0
            || (dir != BusDirections_::kInput as BusDirection
                && dir != BusDirections_::kOutput as BusDirection)
        {
            return kInvalidArgument;
        }
        // SAFETY: ホストが有効な書き込み先を渡す。
        unsafe { *arr = SpeakerArr::kStereo };
        kResultOk
    }

    unsafe fn canProcessSampleSize(&self, symbolic_sample_size: i32) -> tresult {
        if symbolic_sample_size == SymbolicSampleSizes_::kSample32 {
            kResultOk
        } else {
            kNotImplemented
        }
    }

    unsafe fn getLatencySamples(&self) -> u32 {
        0
    }

    unsafe fn setupProcessing(&self, _setup: *mut ProcessSetup) -> tresult {
        trip("processing_setup");
        self.process_mode
            .store(requested("process"), Ordering::Relaxed);
        kResultOk
    }

    unsafe fn setProcessing(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        act(self.process_mode.load(Ordering::Relaxed));
        // SAFETY: ホストが有効な ProcessData を渡す。
        let process_data = unsafe { &*data };
        if process_data.numInputs != 1 || process_data.numOutputs != 1 {
            return kResultOk;
        }
        let num_samples = process_data.numSamples as usize;
        // SAFETY: 入出力の本数は 1 と確認済みで、各チャンネルは numSamples 個の f32 を持つ。
        unsafe {
            let input = &*process_data.inputs;
            let output = &*process_data.outputs;
            if input.numChannels != 2 || output.numChannels != 2 {
                return kResultOk;
            }
            let input_channels = slice::from_raw_parts(input.__field0.channelBuffers32, 2);
            let output_channels = slice::from_raw_parts(output.__field0.channelBuffers32, 2);
            for channel in 0..2 {
                let source = slice::from_raw_parts(input_channels[channel], num_samples);
                let target = slice::from_raw_parts_mut(output_channels[channel], num_samples);
                target.copy_from_slice(source);
            }
        }
        kResultOk
    }

    unsafe fn getTailSamples(&self) -> u32 {
        0
    }
}

struct CrashController;

impl Class for CrashController {
    type Interfaces = (IEditController,);
}

impl CrashController {
    const CID: TUID = uid(0x2D95F0A8, 0x6C3E4B71, 0x8F0A1E64, 0xC7B2593D);
}

impl IPluginBaseTrait for CrashController {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
    }

    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}

impl IEditControllerTrait for CrashController {
    unsafe fn setComponentState(&self, _state: *mut IBStream) -> tresult {
        kNotImplemented
    }

    unsafe fn setState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }

    unsafe fn getState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }

    unsafe fn getParameterCount(&self) -> i32 {
        0
    }

    unsafe fn getParameterInfo(&self, _param_index: i32, _info: *mut ParameterInfo) -> tresult {
        kInvalidArgument
    }

    unsafe fn getParamStringByValue(
        &self,
        _id: u32,
        _value_normalized: f64,
        _string: *mut String128,
    ) -> tresult {
        kInvalidArgument
    }

    unsafe fn getParamValueByString(
        &self,
        _id: u32,
        _string: *mut TChar,
        _value_normalized: *mut f64,
    ) -> tresult {
        kInvalidArgument
    }

    unsafe fn normalizedParamToPlain(&self, _id: u32, _value_normalized: f64) -> f64 {
        0.0
    }

    unsafe fn plainParamToNormalized(&self, _id: u32, _plain_value: f64) -> f64 {
        0.0
    }

    unsafe fn getParamNormalized(&self, _id: u32) -> f64 {
        0.0
    }

    unsafe fn setParamNormalized(&self, _id: u32, _value: f64) -> tresult {
        kInvalidArgument
    }

    unsafe fn setComponentHandler(&self, _handler: *mut IComponentHandler) -> tresult {
        kResultOk
    }

    unsafe fn createView(&self, _name: *const c_char) -> *mut IPlugView {
        trip("open_editor");
        ptr::null_mut()
    }
}

struct Factory;

impl Class for Factory {
    type Interfaces = (IPluginFactory,);
}

impl IPluginFactoryTrait for Factory {
    unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
        // SAFETY: ホストが有効な PFactoryInfo の書き込み先を渡す。
        let info = unsafe { &mut *info };
        copy_cstring("Auralyn Test", &mut info.vendor);
        copy_cstring("", &mut info.url);
        copy_cstring("", &mut info.email);
        info.flags = PFactoryInfo_::FactoryFlags_::kUnicode as int32;
        kResultOk
    }

    unsafe fn countClasses(&self) -> i32 {
        2
    }

    unsafe fn getClassInfo(&self, index: i32, info: *mut PClassInfo) -> tresult {
        let (cid, category) = match index {
            0 => (CrashProcessor::CID, "Audio Module Class"),
            1 => (CrashController::CID, "Component Controller Class"),
            _ => return kInvalidArgument,
        };
        // SAFETY: ホストが有効な PClassInfo の書き込み先を渡す。
        let info = unsafe { &mut *info };
        info.cid = cid;
        info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
        copy_cstring(category, &mut info.category);
        copy_cstring(PLUGIN_NAME, &mut info.name);
        kResultOk
    }

    unsafe fn createInstance(
        &self,
        cid: FIDString,
        iid: FIDString,
        obj: *mut *mut c_void,
    ) -> tresult {
        // SAFETY: cid は 16 バイトの TUID を指す（VST3 の規約）。
        let cid = unsafe { *(cid as *const TUID) };
        let instance = if cid == CrashProcessor::CID {
            ComWrapper::new(CrashProcessor {
                process_mode: AtomicU8::new(NORMAL),
            })
            .to_com_ptr::<FUnknown>()
        } else if cid == CrashController::CID {
            ComWrapper::new(CrashController).to_com_ptr::<FUnknown>()
        } else {
            None
        };
        let Some(instance) = instance else {
            return kInvalidArgument;
        };
        let raw = instance.as_ptr();
        // SAFETY: raw は生きている COM オブジェクト。queryInterface が参照を増やして obj に返す。
        unsafe { ((*(*raw).vtbl).queryInterface)(raw, iid as *mut TUID, obj) }
    }
}

#[cfg(target_os = "windows")]
#[no_mangle]
extern "system" fn InitDll() -> bool {
    true
}

#[cfg(target_os = "windows")]
#[no_mangle]
extern "system" fn ExitDll() -> bool {
    true
}

#[no_mangle]
extern "system" fn GetPluginFactory() -> *mut IPluginFactory {
    match ComWrapper::new(Factory).to_com_ptr::<IPluginFactory>() {
        Some(factory) => factory.into_raw(),
        None => ptr::null_mut(),
    }
}

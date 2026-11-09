//! 音声コールバックから呼ぶVST処理。事前確保したバッファだけを使用する。
use super::{get_vtbl, VstProcessor};
use crate::vst_host::c_api::{
    AudioBusBuffers, IAudioProcessorVtbl, ProcessData, K_REALTIME, K_RESULT_OK, K_SAMPLE_32,
};
use std::ffi::c_void;
use std::sync::atomic::Ordering;

impl VstProcessor {
    /// 制御側で取得済みの値だけを返す。問い合わせ API は呼ばない。
    pub(crate) fn tail_samples(&self) -> Option<u32> {
        self.tail_samples
    }

    pub(crate) fn reset_processing(&mut self) -> bool {
        if !self.active_flag.load(Ordering::SeqCst) || self.ptr.is_null() {
            return false;
        }
        // 専用 worker の process 呼出し間だけで実行する。VST3 準拠の実装は
        // setProcessing(true) で遅延線などを初期化する。非準拠 VST は保証できない。
        // SAFETY: 非nullの有効なprocessorを専用workerが排他的に保持し、process呼出しの間だけVST3 vtableのsetProcessingを実行する。
        unsafe {
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);
            if (vtbl.set_processing)(self.ptr, 0) != K_RESULT_OK {
                return false;
            }
            (vtbl.set_processing)(self.ptr, 1) == K_RESULT_OK
        }
    }

    fn silence_planar(outputs: &mut [Vec<f32>], num_samples: usize) {
        for channel in outputs {
            let len = num_samples.min(channel.len());
            channel[..len].fill(0.0);
        }
    }

    pub fn process(
        &mut self,
        input_buffer: &[f32],
        output_buffer: &mut [f32],
        channels: usize,
        num_samples: usize,
    ) {
        let active_channels = channels
            .min(self.scratch_inputs.len())
            .min(self.scratch_outputs.len())
            .min(self.input_channels)
            .min(self.output_channels);
        let sample_count = num_samples.checked_mul(channels);
        if !self.active_flag.load(Ordering::SeqCst)
            || self.ptr.is_null()
            || num_samples == 0
            || num_samples > self.max_block_size
            || num_samples > i32::MAX as usize
            || active_channels == 0
            || sample_count.is_none()
            || self
                .scratch_inputs
                .iter()
                .take(active_channels)
                .any(|ch| ch.len() < num_samples)
            || self
                .scratch_outputs
                .iter()
                .take(active_channels)
                .any(|ch| ch.len() < num_samples)
        {
            output_buffer.fill(0.0);
            return;
        }
        // SAFETY: create_processor が add_ref した processor と DLL を保持する。フレーム数と作業バッファ長を上で検証し、呼び出し中は各バッファが生存する。
        unsafe {
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);

            // 2. 入力データのデインターリーブ (De-interleave)
            for ch in 0..active_channels {
                // Bounds check is implicit by using min() above, but we double check for safety
                if ch < self.scratch_inputs.len() {
                    let scratch_slice = &mut self.scratch_inputs[ch][..num_samples];
                    for (i, sample) in scratch_slice.iter_mut().enumerate() {
                        // Input buffer bounds check
                        let input_idx = i * channels + ch;
                        let val = if input_idx < input_buffer.len() {
                            input_buffer[input_idx]
                        } else {
                            0.0
                        };
                        *sample = val;
                    }
                }
            }

            // 2.5 Clear Output Buffers
            for ch in 0..active_channels {
                if ch < self.scratch_outputs.len() && num_samples <= self.scratch_outputs[ch].len()
                {
                    self.scratch_outputs[ch][..num_samples].fill(0.0);
                }
            }

            // 3. ポインタ配列の準備 (Prepare Pointers)
            self.input_ptrs.clear();
            self.output_ptrs.clear();

            // Only push pointers for active channels
            for ch in 0..active_channels {
                self.input_ptrs.push(self.scratch_inputs[ch].as_mut_ptr());
                self.output_ptrs.push(self.scratch_outputs[ch].as_mut_ptr());
            }

            // AudioBusBuffers の構築
            self.bus_inputs.clear();
            self.bus_outputs.clear();

            // Bus 0: メイン (Main) - Tell plugin the actual processed count
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: active_channels as i32,
                silence_flags: 0, // TODO: calculate silence
                channel_buffers32: self.input_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: active_channels as i32,
                silence_flags: 0,
                channel_buffers32: self.output_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });

            // Bus 1: ダミー (Dummy)
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                num_samples: num_samples as i32,
                num_inputs: 1, // Only main bus
                num_outputs: 1,
                inputs: self.bus_inputs.as_mut_ptr(),
                outputs: self.bus_outputs.as_mut_ptr(),
                input_events: std::ptr::null_mut(),
                output_events: std::ptr::null_mut(),
                input_param_changes: std::ptr::null_mut(),
                output_param_changes: std::ptr::null_mut(),
                process_context: std::ptr::null_mut(),
            };

            // 4. プラグイン処理実行
            let res = (vtbl.process)(self.ptr, &mut data as *mut _ as *mut c_void);

            // 5. 出力データのインターリーブ (Interleave Output)
            if res == K_RESULT_OK {
                // 実際の出力範囲だけを処理し、異常に大きいchannel数でも空回りしない。
                for (index, sample) in output_buffer
                    .iter_mut()
                    .take(sample_count.unwrap())
                    .enumerate()
                {
                    let channel = index % channels;
                    *sample = if channel < active_channels {
                        self.scratch_outputs[channel][index / channels]
                    } else {
                        0.0
                    };
                }
            } else {
                output_buffer.fill(0.0);
            }
        }
    }

    fn needs_host_conversion(&self, inputs: &[Vec<f32>], outputs: &[Vec<f32>]) -> bool {
        // プラグインが 1ch で、チェーンが左右を持っているときだけ混ぜるか複製する。
        (self.input_channels == 1 && inputs.len() >= 2)
            || (self.output_channels == 1 && outputs.len() >= 2)
    }

    pub fn process_planar(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        num_samples: usize,
    ) {
        if self.needs_host_conversion(inputs, outputs) {
            self.process_planar_converted(inputs, outputs, num_samples);
            return;
        }
        let ch_count = inputs
            .len()
            .min(outputs.len())
            .min(self.scratch_inputs.len())
            .min(self.scratch_outputs.len())
            .min(self.input_channels)
            .min(self.output_channels);
        // FFIへ渡す前に全使用チャンネルの長さを確認する。RT上では割当・ログを行わない。
        if !self.active_flag.load(Ordering::SeqCst)
            || self.ptr.is_null()
            || num_samples == 0
            || num_samples > self.max_block_size
            || num_samples > i32::MAX as usize
            || ch_count == 0
            || inputs
                .iter()
                .take(ch_count)
                .any(|ch| ch.len() < num_samples)
            || outputs
                .iter()
                .take(ch_count)
                .any(|ch| ch.len() < num_samples)
        {
            Self::silence_planar(outputs, num_samples);
            return;
        }

        // SAFETY: create_processor が add_ref した processor と DLL を保持する。上で各チャネルの長さとフレーム数を検証し、呼び出し中はスライスが生存する。
        unsafe {
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);

            // Prepare Pointers directly from arguments
            self.input_ptrs.clear();
            self.output_ptrs.clear();

            for (input, output) in inputs.iter().zip(outputs.iter_mut()).take(ch_count) {
                self.input_ptrs.push(input.as_ptr() as *mut f32);
                self.output_ptrs.push(output.as_mut_ptr());
            }

            // AudioBusBuffers
            self.bus_inputs.clear();
            self.bus_outputs.clear();

            self.bus_inputs.push(AudioBusBuffers {
                num_channels: ch_count as i32,
                silence_flags: 0,
                channel_buffers32: self.input_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: ch_count as i32,
                silence_flags: 0,
                channel_buffers32: self.output_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });

            // Dummy Bus
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                num_samples: num_samples as i32,
                num_inputs: 1,
                num_outputs: 1,
                inputs: self.bus_inputs.as_mut_ptr(),
                outputs: self.bus_outputs.as_mut_ptr(),
                input_events: std::ptr::null_mut(),
                output_events: std::ptr::null_mut(),
                input_param_changes: std::ptr::null_mut(),
                output_param_changes: std::ptr::null_mut(),
                process_context: std::ptr::null_mut(),
            };

            let res = (vtbl.process)(self.ptr, &mut data as *mut _ as *mut c_void);

            // 5. Clean up unused channels
            // (process_planar implies we write directly to outputs, but if outputs has more channels
            // than we processed, we MUST silence them to avoid garbage from previous frames in ring buffer)
            if res == K_RESULT_OK {
                Self::silence_planar(&mut outputs[ch_count..], num_samples);
            } else {
                // If failed, silence valid channels too?
                // VST3 spec says if process returns error, outputs are undefined. Best to silence everything.
                Self::silence_planar(outputs, num_samples);
            }
        }
    }

    /// モノラル bus とステレオのチェーンの間を、事前確保した scratch だけで変換する。
    fn process_planar_converted(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        num_samples: usize,
    ) {
        let in_ch = self.input_channels;
        let out_ch = self.output_channels;
        let in_read = if in_ch == 1 { 2 } else { in_ch };
        let out_write = if out_ch == 1 {
            outputs.len().min(2)
        } else {
            out_ch
        };
        let scratch_in_ready = in_ch != 1
            || self
                .scratch_inputs
                .first()
                .is_some_and(|channel| channel.len() >= num_samples);
        let scratch_out_ready = out_ch != 1
            || self
                .scratch_outputs
                .first()
                .is_some_and(|channel| channel.len() >= num_samples);
        let buffers_ready = in_read > 0
            && out_write > 0
            && inputs.len() >= in_read
            && outputs.len() >= out_write
            && inputs
                .iter()
                .take(in_read)
                .all(|channel| channel.len() >= num_samples)
            && outputs
                .iter()
                .take(out_write)
                .all(|channel| channel.len() >= num_samples);
        // 容量が足りない push は RT で確保になる。足りなければ無音にして戻る。
        let reserved = self.input_ptrs.capacity() >= in_ch
            && self.output_ptrs.capacity() >= out_ch
            && self.bus_inputs.capacity() >= 2
            && self.bus_outputs.capacity() >= 2;
        if !self.active_flag.load(Ordering::SeqCst)
            || self.ptr.is_null()
            || num_samples == 0
            || num_samples > self.max_block_size
            || num_samples > i32::MAX as usize
            || !scratch_in_ready
            || !scratch_out_ready
            || !buffers_ready
            || !reserved
        {
            Self::silence_planar(outputs, num_samples);
            return;
        }

        if in_ch == 1 {
            let left = &inputs[0][..num_samples];
            let right = &inputs[1][..num_samples];
            let mixed = &mut self.scratch_inputs[0][..num_samples];
            for index in 0..num_samples {
                // 同じ音を左右に入れたときは元の大きさ。片側だけは半分（-6 dB）、逆相は打ち消す。
                mixed[index] = 0.5 * (left[index] + right[index]);
            }
        }
        if out_ch == 1 {
            self.scratch_outputs[0][..num_samples].fill(0.0);
        }

        // SAFETY: フレーム数、各 ch の長さ、ポインタ配列の容量を上で確認した。ポインタは process の間だけ使う。
        let result = unsafe {
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);
            self.input_ptrs.clear();
            self.output_ptrs.clear();
            if in_ch == 1 {
                self.input_ptrs.push(self.scratch_inputs[0].as_mut_ptr());
            } else {
                for channel in inputs.iter().take(in_ch) {
                    self.input_ptrs.push(channel.as_ptr() as *mut f32);
                }
            }
            if out_ch == 1 {
                self.output_ptrs.push(self.scratch_outputs[0].as_mut_ptr());
            } else {
                for channel in outputs.iter_mut().take(out_ch) {
                    self.output_ptrs.push(channel.as_mut_ptr());
                }
            }

            self.bus_inputs.clear();
            self.bus_outputs.clear();
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: in_ch as i32,
                silence_flags: 0,
                channel_buffers32: self.input_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: out_ch as i32,
                silence_flags: 0,
                channel_buffers32: self.output_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                num_samples: num_samples as i32,
                num_inputs: 1,
                num_outputs: 1,
                inputs: self.bus_inputs.as_mut_ptr(),
                outputs: self.bus_outputs.as_mut_ptr(),
                input_events: std::ptr::null_mut(),
                output_events: std::ptr::null_mut(),
                input_param_changes: std::ptr::null_mut(),
                output_param_changes: std::ptr::null_mut(),
                process_context: std::ptr::null_mut(),
            };
            (vtbl.process)(self.ptr, &mut data as *mut _ as *mut c_void)
        };

        if result == K_RESULT_OK {
            if out_ch == 1 {
                let rendered = &self.scratch_outputs[0][..num_samples];
                for channel in outputs.iter_mut().take(out_write) {
                    channel[..num_samples].copy_from_slice(rendered);
                }
                Self::silence_planar(&mut outputs[out_write..], num_samples);
            } else {
                Self::silence_planar(&mut outputs[out_ch..], num_samples);
            }
        } else {
            Self::silence_planar(outputs, num_samples);
        }
    }
}

impl Drop for VstProcessor {
    fn drop(&mut self) {
        // println!("BP: VstProcessor Drop Start {:p}", self.ptr);
        // SAFETY: create_processor で追加した processor の COM 参照を一度だけ解放し、DLL はこの drop 中も保持される。
        unsafe {
            if !self.ptr.is_null() {
                let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);
                (vtbl.base.release)(self.ptr);
                // println!("BP: VstProcessor Release Called");
            }
        }
        // println!("BP: VstProcessor Drop End");
    }
}

#[cfg(test)]
mod reset_tests {
    use super::*;
    use crate::vst_host::c_api::{FUnknownVtbl, TUID};
    use crate::vst_host::instance::PluginLibrary;
    use crate::vst_host::instance::{K_NO_INTERFACE, K_RESULT_FALSE};
    use std::{
        cell::UnsafeCell,
        sync::{atomic::AtomicBool, Arc},
    };

    #[repr(C)]
    struct Mock {
        vtbl: *const IAudioProcessorVtbl,
        calls: [i32; 2],
        len: usize,
        tail: u32,
        fail_state: i32,
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
        K_RESULT_OK
    }
    unsafe extern "system" fn arrangement(_: *mut c_void, _: i32, _: i32, _: *mut c_void) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn sample_size(_: *mut c_void, _: i32) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn samples(_: *mut c_void) -> u32 {
        0
    }
    unsafe extern "system" fn setup(_: *mut c_void, _: *mut c_void) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn process(_: *mut c_void, _: *mut c_void) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn set_processing(this: *mut c_void, state: i32) -> i32 {
        let mock = &mut *(this as *mut Mock);
        mock.calls[mock.len] = state;
        mock.len += 1;
        if state == mock.fail_state {
            return K_RESULT_FALSE;
        }
        if state == 1 {
            mock.tail = 0;
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
        set_processing,
        process,
        get_tail_samples: samples,
    };
    #[test]
    fn reset_clears_mock_tail_and_stops_on_failure_without_allocating() {
        for failure in [-1, 0, 1] {
            let mock = Box::new(UnsafeCell::new(Mock {
                vtbl: &VTABLE,
                calls: [-1; 2],
                len: 0,
                tail: 7,
                fail_state: failure,
            }));
            let mut processor = VstProcessor {
                tail_samples: None,
                ptr: mock.get().cast(),
                // SAFETY: テスト用の既知のWindows DLLを保持するだけで、VST呼出し先は別途所有するmockのvtableを使う。
                _library: Arc::new(unsafe { PluginLibrary::load("kernel32.dll", false) }.unwrap()),
                scratch_inputs: vec![],
                scratch_outputs: vec![],
                input_ptrs: vec![],
                output_ptrs: vec![],
                bus_inputs: vec![],
                bus_outputs: vec![],
                active_flag: Arc::new(AtomicBool::new(true)),
                max_block_size: 0,
                _num_channels: 2,
                input_channels: 2,
                output_channels: 2,
            };
            let mut success = false;
            let counts = crate::vst_host::instance::allocation_counts(|| {
                success = processor.reset_processing();
            });
            assert_eq!(counts, (0, 0));
            // SAFETY: mockのBoxが生存し、同期的なreset完了後に同じテストスレッドだけが状態を参照する。
            let state = unsafe { &*mock.get() };
            assert_eq!(success, failure == -1);
            assert_eq!(state.calls[0], 0);
            assert_eq!(state.len, if failure == 0 { 1 } else { 2 });
            if failure != 0 {
                assert_eq!(state.calls[1], 1);
            }
            assert_eq!(state.tail, if success { 0 } else { 7 });
            drop(processor);
        }
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use crate::vst_host::c_api::{FUnknownVtbl, ProcessData, TUID};
    use crate::vst_host::instance::{allocation_counts, PluginLibrary, K_NO_INTERFACE};
    use std::{
        cell::UnsafeCell,
        sync::{atomic::AtomicBool, Arc},
    };

    #[repr(C)]
    struct Probe {
        vtbl: *const IAudioProcessorVtbl,
        in_channels: i32,
        out_channels: i32,
        calls: u32,
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
        K_RESULT_OK
    }
    unsafe extern "system" fn arrangement(_: *mut c_void, _: i32, _: i32, _: *mut c_void) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn sample_size(_: *mut c_void, _: i32) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn samples(_: *mut c_void) -> u32 {
        0
    }
    unsafe extern "system" fn setup(_: *mut c_void, _: *mut c_void) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn set_processing(_: *mut c_void, _: i32) -> i32 {
        K_RESULT_OK
    }
    unsafe extern "system" fn process(this: *mut c_void, data: *mut c_void) -> i32 {
        let probe = &mut *(this as *mut Probe);
        let data = &*(data as *const ProcessData);
        let input = &*data.inputs;
        let output = &*data.outputs;
        probe.in_channels = input.num_channels;
        probe.out_channels = output.num_channels;
        probe.calls += 1;
        let frames = data.num_samples as usize;
        let in_count = input.num_channels.max(0) as usize;
        let out_count = output.num_channels.max(0) as usize;
        for channel in 0..out_count {
            let source = if in_count == 0 {
                0
            } else {
                channel.min(in_count - 1)
            };
            for frame in 0..frames {
                let sample = if in_count == 0 {
                    0.0
                } else {
                    *(*input.channel_buffers32.add(source)).add(frame)
                };
                *(*output.channel_buffers32.add(channel)).add(frame) = sample;
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
        set_processing,
        process,
        get_tail_samples: samples,
    };

    struct Harness {
        processor: VstProcessor,
        probe: Box<UnsafeCell<Probe>>,
    }

    fn harness(input_channels: usize, output_channels: usize) -> Harness {
        let probe = Box::new(UnsafeCell::new(Probe {
            vtbl: &VTABLE,
            in_channels: -1,
            out_channels: -1,
            calls: 0,
        }));
        let cap = 8;
        let processor = VstProcessor {
            tail_samples: None,
            ptr: probe.get().cast(),
            // SAFETY: DLL 保持だけに kernel32 を使い、処理先はテスト内の probe である。
            _library: Arc::new(unsafe { PluginLibrary::load("kernel32.dll", false) }.unwrap()),
            scratch_inputs: vec![vec![0.0; cap]; input_channels],
            scratch_outputs: vec![vec![0.0; cap]; output_channels],
            input_ptrs: Vec::with_capacity(input_channels),
            output_ptrs: Vec::with_capacity(output_channels),
            bus_inputs: Vec::with_capacity(2),
            bus_outputs: Vec::with_capacity(2),
            active_flag: Arc::new(AtomicBool::new(true)),
            max_block_size: cap,
            _num_channels: input_channels.max(output_channels),
            input_channels,
            output_channels,
        };
        Harness { processor, probe }
    }

    impl Harness {
        fn seen(&self) -> (i32, i32, u32) {
            // SAFETY: process が戻ったあと、同じテストスレッドだけが probe を読む。
            let probe = unsafe { &*self.probe.get() };
            (probe.in_channels, probe.out_channels, probe.calls)
        }
    }

    fn render(
        input_channels: usize,
        output_channels: usize,
        left: &[f32],
        right: &[f32],
    ) -> (Vec<f32>, Vec<f32>, i32, i32) {
        let mut test = harness(input_channels, output_channels);
        let mut output = vec![
            vec![9.0; left.len() + 1],
            vec![9.0; right.len() + 1],
            vec![9.0; 2],
        ];
        test.processor
            .process_planar(&[left.to_vec(), right.to_vec()], &mut output, left.len());
        let (in_channels, out_channels, calls) = test.seen();
        assert_eq!(calls, 1);
        (
            output[0].clone(),
            output[1].clone(),
            in_channels,
            out_channels,
        )
    }

    #[test]
    fn mono_identity_mixes_equal_power_and_duplicates_both_sides() {
        let frames = [0.5, -0.25];
        let (left, right, in_channels, out_channels) = render(1, 1, &frames, &frames);
        assert_eq!((in_channels, out_channels), (1, 1));
        assert_eq!(left, vec![0.5, -0.25, 9.0]);
        assert_eq!(right, left);
    }

    #[test]
    fn mono_identity_lowers_a_single_side_and_cancels_opposite_phase() {
        let (left, right, _, _) = render(1, 1, &[0.5, 0.25], &[0.0, -0.25]);
        assert_eq!(left, vec![0.25, 0.0, 9.0]);
        assert_eq!(right, left);
        assert_eq!(left[0], 0.5 * 0.5);
    }

    #[test]
    fn stereo_identity_does_not_change_either_channel() {
        let (left, right, in_channels, out_channels) = render(2, 2, &[0.25, -0.5], &[-0.75, 0.125]);
        assert_eq!((in_channels, out_channels), (2, 2));
        assert_eq!(left, vec![0.25, -0.5, 9.0]);
        assert_eq!(right, vec![-0.75, 0.125, 9.0]);
    }

    #[test]
    fn mono_to_stereo_reports_each_bus_and_feeds_the_mix() {
        let (left, right, in_channels, out_channels) = render(1, 2, &[0.5, 1.0], &[0.5, 0.0]);
        assert_eq!((in_channels, out_channels), (1, 2));
        // 恒等処理は受け取った 1ch を左右へコピーする。入力は先に混ぜてある。
        assert_eq!(left, vec![0.5, 0.5, 9.0]);
        assert_eq!(right, left);
    }

    #[test]
    fn converted_planar_paths_do_not_allocate() {
        let mut mono = harness(1, 1);
        let mut widened = harness(1, 2);
        let mut stereo = harness(2, 2);
        let input = vec![vec![0.5; 4], vec![-0.5; 4]];
        let short = vec![vec![0.5; 3], vec![0.5; 4]];
        let mut output = vec![vec![9.0; 4], vec![9.0; 4]];
        assert_eq!(
            allocation_counts(|| {
                mono.processor.process_planar(&input, &mut output, 4);
                widened.processor.process_planar(&input, &mut output, 4);
                stereo.processor.process_planar(&input, &mut output, 4);
                mono.processor.process_planar(&short, &mut output, 4);
                mono.processor.process_planar(&input, &mut output, 0);
            }),
            (0, 0)
        );
        assert_eq!(mono.seen().2, 1);
        assert_eq!(widened.seen().2, 1);
        assert_eq!(stereo.seen().2, 1);
    }
}

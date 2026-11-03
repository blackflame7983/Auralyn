//! 音声コールバックから呼ぶVST処理。事前確保したバッファだけを使用する。
use super::{get_vtbl, VstProcessor};
use crate::vst_host::c_api::{
    AudioBusBuffers, IAudioProcessorVtbl, ProcessData, K_REALTIME, K_RESULT_OK, K_SAMPLE_32,
};
use std::ffi::c_void;
use std::sync::atomic::Ordering;

impl VstProcessor {
    pub(crate) fn reset_processing(&mut self) -> bool {
        if !self.active_flag.load(Ordering::SeqCst) || self.ptr.is_null() {
            return false;
        }
        // 専用 worker の process 呼出し間だけで実行する。VST3 準拠の実装は
        // setProcessing(true) で遅延線などを初期化する。非準拠 VST は保証できない。
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
            .min(self.scratch_outputs.len());
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

    pub fn process_planar(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        num_samples: usize,
    ) {
        let ch_count = inputs
            .len()
            .min(outputs.len())
            .min(self.scratch_inputs.len())
            .min(self.scratch_outputs.len());
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
}

impl Drop for VstProcessor {
    fn drop(&mut self) {
        // println!("BP: VstProcessor Drop Start {:p}", self.ptr);
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
                ptr: mock.get().cast(),
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
            };
            let mut success = false;
            let counts = crate::vst_host::instance::allocation_counts(|| {
                success = processor.reset_processing();
            });
            assert_eq!(counts, (0, 0));
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

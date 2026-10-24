//! 状態保存用IBStream。プラグインが保持した参照も最後のreleaseまで有効にする。
use super::{K_INVALID_ARGUMENT, K_NO_INTERFACE};
use crate::vst_host::c_api::{FUnknownVtbl, IBStreamVtbl, TResult, TUID};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{fence, AtomicU32, Ordering};
use vst3::Interface;

pub(super) struct StateStream(NonNull<MemoryStream>);

impl StateStream {
    pub(super) fn new(data: Vec<u8>) -> Self {
        Self(NonNull::from(Box::leak(Box::new(MemoryStream {
            vtbl: &VTBL,
            data,
            cursor: 0,
            references: AtomicU32::new(1),
        }))))
    }

    pub(super) fn as_ptr(&self) -> *mut c_void {
        self.0.as_ptr().cast()
    }

    // 呼出先の同期getStateが完了した後だけ参照する。
    pub(super) fn bytes(&self) -> &[u8] {
        unsafe { &self.0.as_ref().data }
    }

    pub(super) fn rewind(&mut self) {
        unsafe {
            self.0.as_mut().cursor = 0;
        }
    }
}

impl Drop for StateStream {
    fn drop(&mut self) {
        unsafe {
            release(self.as_ptr());
        }
    }
}

#[repr(C)]
struct MemoryStream {
    vtbl: *const IBStreamVtbl,
    data: Vec<u8>,
    cursor: usize,
    references: AtomicU32,
}

unsafe extern "system" fn query(
    this: *mut c_void,
    iid: *const TUID,
    out: *mut *mut c_void,
) -> TResult {
    if out.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *out = std::ptr::null_mut();
    if this.is_null() || iid.is_null() {
        return K_INVALID_ARGUMENT;
    }
    if *iid != vst3::Steinberg::FUnknown::IID && *iid != vst3::Steinberg::IBStream::IID {
        return K_NO_INTERFACE;
    }
    add_ref(this);
    *out = this;
    0
}

unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let stream = &*(this as *const MemoryStream);
    stream.references.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    if this.is_null() {
        return 0;
    }
    let stream = &*(this as *const MemoryStream);
    let previous = stream.references.fetch_sub(1, Ordering::Release);
    if previous == 1 {
        fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut MemoryStream));
    }
    previous - 1
}

unsafe extern "system" fn read(
    this: *mut c_void,
    buffer: *mut c_void,
    count: i32,
    actual: *mut i32,
) -> TResult {
    if !actual.is_null() {
        *actual = 0;
    }
    if this.is_null() || count < 0 || (count > 0 && buffer.is_null()) {
        return K_INVALID_ARGUMENT;
    }
    let stream = &mut *(this as *mut MemoryStream);
    let size = stream
        .data
        .len()
        .saturating_sub(stream.cursor)
        .min(count as usize);
    if size > 0 {
        std::ptr::copy_nonoverlapping(stream.data.as_ptr().add(stream.cursor), buffer.cast(), size);
        stream.cursor += size;
    }
    if !actual.is_null() {
        *actual = size as i32;
    }
    0
}

unsafe extern "system" fn write(
    this: *mut c_void,
    buffer: *const c_void,
    count: i32,
    actual: *mut i32,
) -> TResult {
    if !actual.is_null() {
        *actual = 0;
    }
    if this.is_null() || count < 0 || (count > 0 && buffer.is_null()) {
        return K_INVALID_ARGUMENT;
    }
    if count == 0 {
        return 0;
    }
    let stream = &mut *(this as *mut MemoryStream);
    let Some(end) = stream
        .cursor
        .checked_add(count as usize)
        .filter(|end| *end <= isize::MAX as usize)
    else {
        return K_INVALID_ARGUMENT;
    };
    if end > stream.data.len() {
        if stream.data.try_reserve(end - stream.data.len()).is_err() {
            return K_INVALID_ARGUMENT;
        }
        stream.data.resize(end, 0);
    }
    let bytes = std::slice::from_raw_parts(buffer.cast::<u8>(), count as usize);
    stream.data[stream.cursor..end].copy_from_slice(bytes);
    stream.cursor = end;
    if !actual.is_null() {
        *actual = count;
    }
    0
}

unsafe extern "system" fn seek(
    this: *mut c_void,
    offset: i64,
    mode: i32,
    actual: *mut i64,
) -> TResult {
    if this.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let stream = &mut *(this as *mut MemoryStream);
    let base = match mode {
        0 => 0,
        1 => stream.cursor as i64,
        2 => stream.data.len() as i64,
        _ => return K_INVALID_ARGUMENT,
    };
    let Some(position) = base.checked_add(offset).filter(|position| *position >= 0) else {
        return K_INVALID_ARGUMENT;
    };
    let Ok(cursor) = usize::try_from(position) else {
        return K_INVALID_ARGUMENT;
    };
    stream.cursor = cursor;
    if !actual.is_null() {
        *actual = position;
    }
    0
}

unsafe extern "system" fn tell(this: *mut c_void, actual: *mut i64) -> TResult {
    if this.is_null() || actual.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *actual = (*(this as *const MemoryStream)).cursor as i64;
    0
}

static VTBL: IBStreamVtbl = IBStreamVtbl {
    base: FUnknownVtbl {
        query_interface: query,
        add_ref,
        release,
    },
    read,
    write,
    seek,
    tell,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr::{null, null_mut};

    #[test]
    fn invalid_lengths_null_buffers_and_overflow_do_not_modify_state() {
        let stream = StateStream::new(vec![1, 2, 3]);
        let p = stream.as_ptr();
        unsafe {
            let mut actual = 99;
            let mut byte = 0_u8;
            assert_eq!(
                read(p, (&mut byte as *mut u8).cast(), -1, &mut actual),
                K_INVALID_ARGUMENT
            );
            assert_eq!(actual, 0);
            assert_eq!(byte, 0);
            assert_eq!(write(p, null(), -1, &mut actual), K_INVALID_ARGUMENT);
            assert_eq!(read(p, null_mut(), 1, &mut actual), K_INVALID_ARGUMENT);
            assert_eq!(write(p, null(), 1, &mut actual), K_INVALID_ARGUMENT);
            assert_eq!(read(p, null_mut(), 0, &mut actual), 0);
            assert_eq!(write(p, null(), 0, &mut actual), 0);
            assert_eq!(seek(p, i64::MAX, 0, null_mut()), 0);
            assert_eq!(seek(p, 1, 1, null_mut()), K_INVALID_ARGUMENT);
            assert_eq!(
                write(p, (&byte as *const u8).cast(), 1, &mut actual),
                K_INVALID_ARGUMENT
            );
            assert_eq!(seek(p, 0, 99, null_mut()), K_INVALID_ARGUMENT);
            assert_eq!(seek(p, -1, 0, null_mut()), K_INVALID_ARGUMENT);
            assert_eq!(stream.bytes(), [1, 2, 3]);
        }
    }

    #[test]
    fn retained_reference_survives_owner_and_stream_supports_seek_and_partial_reads() {
        let stream = StateStream::new(vec![1, 2, 3]);
        let mut retained = null_mut();
        unsafe {
            assert_eq!(
                query(
                    stream.as_ptr(),
                    &vst3::Steinberg::IBStream::IID,
                    &mut retained
                ),
                0
            );
            drop(stream);
            assert_eq!(seek(retained, 5, 0, null_mut()), 0);
            let byte = 9_u8;
            assert_eq!(
                write(retained, (&byte as *const u8).cast(), 1, null_mut()),
                0
            );
            assert_eq!(seek(retained, -3, 2, null_mut()), 0);
            let mut output = [99_u8; 5];
            let mut actual = 0;
            assert_eq!(
                read(retained, output.as_mut_ptr().cast(), 5, &mut actual),
                0
            );
            assert_eq!(actual, 3);
            assert_eq!(output, [0, 0, 9, 99, 99]);
            assert_eq!(release(retained), 0);
        }
    }
}

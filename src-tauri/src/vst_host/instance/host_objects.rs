//! VSTホストが生成するIMessageとIAttributeList。参照寿命と属性データをここで管理する。
use super::{K_INVALID_ARGUMENT, K_NO_INTERFACE, K_RESULT_FALSE};
use crate::vst_host::c_api::{FUnknownVtbl, TResult, K_RESULT_OK, TUID};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use vst3::Interface;

// --- Host Created Objects (IMessage / IAttributeList) ---
// Insight 2 requests IMessage instances from IHostApplication::create_instance during connect/init.
// If we return kNoInterface, the plugin may crash. Provide minimal working objects.

type AttrID = *const c_char;
type FIDString = *const c_char;
type TChar = u16; // VST3: UTF-16 on Windows

#[repr(C)]
struct IAttributeListVtbl {
    base: FUnknownVtbl,
    set_int: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: i64) -> TResult,
    get_int: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: *mut i64) -> TResult,
    set_float: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: f64) -> TResult,
    get_float: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: *mut f64) -> TResult,
    set_string:
        unsafe extern "system" fn(this: *mut c_void, id: AttrID, string: *const TChar) -> TResult,
    get_string: unsafe extern "system" fn(
        this: *mut c_void,
        id: AttrID,
        string: *mut TChar,
        size_in_bytes: u32,
    ) -> TResult,
    set_binary: unsafe extern "system" fn(
        this: *mut c_void,
        id: AttrID,
        data: *const c_void,
        size_in_bytes: u32,
    ) -> TResult,
    get_binary: unsafe extern "system" fn(
        this: *mut c_void,
        id: AttrID,
        data: *mut *const c_void,
        size_in_bytes: *mut u32,
    ) -> TResult,
}

#[derive(Clone, Debug)]
enum AttrValue {
    Int(i64),
    Float(f64),
    String(Vec<u16>),
    Binary(Vec<u8>),
}

#[repr(C)]
struct MockAttributeList {
    vtbl: *const IAttributeListVtbl,
    ref_count: AtomicU32,
    map: Mutex<HashMap<String, AttrValue>>,
}

unsafe impl Send for MockAttributeList {}
unsafe impl Sync for MockAttributeList {}

unsafe fn attr_key(id: AttrID) -> Option<String> {
    if id.is_null() {
        return None;
    }
    let s = CStr::from_ptr(id).to_string_lossy().into_owned();
    Some(s)
}

unsafe extern "system" fn attr_query_interface(
    this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> TResult {
    if obj.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *obj = std::ptr::null_mut();
    if iid.is_null() {
        return K_INVALID_ARGUMENT;
    }

    use vst3::Steinberg::FUnknown;
    use vst3::Steinberg::Vst::IAttributeList as VstIAttributeList;

    let iid_slice = *iid;
    if iid_slice == FUnknown::IID || iid_slice == VstIAttributeList::IID {
        *obj = this;
        // add_ref
        let me = this as *mut MockAttributeList;
        (*me).ref_count.fetch_add(1, Ordering::Relaxed);
        return K_RESULT_OK;
    }

    K_NO_INTERFACE
}

unsafe extern "system" fn attr_add_ref(this: *mut c_void) -> u32 {
    let me = this as *mut MockAttributeList;
    (*me).ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn attr_release(this: *mut c_void) -> u32 {
    let me = this as *mut MockAttributeList;
    let prev = (*me).ref_count.fetch_sub(1, Ordering::Release);
    let next = prev.saturating_sub(1);
    if next == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(me));
    }
    next
}

unsafe extern "system" fn attr_set_int(this: *mut c_void, id: AttrID, value: i64) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::Int(value));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_int(this: *mut c_void, id: AttrID, value: *mut i64) -> TResult {
    if value.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_int key=\"{}\"", k);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::Int(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found: {}", v);
            *value = *v;
            return K_RESULT_OK;
        }
        println!("[IAttributeList]   -> NOT FOUND");
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_set_float(this: *mut c_void, id: AttrID, value: f64) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::Float(value));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_float(
    this: *mut c_void,
    id: AttrID,
    value: *mut f64,
) -> TResult {
    if value.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_float key=\"{}\"", k);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::Float(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found: {}", v);
            *value = *v;
            return K_RESULT_OK;
        }
        println!("[IAttributeList]   -> NOT FOUND");
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

unsafe fn read_tchar_z(ptr: *const TChar) -> Vec<u16> {
    if ptr.is_null() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0usize;
    loop {
        let ch = *ptr.add(i);
        if ch == 0 {
            break;
        }
        out.push(ch);
        i += 1;
        if i > 16 * 1024 {
            break;
        }
    }
    out
}

unsafe extern "system" fn attr_set_string(
    this: *mut c_void,
    id: AttrID,
    string: *const TChar,
) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    let v = read_tchar_z(string);
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::String(v));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_string(
    this: *mut c_void,
    id: AttrID,
    string: *mut TChar,
    size_in_bytes: u32,
) -> TResult {
    if string.is_null() || size_in_bytes < 2 {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_string key=\"{}\"", k);
    let max_u16 = (size_in_bytes as usize / 2).saturating_sub(1);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::String(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found (len={})", v.len());
            let n = v.len().min(max_u16);
            std::ptr::copy_nonoverlapping(v.as_ptr(), string, n);
            *string.add(n) = 0;
            return K_RESULT_OK;
        }
        *string = 0;
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_set_binary(
    this: *mut c_void,
    id: AttrID,
    data: *const c_void,
    size_in_bytes: u32,
) -> TResult {
    if data.is_null() && size_in_bytes > 0 {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    let slice = if size_in_bytes == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(data as *const u8, size_in_bytes as usize)
    };
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::Binary(slice.to_vec()));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_binary(
    this: *mut c_void,
    id: AttrID,
    data: *mut *const c_void,
    size_in_bytes: *mut u32,
) -> TResult {
    if data.is_null() || size_in_bytes.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *data = std::ptr::null();
    *size_in_bytes = 0;
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_binary key=\"{}\"", k);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::Binary(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found (len={})", v.len());
            *data = v.as_ptr() as *const c_void;
            *size_in_bytes = v.len() as u32;
            return K_RESULT_OK;
        }
        println!("[IAttributeList]   -> NOT FOUND");
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

static mut MOCK_ATTR_LIST_VTBL: IAttributeListVtbl = IAttributeListVtbl {
    base: FUnknownVtbl {
        query_interface: attr_query_interface,
        add_ref: attr_add_ref,
        release: attr_release,
    },
    set_int: attr_set_int,
    get_int: attr_get_int,
    set_float: attr_set_float,
    get_float: attr_get_float,
    set_string: attr_set_string,
    get_string: attr_get_string,
    set_binary: attr_set_binary,
    get_binary: attr_get_binary,
};

pub(super) fn new_mock_attribute_list() -> *mut c_void {
    new_mock_attribute_list_for_path(None)
}

pub(super) fn new_mock_attribute_list_for_path(path: Option<&str>) -> *mut c_void {
    let mut map = HashMap::new();
    if let Some(path) = path {
        map.insert(
            "vst3.ibundlepath".into(),
            AttrValue::String(path.encode_utf16().chain(std::iter::once(0)).collect()),
        );
    }
    Box::into_raw(Box::new(MockAttributeList {
        vtbl: &raw const MOCK_ATTR_LIST_VTBL,
        ref_count: AtomicU32::new(1),
        map: Mutex::new(map),
    }))
    .cast()
}

#[repr(C)]
struct IMessageVtbl {
    base: FUnknownVtbl,
    get_message_id: unsafe extern "system" fn(this: *mut c_void) -> FIDString,
    set_message_id: unsafe extern "system" fn(this: *mut c_void, id: FIDString),
    get_attributes: unsafe extern "system" fn(this: *mut c_void) -> *mut c_void,
}

#[repr(C)]
struct MockMessage {
    vtbl: *const IMessageVtbl,
    ref_count: AtomicU32,
    message_id: Mutex<Option<Vec<u8>>>, // CString bytes including NUL
    attrs: *mut c_void,                 // MockAttributeList
}

unsafe impl Send for MockMessage {}
unsafe impl Sync for MockMessage {}

unsafe extern "system" fn msg_query_interface(
    this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> TResult {
    if obj.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *obj = std::ptr::null_mut();
    if iid.is_null() {
        return K_INVALID_ARGUMENT;
    }

    use vst3::Steinberg::FUnknown;
    use vst3::Steinberg::Vst::IMessage as VstIMessage;

    let iid_slice = *iid;
    if iid_slice == FUnknown::IID || iid_slice == VstIMessage::IID {
        *obj = this;
        let me = this as *mut MockMessage;
        (*me).ref_count.fetch_add(1, Ordering::Relaxed);
        return K_RESULT_OK;
    }

    K_NO_INTERFACE
}

unsafe extern "system" fn msg_add_ref(this: *mut c_void) -> u32 {
    let me = this as *mut MockMessage;
    (*me).ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn msg_release(this: *mut c_void) -> u32 {
    let me = this as *mut MockMessage;
    let prev = (*me).ref_count.fetch_sub(1, Ordering::Release);
    let next = prev.saturating_sub(1);
    if next == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        // Release attributes
        if !(*me).attrs.is_null() {
            let attr_obj = (*me).attrs;
            let _ = attr_release(attr_obj);
        }
        drop(Box::from_raw(me));
    }
    next
}

unsafe extern "system" fn msg_get_message_id(this: *mut c_void) -> FIDString {
    let me = this as *mut MockMessage;
    if let Ok(guard) = (*me).message_id.lock() {
        if let Some(bytes) = guard.as_ref() {
            return bytes.as_ptr() as *const c_char;
        }
    }
    std::ptr::null()
}

unsafe extern "system" fn msg_set_message_id(this: *mut c_void, id: FIDString) {
    let me = this as *mut MockMessage;
    let mut out: Option<Vec<u8>> = None;
    if !id.is_null() {
        out = Some(CStr::from_ptr(id).to_bytes_with_nul().to_vec());
    }
    if let Ok(mut guard) = (*me).message_id.lock() {
        *guard = out;
    }
}

unsafe extern "system" fn msg_get_attributes(this: *mut c_void) -> *mut c_void {
    let me = this as *mut MockMessage;
    if (*me).attrs.is_null() {
        return std::ptr::null_mut();
    }
    // add_ref before returning
    let attr_obj = (*me).attrs;
    let _ = attr_add_ref(attr_obj);
    attr_obj
}

static mut MOCK_MESSAGE_VTBL: IMessageVtbl = IMessageVtbl {
    base: FUnknownVtbl {
        query_interface: msg_query_interface,
        add_ref: msg_add_ref,
        release: msg_release,
    },
    get_message_id: msg_get_message_id,
    set_message_id: msg_set_message_id,
    get_attributes: msg_get_attributes,
};

pub(super) fn new_mock_message() -> *mut c_void {
    let attrs = new_mock_attribute_list();
    let obj = Box::new(MockMessage {
        vtbl: &raw const MOCK_MESSAGE_VTBL,
        ref_count: AtomicU32::new(1),
        message_id: Mutex::new(None),
        attrs,
    });
    Box::into_raw(obj) as *mut c_void
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn attributes_reject_invalid_binary_and_preserve_typed_values() {
        unsafe {
            let attrs = new_mock_attribute_list();
            let key = CString::new("key").unwrap();
            assert_eq!(attr_set_int(attrs, key.as_ptr(), 42), K_RESULT_OK);
            let mut integer = 0;
            assert_eq!(attr_get_int(attrs, key.as_ptr(), &mut integer), K_RESULT_OK);
            assert_eq!(integer, 42);
            assert_eq!(
                attr_set_binary(attrs, key.as_ptr(), std::ptr::null(), 7),
                K_INVALID_ARGUMENT
            );
            assert_eq!(attr_get_int(attrs, key.as_ptr(), &mut integer), K_RESULT_OK);
            assert_eq!(attr_set_float(attrs, key.as_ptr(), 0.5), K_RESULT_OK);
            let mut float = 0.0;
            assert_eq!(attr_get_float(attrs, key.as_ptr(), &mut float), K_RESULT_OK);
            assert_eq!(float, 0.5);
            let value = [1_u8, 2, 3];
            assert_eq!(
                attr_set_binary(attrs, key.as_ptr(), value.as_ptr().cast(), 3),
                K_RESULT_OK
            );
            let mut data = std::ptr::null();
            let mut size = 0;
            assert_eq!(
                attr_get_binary(attrs, key.as_ptr(), &mut data, &mut size),
                K_RESULT_OK
            );
            assert_eq!(
                std::slice::from_raw_parts(data.cast::<u8>(), size as usize),
                value
            );
            assert_eq!(attr_release(attrs), 0);
        }
    }

    #[test]
    fn retained_attributes_survive_their_message() {
        unsafe {
            let message = new_mock_message();
            let attrs = msg_get_attributes(message);
            let key = CString::new("name").unwrap();
            assert_eq!(attr_set_int(attrs, key.as_ptr(), 7), K_RESULT_OK);
            assert_eq!(msg_release(message), 0);
            let mut value = 0;
            assert_eq!(attr_get_int(attrs, key.as_ptr(), &mut value), K_RESULT_OK);
            assert_eq!(value, 7);
            assert_eq!(attr_release(attrs), 0);
        }
    }
}

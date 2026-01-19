use std::ffi::{c_char, c_void};

pub type TUID = [u8; 16];
pub type TResult = i32;

pub const K_RESULT_OK: TResult = 0;

pub const IID_IUNKNOWN: TUID = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];

pub const IID_IPLUGFRAME: TUID = [
    0x3B, 0x01, 0x7A, 0x36, 0xFC, 0x58, 0x85, 0x44, 0xA2, 0x4B, 0x08, 0xF5, 0xC0, 0x9B, 0x19, 0xD5,
];

pub const IID_ICONTEXTMENU: TUID = [
    0x63, 0xC8, 0x93, 0x2E, 0x9C, 0x0C, 0x88, 0x45, 0x97, 0xDB, 0xEC, 0xF5, 0xAD, 0x17, 0x81, 0x7D,
];

pub const IID_IPARAMETERFINDER: TUID = [
    0x02, 0x83, 0x61, 0x0F, 0x5D, 0x21, 0x87, 0x45, 0xA5, 0x12, 0x07, 0x3C, 0x77, 0xB9, 0xD3, 0x83,
];

// IUnitHandler (Fixed to Little Endian)
pub const IID_IUNITHANDLER: TUID = [
    0x02, 0xCC, 0x00, 0x4B, 0x49, 0xF3, 0xA5, 0x43, 0x88, 0x22, 0x19, 0x26, 0x65, 0xD8, 0x29, 0x87,
];

// IUnitInfo is usually implemented by Controller, usually queried by Host?
// Host queries Controller for IUnitInfo.
// Wait, if Controller Init fails, maybe context queries Controller?
// No, Controller::initialize(context) -> context.queryInterface(IUnitHandler).

// IComponentHandler (v1) (Fixed to Little Endian)
pub const IID_ICOMPONENTHANDLER: TUID = [
    0xA3, 0xBE, 0xA0, 0x93, 0xD0, 0x0B, 0xDB, 0x45, 0x8B, 0x89, 0x0B, 0x0C, 0xC1, 0xE4, 0x6A, 0xC6,
];

pub const IID_ITIMERHANDLER: TUID = [
    0x9F, 0x93, 0x5F, 0x3D, 0x74, 0xB3, 0x99, 0x42, 0x86, 0x64, 0xC2, 0x50, 0xE8, 0x5D, 0x08, 0xEE,
];

// HostMessage::cid (Standard VST3 Host Message Class ID)
// 959E758E-22A2-4217-9097-76E0152F9431
pub const CID_HOSTMESSAGE: TUID = [
    0x8E, 0x75, 0x9E, 0x95, 0xA2, 0x22, 0x17, 0x42, 0x90, 0x97, 0x76, 0xE0, 0x15, 0x2F, 0x94, 0x31,
];

pub const IID_ICONNECTIONPOINT: TUID = [
    0xCC, 0x23, 0x89, 0xAB, 0xEE, 0x8A, 0x02, 0x4E, 0x86, 0x31, 0x4A, 0x59, 0x78, 0xAF, 0x43, 0x65,
];

// IComponentHandler2
// B3B440F0-60A3-EC45-ABCD-C045B4D5A2CC
pub const IID_ICOMPONENTHANDLER2: TUID = [
    0xF0, 0x40, 0xB4, 0xB3, 0xA3, 0x60, 0x45, 0xEC, 0xAB, 0xCD, 0xC0, 0x45, 0xB4, 0xD5, 0xA2, 0xCC,
];

// IPlugViewContentScaleSupport (65ED9690-8AC4-45C5-8AAD-EF7D72695D34)
pub const IID_IPLUGVIEWCONTENTSCALESUPPORT: TUID = [
    0x90, 0x96, 0xED, 0x65, 0xC4, 0x8A, 0xC5, 0x45, 0x8A, 0xAD, 0xEF, 0x7D, 0x72, 0x69, 0x5D, 0x34,
];
pub const IID_IPLUGVIEWCONTENTSCALESUPPORT_BE: TUID = [
    0x65, 0xED, 0x96, 0x90, 0x8A, 0xC4, 0x45, 0xC5, 0x8A, 0xAD, 0xEF, 0x7D, 0x72, 0x69, 0x5D, 0x34,
];

// IPlugInterfaceSupport
// 4971c935-7d52-4752-9594-87790b387428
pub const IID_IPLUGINTERFACESUPPORT: TUID = [
    0x35, 0xC9, 0x71, 0x49, 0x52, 0x7D, 0x52, 0x47, 0x95, 0x94, 0x87, 0x79, 0x0B, 0x38, 0x74, 0x28,
];

// Big Endian Variants (seen in some plugins e.g. OTT)
pub const IID_ICOMPONENTHANDLER2_BE: TUID = [
    0xB3, 0xB4, 0x40, 0xF0, 0x60, 0xA3, 0xEC, 0x45, 0xAB, 0xCD, 0xC0, 0x45, 0xB4, 0xD5, 0xA2, 0xCC,
];
pub const IID_IPLUGINTERFACESUPPORT_BE: TUID = [
    0x49, 0x71, 0xC9, 0x35, 0x7D, 0x52, 0x47, 0x52, 0x95, 0x94, 0x87, 0x79, 0x0B, 0x38, 0x74, 0x28,
];

#[repr(C)]
pub struct PClassInfo {
    pub cid: TUID,
    pub cardinality: i32,
    pub category: [c_char; 32],
    pub name: [c_char; 64],
}

#[repr(C)]
pub struct PFactoryInfo {
    pub vendor: [c_char; 64],
    pub url: [c_char; 256],
    pub email: [c_char; 128],
    pub flags: i32,
}

#[repr(C)]
pub struct FUnknownVtbl {
    pub query_interface: unsafe extern "system" fn(
        this: *mut c_void,
        iid: *const TUID,
        obj: *mut *mut c_void,
    ) -> TResult,
    pub add_ref: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub release: unsafe extern "system" fn(this: *mut c_void) -> u32,
}

#[repr(C)]
pub struct IBStreamVtbl {
    pub base: FUnknownVtbl,
    pub read: unsafe extern "system" fn(
        this: *mut c_void,
        buffer: *mut c_void,
        num_bytes: i32,
        num_bytes_read: *mut i32,
    ) -> TResult,
    pub write: unsafe extern "system" fn(
        this: *mut c_void,
        buffer: *const c_void,
        num_bytes: i32,
        num_bytes_written: *mut i32,
    ) -> TResult,
    pub seek: unsafe extern "system" fn(
        this: *mut c_void,
        pos: i64,
        mode: i32,
        result_pos: *mut i64,
    ) -> TResult,
    pub tell: unsafe extern "system" fn(this: *mut c_void, pos: *mut i64) -> TResult,
}

#[repr(C)]
pub struct IPluginFactoryVtbl {
    pub base: FUnknownVtbl,
    pub get_factory_info:
        unsafe extern "system" fn(this: *mut c_void, info: *mut PFactoryInfo) -> TResult,
    pub count_classes: unsafe extern "system" fn(this: *mut c_void) -> i32,
    pub get_class_info:
        unsafe extern "system" fn(this: *mut c_void, index: i32, info: *mut PClassInfo) -> TResult,
    pub create_instance: unsafe extern "system" fn(
        this: *mut c_void,
        cid: *const TUID,
        iid: *const TUID,
        obj: *mut *mut c_void,
    ) -> TResult,
}

#[repr(C)]
pub struct IComponentVtbl {
    pub base: FUnknownVtbl,
    // IPluginBase
    pub initialize: unsafe extern "system" fn(this: *mut c_void, context: *mut c_void) -> TResult,
    pub terminate: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    // IComponent
    pub get_controller_class_id:
        unsafe extern "system" fn(this: *mut c_void, t_uid: *mut TUID) -> TResult,
    pub set_io_mode: unsafe extern "system" fn(this: *mut c_void, mode: i32) -> TResult,
    pub get_bus_count: unsafe extern "system" fn(this: *mut c_void, type_: i32, dir: i32) -> i32,
    pub get_bus_info: unsafe extern "system" fn(
        this: *mut c_void,
        type_: i32,
        dir: i32,
        index: i32,
        info: *mut c_void,
    ) -> TResult,
    pub get_routing_info: unsafe extern "system" fn(
        this: *mut c_void,
        in_info: *mut c_void,
        out_info: *mut c_void,
    ) -> TResult,
    pub activate_bus: unsafe extern "system" fn(
        this: *mut c_void,
        type_: i32,
        dir: i32,
        index: i32,
        state: i32,
    ) -> TResult,
    pub set_active: unsafe extern "system" fn(this: *mut c_void, state: i32) -> TResult,
    pub set_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub get_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
}

#[repr(C)]
pub struct IAudioProcessorVtbl {
    pub base: FUnknownVtbl,
    pub set_bus_arrangements: unsafe extern "system" fn(
        this: *mut c_void,
        inputs: *mut c_void,
        num_ins: i32,
        outputs: *mut c_void,
        num_outs: i32,
    ) -> TResult,
    pub get_bus_arrangement: unsafe extern "system" fn(
        this: *mut c_void,
        dir: i32,
        index: i32,
        arr: *mut c_void,
    ) -> TResult,
    pub can_process_sample_size:
        unsafe extern "system" fn(this: *mut c_void, symbolic_sample_size: i32) -> TResult,
    pub get_latency_samples: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub setup_processing:
        unsafe extern "system" fn(this: *mut c_void, setup: *mut c_void) -> TResult,
    pub set_processing: unsafe extern "system" fn(this: *mut c_void, state: i32) -> TResult,
    pub process: unsafe extern "system" fn(this: *mut c_void, data: *mut c_void) -> TResult,
    pub get_tail_samples: unsafe extern "system" fn(this: *mut c_void) -> u32,
}

#[repr(C)]
pub struct AudioBusBuffers {
    pub num_channels: i32,
    pub silence_flags: u64,
    pub channel_buffers32: *mut *mut f32, // Array of pointers to channel data
    pub channel_buffers64: *mut *mut f64,
}

#[repr(C)]
pub struct ProcessData {
    pub process_mode: i32,         // kRealtime
    pub symbolic_sample_size: i32, // kSample32
    pub num_samples: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub inputs: *mut AudioBusBuffers,
    pub outputs: *mut AudioBusBuffers,
    pub input_events: *mut c_void,         // IEventList*
    pub output_events: *mut c_void,        // IEventList*
    pub input_param_changes: *mut c_void,  // IParameterChanges*
    pub output_param_changes: *mut c_void, // IParameterChanges*
    pub process_context: *mut c_void,      // ProcessContext*
}

pub const K_REALTIME: i32 = 0;
pub const K_SAMPLE_32: i32 = 0;

#[repr(C)]
pub struct ProcessSetup {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub max_samples_per_block: i32,
    pub sample_rate: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ViewRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
pub struct IPlugViewVtbl {
    pub base: FUnknownVtbl,
    pub is_platform_type_supported:
        unsafe extern "system" fn(this: *mut c_void, type_: *const c_char) -> TResult,
    pub attached: unsafe extern "system" fn(
        this: *mut c_void,
        parent: *mut c_void,
        type_: *const c_char,
    ) -> TResult,
    pub removed: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub on_wheel: unsafe extern "system" fn(this: *mut c_void, distance: f32) -> TResult,
    pub on_key_down: unsafe extern "system" fn(
        this: *mut c_void,
        key: i16,
        key_code: i16,
        modifiers: i16,
    ) -> TResult,
    pub on_key_up: unsafe extern "system" fn(
        this: *mut c_void,
        key: i16,
        key_code: i16,
        modifiers: i16,
    ) -> TResult,
    pub get_size: unsafe extern "system" fn(this: *mut c_void, size: *mut ViewRect) -> TResult,
    pub on_size: unsafe extern "system" fn(this: *mut c_void, new_size: *mut ViewRect) -> TResult,
    pub on_focus: unsafe extern "system" fn(this: *mut c_void, state: i32) -> TResult,
    pub set_frame: unsafe extern "system" fn(this: *mut c_void, frame: *mut c_void) -> TResult,
    pub can_resize: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub check_size_constraint:
        unsafe extern "system" fn(this: *mut c_void, rect: *mut ViewRect) -> TResult,
}

#[repr(C)]
pub struct IPlugViewContentScaleSupportVtbl {
    pub base: FUnknownVtbl,
    pub set_scale_factor: unsafe extern "system" fn(this: *mut c_void, factor: f32) -> TResult,
}

#[repr(C)]
pub struct IPlugFrameVtbl {
    pub base: FUnknownVtbl,
    pub resize_view: unsafe extern "system" fn(
        this: *mut c_void,
        view: *mut c_void,
        new_size: *mut ViewRect,
    ) -> TResult,
}

#[repr(C)]
pub struct IHostApplicationVtbl {
    pub base: FUnknownVtbl,
    pub get_name: unsafe extern "system" fn(this: *mut c_void, name: *mut c_char) -> TResult,
    pub create_instance: unsafe extern "system" fn(
        this: *mut c_void,
        cid: *const TUID,
        iid: *const TUID,
        obj: *mut *mut c_void,
    ) -> TResult,
    pub create_host_attribute:
        unsafe extern "system" fn(this: *mut c_void, attr_list: *mut *mut c_void) -> TResult,
}

#[repr(C)]
pub struct IComponentHandlerVtbl {
    pub base: FUnknownVtbl,
    pub begin_edit: unsafe extern "system" fn(this: *mut c_void, id: u32) -> TResult,
    pub perform_edit:
        unsafe extern "system" fn(this: *mut c_void, id: u32, value_normalized: f64) -> TResult,
    pub end_edit: unsafe extern "system" fn(this: *mut c_void, id: u32) -> TResult,
    pub restart_component: unsafe extern "system" fn(this: *mut c_void, flags: i32) -> TResult,
}

#[repr(C)]
pub struct ITimerHandlerVtbl {
    pub base: FUnknownVtbl,
    pub on_timer: unsafe extern "system" fn(this: *mut c_void, id: *mut c_void) -> TResult,
}

#[repr(C)]
pub struct IComponentHandler2Vtbl {
    pub base: FUnknownVtbl,
    pub begin_edit: unsafe extern "system" fn(this: *mut c_void, id: u32) -> TResult,
    pub perform_edit:
        unsafe extern "system" fn(this: *mut c_void, id: u32, value_normalized: f64) -> TResult,
    pub end_edit: unsafe extern "system" fn(this: *mut c_void, id: u32) -> TResult,
    pub restart_component: unsafe extern "system" fn(this: *mut c_void, flags: i32) -> TResult,

    // IComponentHandler2 additions
    pub set_dirty: unsafe extern "system" fn(this: *mut c_void, state: i32) -> TResult,
    pub request_open_editor:
        unsafe extern "system" fn(this: *mut c_void, name: *const c_char) -> TResult,
    pub start_group_edit: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub finish_group_edit: unsafe extern "system" fn(this: *mut c_void) -> TResult,
}

#[repr(C)]
pub struct IConnectionPointVtbl {
    pub base: FUnknownVtbl,
    pub connect: unsafe extern "system" fn(this: *mut c_void, other: *mut c_void) -> TResult,
    pub disconnect: unsafe extern "system" fn(this: *mut c_void, other: *mut c_void) -> TResult,
    pub notify: unsafe extern "system" fn(this: *mut c_void, message: *mut c_void) -> TResult,
}

#[repr(C)]
pub struct IEditControllerVtbl {
    pub base: FUnknownVtbl,
    // IPluginBase
    pub initialize: unsafe extern "system" fn(this: *mut c_void, context: *mut c_void) -> TResult,
    pub terminate: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    // IEditController
    pub set_component_state:
        unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub set_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub get_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub get_parameter_count: unsafe extern "system" fn(this: *mut c_void) -> i32,
    pub get_parameter_info: unsafe extern "system" fn(
        this: *mut c_void,
        param_index: i32,
        info: *mut c_void,
    ) -> TResult,
    pub get_param_string_by_value: unsafe extern "system" fn(
        this: *mut c_void,
        id: u32,
        value: f64,
        string: *mut c_void,
    ) -> TResult,
    pub get_param_value_by_string: unsafe extern "system" fn(
        this: *mut c_void,
        id: u32,
        string: *mut c_void,
        value: *mut f64,
    ) -> TResult,
    pub normalized_param_to_plain:
        unsafe extern "system" fn(this: *mut c_void, id: u32, value: f64) -> f64,
    pub plain_param_to_normalized:
        unsafe extern "system" fn(this: *mut c_void, id: u32, plain_value: f64) -> f64,
    pub get_param_normalized: unsafe extern "system" fn(this: *mut c_void, id: u32) -> f64,
    pub set_param_normalized:
        unsafe extern "system" fn(this: *mut c_void, id: u32, value: f64) -> TResult,
    pub set_component_handler:
        unsafe extern "system" fn(this: *mut c_void, handler: *mut c_void) -> TResult,
    pub create_view:
        unsafe extern "system" fn(this: *mut c_void, name: *const c_char) -> *mut c_void, // returns IPlugView*
}

#[repr(C)]
pub struct IUnitHandlerVtbl {
    pub base: FUnknownVtbl,
    pub notify_unit_selection:
        unsafe extern "system" fn(this: *mut c_void, unit_id: i32) -> TResult,
    pub notify_program_list_change:
        unsafe extern "system" fn(this: *mut c_void, list_id: i32, program_index: i32) -> TResult,
}

#[repr(C)]
pub struct IContextMenuVtbl {
    pub base: FUnknownVtbl,
    pub get_item_count: unsafe extern "system" fn(this: *mut c_void, param_id: *const u32) -> i32,
    pub get_context_menu_item: unsafe extern "system" fn(
        this: *mut c_void,
        param_id: *const u32,
        tag: i32,
        item: *mut c_void,
    ) -> TResult,
    pub add_item: unsafe extern "system" fn(
        this: *mut c_void,
        item: *const c_void,
        target: *mut c_void,
    ) -> TResult,
    pub remove_item: unsafe extern "system" fn(
        this: *mut c_void,
        item: *const c_void,
        target: *mut c_void,
    ) -> TResult,
    pub popup: unsafe extern "system" fn(this: *mut c_void, x: i32, y: i32) -> TResult,
}

#[repr(C)]
pub struct IParameterFinderVtbl {
    pub base: FUnknownVtbl,
    pub find_parameter: unsafe extern "system" fn(
        this: *mut c_void,
        x: i32,
        y: i32,
        result_tag: *mut u32,
    ) -> TResult,
}

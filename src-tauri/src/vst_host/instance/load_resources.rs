//! ロード途中と通常終了で同じ所有・解放規則を使う。
use super::{get_vtbl, unlink_connection_points, HostAppGuard, PluginLibrary};
use crate::vst_host::c_api::{
    FUnknownVtbl, IAudioProcessorVtbl, IComponentVtbl, IEditControllerVtbl,
};
use std::ffi::c_void;
use std::sync::Arc;

pub(super) struct InterfaceRef(pub(super) *mut c_void);

impl Drop for InterfaceRef {
    fn drop(&mut self) {
        unsafe { release(self.0) };
    }
}

pub(super) unsafe fn release(pointer: *mut c_void) {
    if !pointer.is_null() {
        (get_vtbl::<FUnknownVtbl>(pointer).release)(pointer);
    }
}

pub(super) struct InstanceResources {
    pub(super) component: *mut c_void,
    pub(super) processor: *mut c_void,
    pub(super) controller: *mut c_void,
    pub(super) component_initialized: bool,
    pub(super) controller_initialized: bool,
    pub(super) component_active: bool,
    pub(super) processing: bool,
    pub(super) prepared: bool,
    pub(super) connected: bool,
    pub(super) retained: Vec<InterfaceRef>,
    pub(super) host: Option<HostAppGuard>,
    // shutdownのFFIが完了するまで、DLLを独立して保持する。
    _library: Arc<PluginLibrary>,
}

impl InstanceResources {
    pub(super) fn new(library: Arc<PluginLibrary>) -> Self {
        Self {
            component: std::ptr::null_mut(),
            processor: std::ptr::null_mut(),
            controller: std::ptr::null_mut(),
            component_initialized: false,
            controller_initialized: false,
            component_active: false,
            processing: false,
            prepared: false,
            connected: false,
            retained: Vec::new(),
            host: None,
            _library: library,
        }
    }

    pub(super) fn disconnect(&mut self) {
        if self.connected {
            unsafe { unlink_connection_points(self.component, self.controller) };
            self.connected = false;
        }
    }

    pub(super) fn shutdown(&mut self) {
        self.disconnect();
        self.stop_processing();
        unsafe {
            if self.controller_initialized {
                (get_vtbl::<IEditControllerVtbl>(self.controller).terminate)(self.controller);
                self.controller_initialized = false;
            }
            release(std::mem::replace(
                &mut self.controller,
                std::ptr::null_mut(),
            ));
            release(std::mem::replace(&mut self.processor, std::ptr::null_mut()));
            if self.component_initialized {
                (get_vtbl::<IComponentVtbl>(self.component).terminate)(self.component);
                self.component_initialized = false;
            }
            release(std::mem::replace(&mut self.component, std::ptr::null_mut()));
        }
        self.retained.clear();
        self.host.take();
    }

    pub(super) fn stop_processing(&mut self) {
        self.prepared = false;
        unsafe {
            if self.processing {
                (get_vtbl::<IAudioProcessorVtbl>(self.processor).set_processing)(self.processor, 0);
                self.processing = false;
            }
            if self.component_active {
                (get_vtbl::<IComponentVtbl>(self.component).set_active)(self.component, 0);
                self.component_active = false;
            }
        }
    }
}

impl Drop for InstanceResources {
    fn drop(&mut self) {
        self.shutdown();
    }
}

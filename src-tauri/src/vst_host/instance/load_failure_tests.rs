//! 模擬factoryを実際のロード経路へ渡し、失敗段階ごとの解放を検査する。
use super::*;
use crate::vst_host::c_api::{
    IAudioProcessorVtbl, IComponentVtbl, IEditControllerVtbl, IPluginFactoryVtbl, PFactoryInfo,
};
use vst3::Steinberg::{
    FUnknown,
    Vst::{IAudioProcessor, IComponent, IEditController},
};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Stage {
    NoClass,
    Creation,
    UnknownQuery,
    ComponentInit,
    ProcessorQuery,
    ControllerInit,
    SeparateControllerInit,
    Setup,
    Activate,
    Processing,
    Success,
    UnknownSuccess,
    Combined,
}

struct State {
    stage: Stage,
    live: usize,
    events: Vec<&'static str>,
    host: *mut c_void,
    component_identity: *mut c_void,
}

#[repr(C)]
struct Object {
    vtable: *const c_void,
    state: *mut State,
    kind: &'static str,
    refs: u32,
}

unsafe fn object(state: *mut State, kind: &'static str, vtable: *const c_void) -> *mut c_void {
    (*state).live += 1;
    Box::into_raw(Box::new(Object {
        vtable,
        state,
        kind,
        refs: 1,
    }))
    .cast()
}

unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    let object = &mut *this.cast::<Object>();
    object.refs += 1;
    object.refs
}

unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    let object = &mut *this.cast::<Object>();
    object.refs -= 1;
    let remaining = object.refs;
    if remaining == 0 {
        (*object.state).events.push(object.kind);
        (*object.state).live -= 1;
        drop(Box::from_raw(this.cast::<Object>()));
    }
    remaining
}

unsafe extern "system" fn query(this: *mut c_void, iid: *const TUID, out: *mut *mut c_void) -> i32 {
    *out = std::ptr::null_mut();
    let object = &*this.cast::<Object>();
    let state = &mut *object.state;
    if *iid == <FUnknown as Interface>::IID {
        *out = if state.stage == Stage::Combined && object.kind == "controller" {
            state.component_identity
        } else {
            this
        };
        add_ref(*out);
        return K_RESULT_OK;
    }
    if object.kind == "component" {
        if *iid == <IComponent as Interface>::IID && state.stage != Stage::UnknownQuery {
            *out = this;
            add_ref(this);
            return K_RESULT_OK;
        }
        if *iid == <IAudioProcessor as Interface>::IID {
            // 失敗時にも非nullの出力参照が渡された場合を検査する。
            *out = self::object(
                object.state,
                "processor",
                (&PROCESSOR as *const IAudioProcessorVtbl).cast(),
            );
            return if state.stage == Stage::ProcessorQuery {
                K_RESULT_FALSE
            } else {
                K_RESULT_OK
            };
        }
        if *iid == <IEditController as Interface>::IID
            && state.stage != Stage::SeparateControllerInit
        {
            *out = self::object(
                object.state,
                "controller",
                (&CONTROLLER as *const IEditControllerVtbl).cast(),
            );
            return K_RESULT_OK;
        }
    }
    K_NO_INTERFACE
}

unsafe extern "system" fn initialize(this: *mut c_void, host: *mut c_void) -> i32 {
    let object = &*this.cast::<Object>();
    let state = &mut *object.state;
    state.host = host;
    state.events.push(if object.kind == "component" {
        "component initialize"
    } else {
        "controller initialize"
    });
    if (object.kind == "component" && state.stage == Stage::ComponentInit)
        || (object.kind == "controller"
            && matches!(
                state.stage,
                Stage::ControllerInit | Stage::SeparateControllerInit
            ))
    {
        K_RESULT_FALSE
    } else if object.kind == "controller" && state.stage == Stage::Combined {
        1 // 同一COMオブジェクトの初期化済み応答
    } else {
        K_RESULT_OK
    }
}

unsafe extern "system" fn terminate(this: *mut c_void) -> i32 {
    let object = &*this.cast::<Object>();
    let state = &mut *object.state;
    // ホストコンテキストは最後のterminateまで生存する。
    let mut name = [0_u16; 128];
    (get_vtbl::<IHostApplicationVtbl>(state.host).get_name)(state.host, name.as_mut_ptr().cast());
    state.events.push(if object.kind == "component" {
        "component terminate"
    } else {
        "controller terminate"
    });
    K_RESULT_OK
}

unsafe extern "system" fn controller_id(_: *mut c_void, id: *mut TUID) -> i32 {
    *id = [1; 16];
    K_RESULT_OK
}
unsafe extern "system" fn mode(_: *mut c_void, _: i32) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn active(this: *mut c_void, enabled: i32) -> i32 {
    let state = &mut *(*this.cast::<Object>()).state;
    state.events.push(if enabled == 0 {
        "deactivate"
    } else {
        "activate"
    });
    if enabled != 0 && state.stage == Stage::Activate {
        K_RESULT_FALSE
    } else {
        K_RESULT_OK
    }
}
unsafe extern "system" fn processing(this: *mut c_void, enabled: i32) -> i32 {
    let state = &mut *(*this.cast::<Object>()).state;
    state.events.push(if enabled == 0 {
        "processing stop"
    } else {
        "processing start"
    });
    if enabled != 0 && state.stage == Stage::Processing {
        K_RESULT_FALSE
    } else {
        K_RESULT_OK
    }
}
unsafe extern "system" fn setup(this: *mut c_void, _: *mut c_void) -> i32 {
    if (*(*this.cast::<Object>()).state).stage == Stage::Setup {
        K_RESULT_FALSE
    } else {
        K_RESULT_OK
    }
}
unsafe extern "system" fn pointer(_: *mut c_void, _: *mut c_void) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn no_state(_: *mut c_void, _: *mut c_void) -> i32 {
    K_RESULT_FALSE
}
unsafe extern "system" fn count(_: *mut c_void) -> i32 {
    0
}
unsafe extern "system" fn samples(_: *mut c_void) -> u32 {
    0
}
unsafe extern "system" fn buses(_: *mut c_void, _: i32, _: i32) -> i32 {
    1
}
unsafe extern "system" fn bus_info(_: *mut c_void, _: i32, _: i32, _: i32, _: *mut c_void) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn routing(_: *mut c_void, _: *mut c_void, _: *mut c_void) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn activate_bus(_: *mut c_void, _: i32, _: i32, _: i32, _: i32) -> i32 {
    K_RESULT_OK
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
unsafe extern "system" fn param_info(_: *mut c_void, _: i32, _: *mut c_void) -> i32 {
    K_RESULT_FALSE
}
unsafe extern "system" fn param_string(_: *mut c_void, _: u32, _: f64, _: *mut c_void) -> i32 {
    K_RESULT_FALSE
}
unsafe extern "system" fn string_param(_: *mut c_void, _: u32, _: *mut c_void, _: *mut f64) -> i32 {
    K_RESULT_FALSE
}
unsafe extern "system" fn convert(_: *mut c_void, _: u32, value: f64) -> f64 {
    value
}
unsafe extern "system" fn param(_: *mut c_void, _: u32) -> f64 {
    0.0
}
unsafe extern "system" fn set_param(_: *mut c_void, _: u32, _: f64) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn view(_: *mut c_void, _: *const c_char) -> *mut c_void {
    std::ptr::null_mut()
}

const fn base() -> FUnknownVtbl {
    FUnknownVtbl {
        query_interface: query,
        add_ref,
        release,
    }
}
static COMPONENT: IComponentVtbl = IComponentVtbl {
    base: base(),
    initialize,
    terminate,
    get_controller_class_id: controller_id,
    set_io_mode: mode,
    get_bus_count: buses,
    get_bus_info: bus_info,
    get_routing_info: routing,
    activate_bus,
    set_active: active,
    set_state: pointer,
    get_state: no_state,
};
static PROCESSOR: IAudioProcessorVtbl = IAudioProcessorVtbl {
    base: base(),
    set_bus_arrangements: arrangements,
    get_bus_arrangement: arrangement,
    can_process_sample_size: mode,
    get_latency_samples: samples,
    setup_processing: setup,
    set_processing: processing,
    process: pointer,
    get_tail_samples: samples,
};
static CONTROLLER: IEditControllerVtbl = IEditControllerVtbl {
    base: base(),
    initialize,
    terminate,
    set_component_state: pointer,
    set_state: pointer,
    get_state: no_state,
    get_parameter_count: count,
    get_parameter_info: param_info,
    get_param_string_by_value: param_string,
    get_param_value_by_string: string_param,
    normalized_param_to_plain: convert,
    plain_param_to_normalized: convert,
    get_param_normalized: param,
    set_param_normalized: set_param,
    set_component_handler: pointer,
    create_view: view,
};

unsafe extern "system" fn factory_info(_: *mut c_void, _: *mut PFactoryInfo) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn classes(this: *mut c_void) -> i32 {
    if (*(*this.cast::<Object>()).state).stage == Stage::NoClass {
        0
    } else {
        1
    }
}
unsafe extern "system" fn class_info(_: *mut c_void, _: i32, info: *mut PClassInfo) -> i32 {
    for (to, from) in (*info).category.iter_mut().zip(b"Audio Module Class") {
        *to = *from as c_char;
    }
    K_RESULT_OK
}
unsafe extern "system" fn create(
    this: *mut c_void,
    _: *const TUID,
    iid: *const TUID,
    out: *mut *mut c_void,
) -> i32 {
    let state = (*this.cast::<Object>()).state;
    *out = std::ptr::null_mut();
    if (*state).stage == Stage::Creation {
        return K_RESULT_FALSE;
    }
    if *iid == <IComponent as Interface>::IID
        && matches!((*state).stage, Stage::UnknownQuery | Stage::UnknownSuccess)
    {
        return K_RESULT_FALSE;
    }
    let (kind, vtable) = if *iid == <IEditController as Interface>::IID {
        (
            "controller",
            (&CONTROLLER as *const IEditControllerVtbl).cast(),
        )
    } else {
        ("component", (&COMPONENT as *const IComponentVtbl).cast())
    };
    *out = object(state, kind, vtable);
    if kind == "component" {
        (*state).component_identity = *out;
    }
    K_RESULT_OK
}
static FACTORY: IPluginFactoryVtbl = IPluginFactoryVtbl {
    base: base(),
    get_factory_info: factory_info,
    count_classes: classes,
    get_class_info: class_info,
    create_instance: create,
};

#[test]
fn real_loader_failure_stages_release_every_acquired_reference() {
    for stage in [
        Stage::NoClass,
        Stage::Creation,
        Stage::UnknownQuery,
        Stage::ComponentInit,
        Stage::ProcessorQuery,
        Stage::ControllerInit,
        Stage::SeparateControllerInit,
        Stage::Setup,
        Stage::Activate,
        Stage::Processing,
        Stage::Success,
        Stage::UnknownSuccess,
        Stage::Combined,
    ] {
        let library = Arc::new(unsafe { PluginLibrary::load("kernel32.dll", false) }.unwrap());
        let mut state = State {
            stage,
            live: 0,
            events: Vec::new(),
            host: std::ptr::null_mut(),
            component_identity: std::ptr::null_mut(),
        };
        let factory = unsafe {
            object(
                &mut state,
                "factory",
                (&FACTORY as *const IPluginFactoryVtbl).cast(),
            )
        };
        let result = unsafe {
            VstInstance::load_from_factory(
                "mock.vst3",
                "Mock".into(),
                library.clone(),
                HMODULE(std::ptr::null_mut()),
                factory,
            )
        };
        match stage {
            Stage::Success | Stage::UnknownSuccess | Stage::Combined => {
                let mut instance = result.unwrap();
                instance.prepare_processing(48_000.0, 256, 2).unwrap();
                drop(instance);
            }
            Stage::Setup | Stage::Activate | Stage::Processing => {
                let mut instance = result.unwrap();
                assert!(instance.prepare_processing(48_000.0, 256, 2).is_err());
                assert!(instance.create_processor().is_none());
                drop(instance);
            }
            _ => assert!(result.is_err(), "{stage:?}"),
        }
        assert_eq!(state.live, 0, "{stage:?}: {:?}", state.events);
        assert_eq!(Arc::strong_count(&library), 1, "{stage:?}");
        let terminations = state
            .events
            .iter()
            .filter(|event| **event == "component terminate")
            .count();
        assert_eq!(
            terminations,
            usize::from(!matches!(
                stage,
                Stage::NoClass | Stage::Creation | Stage::UnknownQuery | Stage::ComponentInit
            )),
            "{stage:?}"
        );
        if matches!(
            stage,
            Stage::ControllerInit | Stage::SeparateControllerInit | Stage::Combined
        ) {
            assert!(!state.events.contains(&"controller terminate"), "{stage:?}");
        }
        if matches!(
            stage,
            Stage::NoClass
                | Stage::Creation
                | Stage::UnknownQuery
                | Stage::ComponentInit
                | Stage::ProcessorQuery
                | Stage::ControllerInit
                | Stage::SeparateControllerInit
        ) {
            assert_eq!(state.events.last(), Some(&"factory"), "{stage:?}");
        }
        if stage == Stage::Processing {
            assert!(state.events.contains(&"processing stop"));
        }
        if matches!(stage, Stage::Activate | Stage::Processing) {
            assert!(state.events.contains(&"deactivate"));
        }
    }
}

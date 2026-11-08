//! classId は任意項目。旧JSONは省略のまま読め、保存時も無い値は出さない。
use crate::bundle::mixing_configuration::PostMixPreset;
use crate::bundle::CapturedPlugin;
use crate::ipc::{Command, LoadedPlugin, RackPlugin, Response, RestorePluginRequest};
use crate::vst_host::presets::{LoadedPluginInstance, Preset, PresetPlugin};

const CID: &str = "0123456789ABCDEF0123456789ABCDEF";

fn plugin(class_id: Option<&str>) -> PresetPlugin {
    PresetPlugin {
        path: "unit.vst3".into(),
        name: "Unit".into(),
        vendor: "Vendor".into(),
        version: "1".into(),
        enabled: true,
        muted: false,
        gain: 1.0,
        state: Some("state".into()),
        class_id: class_id.map(str::to_string),
    }
}

#[test]
fn preset_bundle_and_post_mix_keep_optional_class_id_without_schema_bump() {
    let old: Preset =
        serde_json::from_str(r#"{"name":"old","schemaVersion":2,"plugins":[{"path":"unit.vst3","name":"Unit","vendor":"Vendor","version":"1","enabled":true,"muted":false,"gain":1.0,"state":"state"}]}"#).unwrap();
    assert_eq!(old.schema_version, 2);
    assert!(old.plugins[0].class_id.is_none());

    let mut preset = old.clone();
    preset.plugins[0].class_id = Some(CID.into());
    let json = serde_json::to_value(&preset).unwrap();
    assert_eq!(json["schemaVersion"], 2);
    assert_eq!(json["plugins"][0]["classId"], CID);
    let back: Preset = serde_json::from_value(json).unwrap();
    assert_eq!(back.plugins[0].class_id.as_deref(), Some(CID));

    let captured = CapturedPlugin {
        id: "id".into(),
        plugin: plugin(Some(CID)),
    };
    let json = serde_json::to_value(&captured).unwrap();
    assert_eq!(json["plugin"]["classId"], CID);
    assert_eq!(
        serde_json::from_value::<CapturedPlugin>(json)
            .unwrap()
            .plugin
            .class_id
            .as_deref(),
        Some(CID)
    );
    let mut legacy = serde_json::to_value(&CapturedPlugin {
        id: "id".into(),
        plugin: plugin(None),
    })
    .unwrap();
    assert!(legacy["plugin"].get("classId").is_none());
    legacy["plugin"]["classId"] = serde_json::Value::Null;
    // null は Option の None として読める。
    let read = serde_json::from_value::<CapturedPlugin>(legacy).unwrap();
    assert!(read.plugin.class_id.is_none());

    let saved = PostMixPreset {
        schema_version: 1,
        role: "post_mix".into(),
        enabled: true,
        plugins: vec![plugin(Some(CID))],
    };
    let json = serde_json::to_value(&saved).unwrap();
    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["plugins"][0]["classId"], CID);
    assert!(saved.validate().is_ok());
    let mut old_saved = json.clone();
    old_saved["plugins"][0]
        .as_object_mut()
        .unwrap()
        .remove("classId");
    let read = serde_json::from_value::<PostMixPreset>(old_saved).unwrap();
    assert!(read.plugins[0].class_id.is_none());
    assert!(read.validate().is_ok());
}

#[test]
fn restore_request_rack_and_load_command_roundtrip_class_id() {
    let request = RestorePluginRequest {
        path: "unit.vst3".into(),
        state: None,
        bypassed: false,
        muted: false,
        gain: 1.0,
        class_id: Some(CID.into()),
    };
    assert!(request.validate().is_ok());
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["classId"], CID);
    assert_eq!(
        serde_json::from_value::<RestorePluginRequest>(json)
            .unwrap()
            .class_id
            .as_deref(),
        Some(CID)
    );
    let legacy = serde_json::json!({
        "path": "unit.vst3",
        "state": null,
        "bypassed": false,
        "muted": false,
        "gain": 1.0
    });
    let old = serde_json::from_value::<RestorePluginRequest>(legacy).unwrap();
    assert!(old.class_id.is_none());
    assert!(old.validate().is_ok());
    let mut invalid = request.clone();
    invalid.class_id = Some("nope".into());
    assert!(invalid.validate().is_err());

    let rack = RackPlugin {
        id: "id".into(),
        path: "unit.vst3".into(),
        name: "Unit".into(),
        enabled: true,
        muted: false,
        gain: 1.0,
        class_id: Some(CID.into()),
        channel_layout: crate::ipc::ChannelLayout::Stereo,
    };
    let json = serde_json::to_value(&rack).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 7);
    assert_eq!(json["classId"], CID);
    let mut without = json.clone();
    without.as_object_mut().unwrap().remove("classId");
    assert!(serde_json::from_value::<RackPlugin>(without)
        .unwrap()
        .class_id
        .is_none());

    let command = Command::LoadPlugin {
        path: "unit.vst3".into(),
        class_id: Some(CID.into()),
    };
    let json = serde_json::to_value(&command).unwrap();
    assert_eq!(json["payload"]["classId"], CID);
    let back = serde_json::from_value::<Command>(json).unwrap();
    assert!(matches!(back, Command::LoadPlugin { class_id: Some(id), .. } if id == CID));
    let old = serde_json::json!({"type":"LoadPlugin","payload":{"path":"unit.vst3"}});
    assert!(matches!(
        serde_json::from_value::<Command>(old).unwrap(),
        Command::LoadPlugin { class_id: None, .. }
    ));

    let loaded = Response::PluginLoaded {
        id: "id".into(),
        name: "Unit".into(),
        vendor: String::new(),
        class_id: Some(CID.into()),
        legacy_class_ambiguous: false,
        channel_layout: crate::ipc::ChannelLayout::Stereo,
    };
    let json = serde_json::to_value(&loaded).unwrap();
    assert!(json["payload"].get("legacyClassAmbiguous").is_none());
    assert!(json["payload"].get("channelLayout").is_none());
    assert_eq!(json["payload"]["classId"], CID);
    let ambiguous = LoadedPlugin {
        id: "id".into(),
        name: "Unit".into(),
        class_id: None,
        legacy_class_ambiguous: true,
        channel_layout: crate::ipc::ChannelLayout::Mono,
    };
    let ambiguous_json = serde_json::to_value(&ambiguous).unwrap();
    assert_eq!(ambiguous_json["legacyClassAmbiguous"], true);
    assert_eq!(ambiguous_json["channelLayout"], "mono");
    let legacy_rack = serde_json::json!({
        "id": "id",
        "path": "unit.vst3",
        "name": "Unit",
        "enabled": true,
        "muted": false,
        "gain": 1.0
    });
    assert!(serde_json::from_value::<RackPlugin>(legacy_rack)
        .unwrap()
        .channel_layout
        .is_stereo());
}

#[test]
fn loaded_plugin_instance_keeps_optional_opened_class_id() {
    let old: LoadedPluginInstance = serde_json::from_str(
        r#"{"id":"1","path":"a.vst3","name":"A","vendor":"","version":"","enabled":true,"muted":false,"gain":1.0}"#,
    )
    .unwrap();
    assert!(old.class_id.is_none());
    assert!(serde_json::to_value(&old).unwrap().get("classId").is_none());
    let opened = LoadedPluginInstance {
        class_id: Some(CID.into()),
        ..old
    };
    assert_eq!(serde_json::to_value(&opened).unwrap()["classId"], CID);
}

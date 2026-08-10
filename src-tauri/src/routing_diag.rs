use serde::{Deserialize, Serialize};

/// 仮想ケーブル系デバイス名の簡易判定
pub fn is_virtual_cable_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("cable")
        || lower.contains("voicemeeter")
        || lower.contains("virtual")
        || lower.contains("vb-")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDeviceInfo {
    pub name: String,
    /// "render" | "capture"
    pub direction: String,
    pub mix_format_sample_rate_hz: Option<u32>,
    pub is_default: bool,
    pub is_default_communications: bool,
    pub is_virtual_cable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRateMismatch {
    pub device_name: String,
    pub device_rate_hz: u32,
    pub engine_rate_hz: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDiagnosticsReport {
    pub devices: Vec<RoutingDeviceInfo>,
    pub engine_sample_rate_hz: Option<u32>,
    pub sample_rate_mismatches: Vec<SampleRateMismatch>,
    pub default_comms_render_is_virtual: bool,
    pub default_comms_render_name: Option<String>,
    pub warnings: Vec<String>,
}

/// エンジンレートとデバイス一覧から不一致を検出（純粋ロジック・テスト可能）
pub fn detect_sample_rate_mismatches(
    engine_rate_hz: u32,
    devices: &[RoutingDeviceInfo],
) -> Vec<SampleRateMismatch> {
    let mut out = Vec::new();
    for dev in devices {
        if !dev.is_virtual_cable {
            continue;
        }
        if let Some(rate) = dev.mix_format_sample_rate_hz {
            if rate != engine_rate_hz {
                out.push(SampleRateMismatch {
                    device_name: dev.name.clone(),
                    device_rate_hz: rate,
                    engine_rate_hz,
                    message: format!(
                        "「{}」の Windows 共有モードは {}Hz ですが、エンジンは {}Hz です",
                        dev.name, rate, engine_rate_hz
                    ),
                });
            }
        }
    }
    out
}

#[cfg(windows)]
pub fn collect_routing_diagnostics(engine_sample_rate_hz: Option<u32>) -> RoutingDiagnosticsReport {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eRender, IAudioClient, IMMDevice,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc, PROPVARIANT,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

    let mut devices = Vec::new();
    let mut warnings = Vec::new();
    let mut default_render_name: Option<String> = None;
    let mut default_capture_name: Option<String> = None;
    let mut default_comms_render_name: Option<String> = None;

    unsafe fn device_friendly_name(device: &IMMDevice) -> Option<String> {
        let store: IPropertyStore = device.OpenPropertyStore(STGM(0)).ok()?;
        let mut prop: PROPVARIANT = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let pwstr = PropVariantToStringAlloc(&prop).ok()?;
        let name = pwstr.to_string().ok();
        CoTaskMemFree(Some(pwstr.0 as _));
        let _ = PropVariantClear(&mut prop);
        name
    }

    unsafe fn mix_format_hz(device: &IMMDevice) -> Option<u32> {
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
        let format_ptr = client.GetMixFormat().ok()?;
        if format_ptr.is_null() {
            return None;
        }
        let rate = (*format_ptr).nSamplesPerSec;
        CoTaskMemFree(Some(format_ptr as _));
        Some(rate)
    }

    unsafe fn enumerate_direction(
        enumerator: &IMMDeviceEnumerator,
        data_flow: windows::Win32::Media::Audio::EDataFlow,
        direction_label: &str,
        default_name: &Option<String>,
        default_comms_name: &Option<String>,
        out: &mut Vec<RoutingDeviceInfo>,
    ) {
        let Ok(collection) =
            enumerator.EnumAudioEndpoints(data_flow, DEVICE_STATE_ACTIVE)
        else {
            return;
        };
        let Ok(count) = collection.GetCount() else {
            return;
        };
        for i in 0..count {
            let Ok(device) = collection.Item(i) else {
                continue;
            };
            let Some(name) = device_friendly_name(&device) else {
                continue;
            };
            let rate = mix_format_hz(&device);
            let is_default = default_name.as_ref().map(|n| n == &name).unwrap_or(false);
            let is_default_communications = default_comms_name
                .as_ref()
                .map(|n| n == &name)
                .unwrap_or(false);
            out.push(RoutingDeviceInfo {
                name: name.clone(),
                direction: direction_label.to_string(),
                mix_format_sample_rate_hz: rate,
                is_default,
                is_default_communications,
                is_virtual_cable: is_virtual_cable_name(&name),
            });
        }
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = match CoCreateInstance(
            &MMDeviceEnumerator,
            None,
            CLSCTX_ALL,
        ) {
            Ok(e) => e,
            Err(_) => {
                warnings.push("Windows オーディオ列挙を初期化できませんでした".to_string());
                return RoutingDiagnosticsReport {
                    devices,
                    engine_sample_rate_hz,
                    sample_rate_mismatches: Vec::new(),
                    default_comms_render_is_virtual: false,
                    default_comms_render_name: None,
                    warnings,
                };
            }
        };

        if let Ok(dev) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            default_render_name = device_friendly_name(&dev);
        }
        if let Ok(dev) = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) {
            default_capture_name = device_friendly_name(&dev);
        }
        if let Ok(dev) = enumerator.GetDefaultAudioEndpoint(eRender, eCommunications) {
            default_comms_render_name = device_friendly_name(&dev);
        }

        enumerate_direction(
            &enumerator,
            eRender,
            "render",
            &default_render_name,
            &default_comms_render_name,
            &mut devices,
        );
        enumerate_direction(
            &enumerator,
            eCapture,
            "capture",
            &default_capture_name,
            &None,
            &mut devices,
        );
    }

    let default_comms_render_is_virtual = default_comms_render_name
        .as_ref()
        .map(|n| is_virtual_cable_name(n))
        .unwrap_or(false);

    if default_comms_render_is_virtual {
        warnings.push(
            "既定の通信デバイス（再生）が仮想ケーブルになっています。自分の耳には音が届きません"
                .to_string(),
        );
    }

    let sample_rate_mismatches = engine_sample_rate_hz
        .map(|rate| detect_sample_rate_mismatches(rate, &devices))
        .unwrap_or_default();

    if !sample_rate_mismatches.is_empty() {
        warnings.push(
            "仮想ケーブルとエンジンのサンプルレートが一致していません。Windows サウンド設定で 48000Hz に統一してください"
                .to_string(),
        );
    }

    RoutingDiagnosticsReport {
        devices,
        engine_sample_rate_hz,
        sample_rate_mismatches,
        default_comms_render_is_virtual,
        default_comms_render_name,
        warnings,
    }
}

#[cfg(not(windows))]
pub fn collect_routing_diagnostics(engine_sample_rate_hz: Option<u32>) -> RoutingDiagnosticsReport {
    RoutingDiagnosticsReport {
        devices: Vec::new(),
        engine_sample_rate_hz,
        sample_rate_mismatches: Vec::new(),
        default_comms_render_is_virtual: false,
        default_comms_render_name: None,
        warnings: vec!["ルーティング診断は Windows でのみ利用できます".to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(name: &str, rate: Option<u32>, virtual_cable: bool) -> RoutingDeviceInfo {
        RoutingDeviceInfo {
            name: name.to_string(),
            direction: "render".to_string(),
            mix_format_sample_rate_hz: rate,
            is_default: false,
            is_default_communications: false,
            is_virtual_cable: virtual_cable,
        }
    }

    #[test]
    fn virtual_cable_name_detection() {
        assert!(is_virtual_cable_name("CABLE Input (VB-Audio)"));
        assert!(is_virtual_cable_name("Voicemeeter Output"));
        assert!(!is_virtual_cable_name("Realtek HD Audio"));
    }

    #[test]
    fn mismatch_detection_for_virtual_cable() {
        let devices = vec![
            dev("CABLE Input", Some(44_100), true),
            dev("Speakers", Some(48_000), false),
        ];
        let mismatches = detect_sample_rate_mismatches(48_000, &devices);
        assert_eq!(mismatches.len(), 1);
        assert_eq!(mismatches[0].device_rate_hz, 44_100);
    }

    #[test]
    fn no_mismatch_when_rates_match() {
        let devices = vec![dev("CABLE Input", Some(48_000), true)];
        let mismatches = detect_sample_rate_mismatches(48_000, &devices);
        assert!(mismatches.is_empty());
    }
}

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[cfg(target_os = "windows")]
#[link(name = "advapi32")]
extern "C" {}
#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "C" {}
#[cfg(target_os = "windows")]
#[link(name = "ole32")]
extern "C" {}

#[derive(Serialize)]
struct AsioDevice {
    name: String,
    // simplistic structure: just names.
    // IsInput/Output distinction for ASIO is often "Same Device",
    // but cpal iterates inputs and outputs separately.
    is_input: bool,
}

#[allow(deprecated)]
fn main() {
    // Disable logging to stdout to ensure clean JSON
    let _ = env_logger::Builder::new()
        .target(env_logger::Target::Stderr)
        .filter_level(log::LevelFilter::Error)
        .try_init();

    let mut devices = Vec::new();

    // Explicitly check ASIO host
    if let Ok(host) = cpal::host_from_id(cpal::HostId::Asio) {
        // Collect Inputs
        if let Ok(input_devs) = host.input_devices() {
            for d in input_devs {
                if let Ok(n) = d.name() {
                    devices.push(AsioDevice {
                        name: n,
                        is_input: true,
                    });
                }
            }
        }
        // Collect Outputs
        if let Ok(output_devs) = host.output_devices() {
            for d in output_devs {
                if let Ok(n) = d.name() {
                    devices.push(AsioDevice {
                        name: n,
                        is_input: false,
                    });
                }
            }
        }
    }

    // Output JSON to stdout
    let json = serde_json::to_string(&devices).unwrap_or(String::from("[]"));
    println!("{}", json);
}

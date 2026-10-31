// 同名のWASAPI再生先だけを照会する。再生・既定変更は行わない。
use cpal::traits::{DeviceTrait, HostTrait};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    for device in host.output_devices()? {
        let name = device.description()?.name().to_string();
        if name != "Voicemeeter Input" && name != "Voicemeeter AUX Input" && name != "CABLE Input" {
            continue;
        }
        let default = device.default_output_config()?;
        println!(
            "endpoint={name} default_channels={} default_rate={} format={:?}",
            default.channels(),
            default.sample_rate(),
            default.sample_format()
        );
        let configs = device.supported_output_configs()?;
        for config in configs.filter(|c| c.channels() >= 4) {
            println!(
                "channels={} rates={}-{} format={:?}",
                config.channels(),
                config.min_sample_rate(),
                config.max_sample_rate(),
                config.sample_format()
            );
        }
    }
    Ok(())
}

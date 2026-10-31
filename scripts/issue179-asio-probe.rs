// 選択済みASIOドライバーのみ初期化し、既定構成を取得する。ストリームは作らない。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = cpal::host_from_id(cpal::HostId::Asio)?;
    let cpal::platform::HostInner::Asio(asio) = host.as_inner() else {
        return Err("ASIO host unavailable".into());
    };
    let device = asio
        .device_by_name("Voicemeeter Insert Virtual ASIO")
        .ok_or("selected ASIO driver unavailable")?;
    let input = device.default_input_config()?;
    let output = device.default_output_config()?;
    println!("driver=Voicemeeter Insert Virtual ASIO");
    println!(
        "input_channels={} input_rate={} input_format={:?} input_buffer={:?}",
        input.channels(),
        input.sample_rate(),
        input.sample_format(),
        input.buffer_size()
    );
    println!(
        "output_channels={} output_rate={} output_format={:?} output_buffer={:?}",
        output.channels(),
        output.sample_rate(),
        output.sample_format(),
        output.buffer_size()
    );
    Ok(())
}

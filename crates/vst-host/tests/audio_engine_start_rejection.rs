//! K6（子の側）：範囲外の`initial_controls`は、デバイスを開く前に`Response::Error`で拒まれ、`Stopped`は出ない。
//! 実際の`audio_engine`サイドカーを起動し、標準入力へ`Start`を1行送って、標準出力の行を読む。
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command as Process, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use vst_host_lib::ipc::{Command, OutputRouting, StartControls};

struct Sidecar(Child);

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_with(controls: StartControls) -> Command {
    Command::Start {
        input_source: None,
        host: "WASAPI".into(),
        input: None,
        output: None,
        input_id: None,
        output_id: None,
        buffer_size: Some(512),
        sample_rate: Some(48000),
        initial_controls: Some(controls),
        channel_routing: None,
    }
}

#[test]
fn the_sidecar_rejects_out_of_range_initial_controls_before_any_stopped_event() {
    let mut child = Process::new(env!("CARGO_BIN_EXE_audio_engine"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("audio_engine を起動できる");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let _guard = Sidecar(child);
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("IPC:") {
                if let Ok(value) = serde_json::from_str(json) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let bad = StartControls {
        input_gain: 0.5,
        output_gain: 3.0,
        input_channels: [0, 1],
        output_routing: OutputRouting::default(),
        muted: false,
        bypassed: false,
    };
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&start_with(bad)).unwrap()
    )
    .unwrap();
    stdin.flush().unwrap();

    let next_response = |what: &str| {
        let mut events = Vec::new();
        loop {
            let message = rx
                .recv_timeout(Duration::from_secs(30))
                .unwrap_or_else(|_| panic!("サイドカーが{what}に応答しなかった"));
            if message["kind"] == "Response" {
                return (message, events);
            }
            events.push(message);
        }
    };
    let (response, before_response) = next_response("Start");
    assert_eq!(response["data"]["type"], "Error", "{response}");
    assert_eq!(response["data"]["payload"], "初期音量が範囲外です");

    // `Error` の直後に `Stopped` が来る誤りを捕まえるため、副作用のない命令の応答までを見る。
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&Command::StartIdentityCapability).unwrap()
    )
    .unwrap();
    stdin.flush().unwrap();
    let (probe, after_response) = next_response("状態の問い合わせ");
    assert_eq!(probe["data"]["type"], "StartIdentityCapability", "{probe}");

    for (label, events) in [
        ("拒否の前", &before_response),
        ("拒否の後", &after_response),
    ] {
        for forbidden in ["Stopped", "Started"] {
            assert!(
                !events
                    .iter()
                    .any(|message| message["data"]["type"] == forbidden),
                "{label}に {forbidden} を出さない: {events:?}"
            );
        }
    }
}

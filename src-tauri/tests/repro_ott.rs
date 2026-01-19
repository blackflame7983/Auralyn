use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use vst_host_lib::ipc::{Command as IpcCommand, OutputMessage, Response};

#[test]
fn test_ott_editor_loading() {
    let bin_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/audio_engine.exe");
    if !bin_path.exists() {
        panic!("Audio Engine binary not found. Please run `cargo build` first.");
    }

    let mut child = Command::new(&bin_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Failed to spawn audio_engine");

    let mut stdin = child.stdin.take().expect("Failed to open stdin");
    let stdout = child.stdout.take().expect("Failed to open stdout");
    let mut reader = BufReader::new(stdout);

    let send_command = |stdin: &mut std::process::ChildStdin, cmd: IpcCommand| {
        let json = serde_json::to_string(&cmd).unwrap();
        writeln!(stdin, "{}", json).expect("Failed to write to stdin");
    };

    let mut read_response = || -> Option<Response> {
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).ok()? == 0 {
                return None;
            }
            let trim = line.trim();
            if trim.is_empty() {
                continue;
            }
            println!("[Log] {}", trim); // Print all logs to test output

            if let Ok(msg) = serde_json::from_str::<OutputMessage>(trim) {
                if let OutputMessage::Response(r) = msg {
                    return Some(r);
                }
            }
        }
    };

    // 1. Get Devices (Init)
    send_command(&mut stdin, IpcCommand::GetDevices);
    read_response();

    // 2. Start Audio (Dummy)
    // We assume default devices or just fail gracefully, we primarily want to test Plugin Loading.
    // Actually, we don't strictly need audio started to load a plugin, but it's safer.
    // For this test, we skip start and go straight to AddPlugin?
    // Engine might need to be running.
    // Let's try starting with "Wasapi".
    send_command(
        &mut stdin,
        IpcCommand::Start {
            host: "Wasapi".to_string(),
            input: None,
            output: None,
            buffer_size: None,
            sample_rate: None,
        },
    );
    read_response();

    // 3. Load specific plugin
    let ott_path = "C:\\Program Files\\Common Files\\VST3\\OTT.vst3";

    send_command(
        &mut stdin,
        IpcCommand::LoadPlugin {
            path: ott_path.to_string(),
        },
    );

    let mut plugin_id = String::new();
    if let Some(resp) = read_response() {
        if let Response::PluginLoaded { id, .. } = resp {
            println!("OTT Plugin Loaded: {}", id);
            plugin_id = id;
        } else {
            println!("Failed to load OTT: {:?}", resp);
        }
    }

    if !plugin_id.is_empty() {
        // 4. Open Editor
        println!("Attempting to open editor for {}", plugin_id);
        send_command(
            &mut stdin,
            IpcCommand::OpenEditor {
                id: plugin_id.clone(),
            },
        );

        // We expect "Success" response, but crucially we want to see the stdout logs about sizing.
        let resp = read_response();
        println!("Open Editor Response: {:?}", resp);

        // Wait a bit to let logs flush
        thread::sleep(Duration::from_secs(2));
    }

    // 5. Cleanup
    send_command(&mut stdin, IpcCommand::Stop);
    read_response();
}

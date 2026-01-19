use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

// Reuse types from lib if they are public, or redefine minimal ones for test to decouple.
// Since 'vst_host_lib' exposes them, we can use them!
use vst_host_lib::ipc::{Command as IpcCommand, OutputMessage, Response};

#[test]
fn test_audio_engine_lifecycle() {
    // 1. Locate the binary
    // Cargo manifest dir is src-tauri.
    // Target dir is usually src-tauri/target/debug
    let bin_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/audio_engine.exe");

    // Note: When running 'cargo test', the CWD is the package root (src-tauri).

    // Check if binary exists (it must be built first!)
    // If not found, panic with helpful message.
    if !bin_path.exists() {
        // Fallback or just build it?
        // Better to fail and ask user to build.
        // Actually, if we run 'cargo test', it builds the lib. Does it build the bin 'audio_engine' defined in 'bin/audio_engine/main.rs'?
        // The [bin] target is part of the workspace/package. Cargo SHOULD build it.
        // Let's assume it does.
        // On Windows it has .exe extension.
    }

    // 2. Spawn Process
    let mut child = Command::new(&bin_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // See errors in test output
        .spawn()
        .expect("Failed to spawn audio_engine. MUST be built first with `cargo build`.");

    let mut stdin = child.stdin.take().expect("Failed to open stdin");
    let stdout = child.stdout.take().expect("Failed to open stdout");
    let mut reader = BufReader::new(stdout);

    // 3. Helper to send command
    let send_command = |stdin: &mut std::process::ChildStdin, cmd: IpcCommand| {
        let json = serde_json::to_string(&cmd).unwrap();
        writeln!(stdin, "{}", json).expect("Failed to write to stdin");
    };

    // 4. Helper to read response
    let mut read_response = || -> Option<Response> {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => return None, // EOF
                Ok(_) => {
                    let trim = line.trim();
                    if trim.is_empty() {
                        continue;
                    }
                    // Try parsing as OutputMessage
                    if let Ok(msg) = serde_json::from_str::<OutputMessage>(trim) {
                        match msg {
                            OutputMessage::Response(r) => return Some(r),
                            OutputMessage::Event(_) => {
                                // Ignore events like Log/LevelMeter for checking command success
                                // print!("Event: {}\n", trim);
                            }
                        }
                    } else {
                        // println!("Non-JSON output: {}", trim);
                    }
                }
                Err(_) => return None,
            }
        }
    };

    // --- TEST STEPS ---

    // A. Verify Initial Log or just Wait a bit
    thread::sleep(Duration::from_millis(500));

    // B. Get Devices
    send_command(&mut stdin, IpcCommand::GetDevices);
    match read_response() {
        Some(Response::Devices(devs)) => {
            println!("Got {} devices", devs.len());
            assert!(
                !devs.is_empty(),
                "Should find at least dummy/system devices"
            );
        }
        r => panic!("Expected Devices response, got {:?}", r),
    }

    // C. Reorder (Stability Check with empty list)
    send_command(&mut stdin, IpcCommand::ReorderPlugins { order: vec![] });
    match read_response() {
        Some(Response::Success) => println!("ReorderPlugins (Empty) Success"),
        r => panic!("Expected Success for Reorder, got {:?}", r),
    }

    // D. Start Audio (Simulated failure or success depending on devices)
    // We try to start with "Wasapi".
    // Note: This might fail on CI if no audio device. We accept Error too, as long as it doesn't crash.
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

    // Read response (could be Success or Error)
    let resp = read_response();
    println!("Start Audio Response: {:?}", resp);
    assert!(
        matches!(resp, Some(Response::Success) | Some(Response::Error(_))),
        "Process crashed or invalid response"
    );

    // E. Stop Audio
    send_command(&mut stdin, IpcCommand::Stop);
    let resp_stop = read_response();
    println!("Stop Audio Response: {:?}", resp_stop);
    assert!(
        matches!(resp_stop, Some(Response::Success)),
        "Full Stop failed"
    );

    // F. Clean Exit
    // Drop stdin to close pipe, process should exit?
    // Our loop breaks on stdin close?
    // "match handle.read_line ... Ok(0) => break" -> Yes.
    drop(stdin);

    let status = child.wait().expect("Failed to wait on child");
    assert!(status.success(), "Audio Engine exited with error");
}

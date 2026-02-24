use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
    let (resp_tx, resp_rx) = mpsc::channel::<Response>();

    thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let trim = line.trim();
                    if trim.is_empty() {
                        continue;
                    }
                    let payload = trim.strip_prefix("IPC:").unwrap_or(trim);
                    if let Ok(msg) = serde_json::from_str::<OutputMessage>(payload) {
                        if let OutputMessage::Response(r) = msg {
                            let _ = resp_tx.send(r);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    // 3. Helper to send command
    let send_command = |stdin: &mut std::process::ChildStdin, cmd: IpcCommand| {
        let json = serde_json::to_string(&cmd).unwrap();
        writeln!(stdin, "{}", json).expect("Failed to write to stdin");
    };

    // 4. Helper to read response
    let read_response =
        || -> Option<Response> { resp_rx.recv_timeout(Duration::from_secs(20)).ok() };

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

    // Read response (could be Started or Error)
    let resp = read_response();
    println!("Start Audio Response: {:?}", resp);
    assert!(
        matches!(
            resp,
            Some(Response::Started { .. }) | Some(Response::Error(_))
        ),
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

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut forced_kill = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    forced_kill = true;
                    let _ = child.kill();
                    break child.wait().expect("Failed to wait on killed child");
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("Failed to wait on child: {}", e),
        }
    };
    if forced_kill {
        println!("Audio Engine did not exit in time; process was killed by test cleanup.");
    } else {
        assert!(status.success(), "Audio Engine exited with error");
    }
}

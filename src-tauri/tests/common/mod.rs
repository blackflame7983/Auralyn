use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use assert_cmd::cargo::CommandCargoExt;
use vst_host_lib::ipc::{Command as IpcCommand, EngineEvent, OutputMessage, Response};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct EngineProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    messages: Receiver<Result<OutputMessage, String>>,
    reader: Option<JoinHandle<()>>,
    events: Vec<EngineEvent>,
}

impl EngineProcess {
    pub fn spawn() -> Self {
        let mut child = Command::cargo_bin("audio_engine")
            .expect("cargo がビルドした audio_engine が見つかりません")
            .env("AURALYN_DISABLE_PERF_TWEAKS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("audio_engine を起動できません");
        let stdin = child.stdin.take().expect("stdin がありません");
        let stdout = child.stdout.take().expect("stdout がありません");
        let (tx, messages) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        let _ = tx.send(Err(format!("stdout read: {error}")));
                        break;
                    }
                };
                // プラグイン等が出力する通常ログと IPC を区別する。
                if let Some(payload) = line.strip_prefix("IPC:") {
                    let message = serde_json::from_str(payload)
                        .map_err(|error| format!("invalid IPC message {payload:?}: {error}"));
                    if tx.send(message).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            messages,
            reader: Some(reader),
            events: Vec::new(),
        }
    }

    fn next_message(&self, deadline: Instant) -> OutputMessage {
        self.messages
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("IPC 応答がタイムアウトしたか、stdout が閉じました")
            .expect("IPC メッセージの読み取りに失敗しました")
    }

    pub fn request(&mut self, command: IpcCommand) -> Response {
        let stdin = self.stdin.as_mut().expect("stdin は閉じられています");
        writeln!(
            stdin,
            "{}",
            serde_json::to_string(&command).expect("command serialize")
        )
        .expect("IPC コマンド送信に失敗しました");
        stdin.flush().expect("IPC コマンド flush に失敗しました");
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            match self.next_message(deadline) {
                OutputMessage::Response(response) => return response,
                OutputMessage::Event(EngineEvent::Error(error)) => {
                    panic!("engine error event: {error}")
                }
                OutputMessage::Event(event) => self.events.push(event),
            }
        }
    }

    #[allow(
        dead_code,
        reason = "録音を使わない OTT テストでも共通 helper をコンパイルするため"
    )]
    pub fn wait_for_recording(&mut self) {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            if self.events.iter().any(|event| matches!(event,
                EngineEvent::VoiceCheckState { state, duration_ms, .. } if state == "ready" && *duration_ms > 0)) {
                return;
            }
            match self.next_message(deadline) {
                OutputMessage::Event(EngineEvent::Error(error)) => {
                    panic!("engine error event: {error}")
                }
                OutputMessage::Event(event) => self.events.push(event),
                OutputMessage::Response(response) => panic!("unexpected response: {response:?}"),
            }
        }
    }

    pub fn finish(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + EXIT_TIMEOUT;
        let status = loop {
            if let Some(status) = self.child.try_wait().expect("process wait failed") {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "audio_engine did not exit after EOF"
            );
            thread::sleep(Duration::from_millis(25));
        };
        assert!(status.success(), "audio_engine exited with {status}");
        self.reader
            .take()
            .expect("reader missing")
            .join()
            .expect("reader panicked");
        for message in self.messages.try_iter() {
            match message.expect("invalid IPC message") {
                OutputMessage::Response(response) => panic!("unexpected response: {response:?}"),
                OutputMessage::Event(EngineEvent::Error(error)) => {
                    panic!("engine error event: {error}")
                }
                OutputMessage::Event(_) => {}
            }
        }
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if matches!(self.child.try_wait(), Ok(None) | Err(_)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

//! 隔離した検出プロセスの寿命と出力回収。子の終了前から両パイプを読み続ける。
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn drain(mut input: impl Read) -> io::Result<Vec<u8>> {
    const LIMIT: usize = 4 * 1024 * 1024;
    let mut output = Vec::new();
    let mut block = [0_u8; 8192];
    let mut overflow = false;
    loop {
        let count = match input.read(&mut block) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if count == 0 {
            break;
        }
        let keep = count.min(LIMIT - output.len());
        output.extend_from_slice(&block[..keep]);
        overflow |= keep != count;
    }
    if overflow {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "scan process output limit exceeded",
        ));
    }
    Ok(output)
}

pub(crate) fn run(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    #[cfg(windows)]
    let job = {
        use std::os::windows::io::AsRawHandle;
        let job = crate::process_job::Job::new_kill_on_drop();
        if let Some(ref job) = job {
            let _ = job.assign(windows::Win32::Foundation::HANDLE(child.as_raw_handle()));
        }
        job
    };
    // Stdio::pipedで生成した直後なので、両ハンドルは必ず存在する。
    let stdout = child.stdout.take().expect("piped scanner stdout");
    let stderr = child.stderr.take().expect("piped scanner stderr");
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = stdout_tx.send(drain(stdout));
    });
    thread::spawn(move || {
        let _ = stderr_tx.send(drain(stderr));
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                break Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "scan process timeout",
                ))
            }
            Err(error) => break Err(error),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // パイプを継承した子孫も終了させてからreaderを回収する。
    #[cfg(windows)]
    drop(job);
    // Jobへの割当ができず子孫がパイプを保持しても、ホスト側を無期限に待たせない。
    let stdout = stdout_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "scanner stdout did not close"));
    let stderr = stderr_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "scanner stderr did not close"));
    Ok(Output {
        status: status?,
        stdout: stdout??,
        stderr: stderr??,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn helper(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let name = format!(
            "{}::scanner_process_helper",
            module_path!().split_once("::").unwrap().1
        );
        command.args(["--exact", &name, "--nocapture"]);
        command.env("AURALYN_SCANNER_TEST_HELPER", mode);
        command
    }

    #[test]
    fn scanner_process_helper() {
        match std::env::var("AURALYN_SCANNER_TEST_HELPER").as_deref() {
            Ok("large") => {
                std::io::stdout()
                    .write_all(&vec![b'o'; 256 * 1024])
                    .unwrap();
                std::io::stderr()
                    .write_all(&vec![b'e'; 256 * 1024])
                    .unwrap();
            }
            Ok("hang") => thread::sleep(Duration::from_secs(5)),
            _ => {}
        }
    }

    #[test]
    fn drains_both_pipes_before_child_exit() {
        let output = run(&mut helper("large"), Duration::from_secs(10)).unwrap();
        assert!(output.status.success());
        assert!(output.stdout.len() >= 256 * 1024);
        assert!(output.stderr.len() >= 256 * 1024);
    }

    #[test]
    fn hung_scanner_is_killed_and_reaped() {
        let error = run(&mut helper("hang"), Duration::from_millis(50)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn oversized_output_is_drained_but_not_retained_without_bound() {
        let bytes = vec![0; 4 * 1024 * 1024 + 1];
        assert_eq!(
            drain(bytes.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}

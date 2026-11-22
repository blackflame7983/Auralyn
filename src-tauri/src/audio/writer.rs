//! 子の stdin への書き込みを、接続ごとの1本のスレッドへ集める。
//!
//! 書き込みの待ちでホストのロックを止めないための部品。`BufWriter` の持ち主はこのスレッドだけ。
//! 列の容量は1で、送る側はブロックしない。閉じた接続では書き込みを始めない。
use super::link::LinkState;
use crate::ipc::Command;
use std::io::{BufWriter, Write};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

/// 通常の命令が書き込みの完了を待つ上限（C2）。
const WRITE_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);
/// 応答の期限。書き込みが戻った時刻から数える。F1b-0a-1 では今の10秒のまま。
const REPLY_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(test)]
thread_local! {
    static LIMITS: std::cell::Cell<(Option<std::time::Duration>, Option<std::time::Duration>)> =
        const { std::cell::Cell::new((None, None)) };
}

pub(super) fn write_limit() -> std::time::Duration {
    #[cfg(test)]
    if let Some(limit) = LIMITS.with(|limits| limits.get().0) {
        return limit;
    }
    WRITE_LIMIT
}

pub(super) fn reply_limit() -> std::time::Duration {
    #[cfg(test)]
    if let Some(limit) = LIMITS.with(|limits| limits.get().1) {
        return limit;
    }
    REPLY_LIMIT
}

/// 試験のスレッドだけで、期限を短くする。
#[cfg(test)]
pub(super) fn set_limits_for_test(
    write: Option<std::time::Duration>,
    reply: Option<std::time::Duration>,
) {
    LIMITS.with(|limits| limits.set((write, reply)));
}

pub(super) enum Payload {
    Json(String),
    /// JSON 化も writer のスレッドで行う（大きい VST の状態をホストのロックの外で扱う）。
    Command(Box<Command>),
}

pub(super) enum WriteResult {
    Ok,
    /// 実際の書き込みの失敗。
    Err(std::io::Error),
    /// 接続が閉じていたので、書き込みを始めなかった。
    Aborted,
}

pub(super) struct WriteDone {
    pub(super) result: WriteResult,
    /// 書き込み・`flush` が戻った時刻。応答の期限はここから数える。
    pub(super) flushed_at: Instant,
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(super) struct Probe {
    pub(super) serialized: Arc<std::sync::atomic::AtomicBool>,
    pub(super) finished: Arc<std::sync::atomic::AtomicBool>,
}

struct Job {
    payload: Payload,
    done: mpsc::Sender<WriteDone>,
    #[cfg(test)]
    probe: Option<Probe>,
}

impl Job {
    fn new(payload: Payload) -> (Self, mpsc::Receiver<WriteDone>) {
        let (done, receiver) = mpsc::channel();
        let job = Self {
            payload,
            done,
            #[cfg(test)]
            probe: None,
        };
        (job, receiver)
    }
}

pub(super) struct Writer {
    queue: mpsc::SyncSender<Job>,
}

impl Writer {
    pub(super) fn start<W: Write + Send + 'static>(sink: W, link: Arc<LinkState>) -> Self {
        let (queue, jobs) = mpsc::sync_channel::<Job>(1);
        let mut sink = BufWriter::new(sink);
        // 起動に失敗すると、受け側が捨てられて、送るときに書き込みの失敗になる。
        let _ = std::thread::Builder::new()
            .name("auralyn-engine-writer".into())
            .spawn(move || {
                while let Ok(job) = jobs.recv() {
                    let done = run(&mut sink, &link, &job);
                    let _ = job.done.send(done);
                }
            });
        Self { queue }
    }

    /// 列へ送る。満杯・切断は書き込みの失敗。書き込みの結果は `WriteDone` で受け取る。
    pub(super) fn submit(&self, payload: Payload) -> std::io::Result<mpsc::Receiver<WriteDone>> {
        let (job, receiver) = Job::new(payload);
        self.send(job)?;
        Ok(receiver)
    }

    #[cfg(test)]
    pub(super) fn submit_probed(
        &self,
        payload: Payload,
        probe: Probe,
    ) -> std::io::Result<mpsc::Receiver<WriteDone>> {
        let (mut job, receiver) = Job::new(payload);
        job.probe = Some(probe);
        self.send(job)?;
        Ok(receiver)
    }
    fn send(&self, job: Job) -> std::io::Result<()> {
        self.queue.try_send(job).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => {
                std::io::Error::new(std::io::ErrorKind::WouldBlock, "Write queue is full")
            }
            mpsc::TrySendError::Disconnected(_) => {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Stdin not available")
            }
        })
    }
}

fn run<W: Write>(sink: &mut BufWriter<W>, link: &LinkState, job: &Job) -> WriteDone {
    let result = if link.is_open() {
        let written = write_payload(sink, &job.payload, job);
        match written {
            Ok(()) => WriteResult::Ok,
            Err(error) => WriteResult::Err(error),
        }
    } else {
        WriteResult::Aborted
    };
    #[cfg(test)]
    if let Some(probe) = &job.probe {
        probe
            .finished
            .store(true, std::sync::atomic::Ordering::Release);
    }
    WriteDone {
        result,
        flushed_at: Instant::now(),
    }
}

fn write_payload<W: Write>(
    sink: &mut BufWriter<W>,
    payload: &Payload,
    _job: &Job,
) -> std::io::Result<()> {
    let json = match payload {
        Payload::Json(json) => std::borrow::Cow::Borrowed(json.as_str()),
        Payload::Command(command) => std::borrow::Cow::Owned(
            serde_json::to_string(command.as_ref()).map_err(std::io::Error::other)?,
        ),
    };
    #[cfg(test)]
    if let Some(probe) = &_job.probe {
        probe
            .serialized
            .store(true, std::sync::atomic::Ordering::Release);
    }
    writeln!(sink, "{json}").and_then(|()| sink.flush())
}

/// 試験用の出力先。書かれた内容の記録、門が開くまで戻らない書き込み、失敗する書き込み。
#[cfg(test)]
pub(super) mod sinks {
    use std::io::Write;
    use std::sync::{Arc, Condvar, Mutex};

    /// 書かれた内容を記録する。
    #[derive(Clone, Default)]
    pub(crate) struct Recording {
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl Recording {
        pub(crate) fn text(&self) -> String {
            String::from_utf8_lossy(&self.written.lock().unwrap()).into_owned()
        }
    }

    impl Write for Recording {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.written.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 門が開くまで `write` が戻らない（書き込みが詰まった子の stdin）。
    #[derive(Clone, Default)]
    pub(crate) struct Gated {
        open: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Gated {
        pub(crate) fn open(&self) {
            let (flag, signal) = &*self.open;
            *flag.lock().unwrap() = true;
            signal.notify_all();
        }
    }

    impl Write for Gated {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let (flag, signal) = &*self.open;
            let mut open = flag.lock().unwrap();
            while !*open {
                open = signal.wait(open).unwrap();
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 書き込みが必ず失敗する。
    pub(crate) struct Failing(pub(crate) &'static str);

    impl Write for Failing {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, self.0))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sinks::{Failing, Gated, Recording};
    use super::*;
    use std::time::Duration;

    fn done(receiver: &mpsc::Receiver<WriteDone>) -> WriteDone {
        receiver.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    #[test]
    fn a_line_is_written_and_flushed_in_order() {
        let sink = Recording::default();
        let writer = Writer::start(sink.clone(), Arc::new(LinkState::open()));
        for text in ["a", "b", "c"] {
            let receiver = writer.submit(Payload::Json(text.into())).unwrap();
            assert!(matches!(done(&receiver).result, WriteResult::Ok));
        }
        assert_eq!(sink.text(), "a\nb\nc\n");
    }

    #[test]
    fn a_closed_link_aborts_without_writing() {
        let sink = Recording::default();
        let link = Arc::new(LinkState::open());
        let writer = Writer::start(sink.clone(), link.clone());
        link.close(super::super::link::CloseCause::Eof);
        let receiver = writer.submit(Payload::Json("late".into())).unwrap();
        assert!(matches!(done(&receiver).result, WriteResult::Aborted));
        assert!(sink.text().is_empty());
    }

    #[test]
    fn the_queue_holds_one_job_and_a_full_queue_fails_without_blocking() {
        let gate = Gated::default();
        let writer = Writer::start(gate.clone(), Arc::new(LinkState::open()));
        let first = writer.submit(Payload::Json("first".into())).unwrap();
        // 書き込みスレッドが first を取り出すまで待つ。
        let started = Instant::now();
        let second = loop {
            match writer.submit(Payload::Json("second".into())) {
                Ok(receiver) => break receiver,
                Err(_) if started.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => panic!("{error}"),
            }
        };
        let before = Instant::now();
        let error = writer
            .submit(Payload::Json("third".into()))
            .expect_err("満杯");
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        assert!(
            before.elapsed() < Duration::from_millis(500),
            "ブロックしない"
        );
        assert!(first.try_recv().is_err());
        gate.open();
        assert!(matches!(done(&first).result, WriteResult::Ok));
        assert!(matches!(done(&second).result, WriteResult::Ok));
    }

    #[test]
    fn a_write_error_is_reported_with_the_original_error() {
        let writer = Writer::start(Failing("pipe gone"), Arc::new(LinkState::open()));
        let receiver = writer.submit(Payload::Json("x".into())).unwrap();
        match done(&receiver).result {
            WriteResult::Err(error) => assert!(error.to_string().contains("pipe gone")),
            _ => panic!("書き込みの失敗のはず"),
        }
    }

    #[test]
    fn submitting_after_the_writer_thread_ended_fails() {
        let (queue, jobs) = mpsc::sync_channel::<Job>(1);
        drop(jobs);
        let writer = Writer { queue };
        let error = writer.submit(Payload::Json("x".into())).expect_err("切断");
        assert!(error.to_string().contains("Stdin not available"));
    }

    #[test]
    fn flushed_at_is_taken_after_the_write_returns() {
        let writer = Writer::start(Recording::default(), Arc::new(LinkState::open()));
        let before = Instant::now();
        let receiver = writer.submit(Payload::Json("x".into())).unwrap();
        let finished = done(&receiver);
        assert!(finished.flushed_at >= before);
    }

    #[test]
    fn a_command_payload_is_serialized_by_the_writer_thread() {
        let sink = Recording::default();
        let writer = Writer::start(sink.clone(), Arc::new(LinkState::open()));
        let receiver = writer
            .submit(Payload::Command(Box::new(Command::GetDevices)))
            .unwrap();
        assert!(matches!(done(&receiver).result, WriteResult::Ok));
        let value: serde_json::Value = serde_json::from_str(sink.text().trim()).unwrap();
        assert_eq!(value["type"], "GetDevices");
    }
}

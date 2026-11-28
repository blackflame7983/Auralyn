//! 子の stdin への書き込みを、接続ごとの1本のスレッドへ集める。
//!
//! 書き込みの待ちでホストのロックを止めないための部品。`BufWriter` の持ち主はこのスレッドだけ。
//! 列の容量は1で、送る側はブロックしない。閉じた接続では書き込みを始めない。
use super::link::LinkCell;
use crate::ipc::Command;
use std::io::{BufWriter, Write};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

/// 通常の命令が書き込みの完了を待つ上限（C2）。
const WRITE_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

/// 応答の期限切れが EOF に負けたとき、reader の通知の列を待つ上限。
const EOF_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(test)]
thread_local! {
    static LIMITS: std::cell::Cell<(Option<std::time::Duration>, Option<std::time::Duration>)> =
        const { std::cell::Cell::new((None, None)) };
    static EOF_WAIT_OVERRIDE: std::cell::Cell<Option<std::time::Duration>> =
        const { std::cell::Cell::new(None) };
}

pub(super) fn eof_wait() -> std::time::Duration {
    #[cfg(test)]
    if let Some(limit) = EOF_WAIT_OVERRIDE.with(|limit| limit.get()) {
        return limit;
    }
    EOF_WAIT
}

/// 試験のスレッドだけで、EOF の通知を待つ上限を変える。
#[cfg(test)]
pub(super) fn set_eof_wait_for_test(limit: Option<std::time::Duration>) {
    EOF_WAIT_OVERRIDE.with(|slot| slot.set(limit));
}

pub(super) fn write_limit() -> std::time::Duration {
    #[cfg(test)]
    if let Some(limit) = LIMITS.with(|limits| limits.get().0) {
        return limit;
    }
    WRITE_LIMIT
}

/// 応答の期限。書き込みが戻った時刻（モード VST は送った時点）から数える。命令の種類で決まる。
pub(super) fn reply_limit(command: &Command) -> std::time::Duration {
    #[cfg(test)]
    if let Some(limit) = LIMITS.with(|limits| limits.get().1) {
        return limit;
    }
    super::deadline::reply_deadline(command)
}

/// 試験のスレッドだけで、期限を短くする。応答の期限は、命令の種類によらず指定の値になる。
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
    /// 真の間、`mark_sent` の直前で止まる（試験の継ぎ目）。
    pub(super) hold_before_mark_sent: Arc<std::sync::atomic::AtomicBool>,
    /// `mark_sent` の直前に着いた。
    pub(super) before_mark_sent: Arc<std::sync::atomic::AtomicBool>,
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

/// 試験の継ぎ目：次に作る writer の出力先を差し替える（試験のスレッドごと）。本来の stdin は持ち続け、
/// 子の stdin を閉じて子を終わらせない。
#[cfg(test)]
pub(super) enum SinkOverride {
    Fail,
    Stall(sinks::Gated),
}

#[cfg(test)]
thread_local! {
    static NEXT_SINK: std::cell::RefCell<Option<SinkOverride>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn override_next_sink_for_test(value: SinkOverride) {
    NEXT_SINK.with(|slot| *slot.borrow_mut() = Some(value));
}

#[cfg(test)]
struct Held<W> {
    _keep: W,
    via: Box<dyn Write + Send>,
}

#[cfg(test)]
impl<W> Write for Held<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.via.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.via.flush()
    }
}

impl Writer {
    pub(super) fn start<W: Write + Send + 'static>(sink: W, link: Arc<LinkCell>) -> Self {
        #[cfg(test)]
        if let Some(over) = NEXT_SINK.with(|slot| slot.borrow_mut().take()) {
            let via: Box<dyn Write + Send> = match over {
                SinkOverride::Fail => Box::new(sinks::Failing("injected write failure")),
                SinkOverride::Stall(gate) => Box::new(gate),
            };
            return Self::start_with(Held { _keep: sink, via }, link);
        }
        Self::start_with(sink, link)
    }

    fn start_with<W: Write + Send + 'static>(sink: W, link: Arc<LinkCell>) -> Self {
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

fn run<W: Write>(sink: &mut BufWriter<W>, link: &LinkCell, job: &Job) -> WriteDone {
    #[cfg(test)]
    if let Some(probe) = &job.probe {
        probe
            .before_mark_sent
            .store(true, std::sync::atomic::Ordering::Release);
        while probe
            .hold_before_mark_sent
            .load(std::sync::atomic::Ordering::Acquire)
        {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    let result = if link.mark_sent() {
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
        let writer = Writer::start(sink.clone(), Arc::new(LinkCell::open()));
        for text in ["a", "b", "c"] {
            let receiver = writer.submit(Payload::Json(text.into())).unwrap();
            assert!(matches!(done(&receiver).result, WriteResult::Ok));
        }
        assert_eq!(sink.text(), "a\nb\nc\n");
    }

    #[test]
    fn a_closed_link_aborts_without_writing() {
        let sink = Recording::default();
        let link = Arc::new(LinkCell::open());
        let writer = Writer::start(sink.clone(), link.clone());
        link.close(super::super::link::CloseCause::Eof);
        let receiver = writer.submit(Payload::Json("late".into())).unwrap();
        assert!(matches!(done(&receiver).result, WriteResult::Aborted));
        assert!(sink.text().is_empty());
    }

    #[test]
    fn the_queue_holds_one_job_and_a_full_queue_fails_without_blocking() {
        let gate = Gated::default();
        let writer = Writer::start(gate.clone(), Arc::new(LinkCell::open()));
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
        let writer = Writer::start(Failing("pipe gone"), Arc::new(LinkCell::open()));
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
        let writer = Writer::start(Recording::default(), Arc::new(LinkCell::open()));
        let before = Instant::now();
        let receiver = writer.submit(Payload::Json("x".into())).unwrap();
        let finished = done(&receiver);
        assert!(finished.flushed_at >= before);
    }

    #[test]
    fn a_command_payload_is_serialized_by_the_writer_thread() {
        let sink = Recording::default();
        let writer = Writer::start(sink.clone(), Arc::new(LinkCell::open()));
        let receiver = writer
            .submit(Payload::Command(Box::new(Command::GetDevices)))
            .unwrap();
        assert!(matches!(done(&receiver).result, WriteResult::Ok));
        let value: serde_json::Value = serde_json::from_str(sink.text().trim()).unwrap();
        assert_eq!(value["type"], "GetDevices");
    }

    fn load() -> Command {
        Command::LoadPlugin {
            path: "C:/VST/Echo.vst3".into(),
            class_id: None,
        }
    }

    fn settled_link() -> Arc<LinkCell> {
        let link = Arc::new(LinkCell::open());
        let start = Command::Start {
            host: "ASIO".into(),
            input: None,
            output: None,
            input_source: None,
            input_id: None,
            output_id: None,
            buffer_size: None,
            sample_rate: None,
            initial_controls: None,
            channel_routing: None,
        };
        let _rx = link.begin(Some(&start)).unwrap();
        assert!(link.mark_sent());
        link.deliver(crate::ipc::Response::Started {
            sample_rate: 48000,
            buffer_size: 512,
            routing: None,
            input_id: None,
            output_id: None,
            stream_generation: Some(1),
        });
        link
    }

    fn exit_json(link: &LinkCell) -> serde_json::Value {
        serde_json::to_value(link.close_eof().expect("EOF が勝つ").exit).unwrap()
    }

    /// `mark_sent` の直前で止めた状態で、登録済みの操作を writer へ渡す。
    fn submit_held(writer: &Writer, command: &Command) -> (Probe, mpsc::Receiver<WriteDone>) {
        let probe = Probe::default();
        probe
            .hold_before_mark_sent
            .store(true, std::sync::atomic::Ordering::Release);
        let receiver = writer
            .submit_probed(Payload::Command(Box::new(command.clone())), probe.clone())
            .unwrap();
        let started = Instant::now();
        while !probe
            .before_mark_sent
            .load(std::sync::atomic::Ordering::Acquire)
        {
            assert!(started.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(1));
        }
        (probe, receiver)
    }

    fn release(probe: &Probe) {
        probe
            .hold_before_mark_sent
            .store(false, std::sync::atomic::Ordering::Release);
    }

    // T3（競合1 の 1b・1c）：`mark_sent` の直前で止めて閉じると、その操作は原因に載らず、書き込みも始まらない。
    // `mark_sent` を通した後に閉じると、その操作が原因に載る。
    #[test]
    fn an_operation_is_named_as_the_exit_cause_only_after_mark_sent() {
        let sink = Recording::default();
        let link = Arc::new(LinkCell::open());
        let writer = Writer::start(sink.clone(), link.clone());
        let _rx = link.begin(Some(&load())).unwrap();
        let (probe, receiver) = submit_held(&writer, &load());
        assert_eq!(
            exit_json(&link)["cause"],
            "unknown",
            "止めている間は載らない"
        );
        release(&probe);
        assert!(matches!(done(&receiver).result, WriteResult::Aborted));
        assert!(sink.text().is_empty(), "書き込みは始まらない");

        let sink = Recording::default();
        let link = Arc::new(LinkCell::open());
        let writer = Writer::start(sink.clone(), link.clone());
        let _rx = link.begin(Some(&load())).unwrap();
        let receiver = writer.submit(Payload::Command(Box::new(load()))).unwrap();
        assert!(matches!(done(&receiver).result, WriteResult::Ok));
        let exit = exit_json(&link);
        assert_eq!(exit["cause"], "vst_operation");
        assert_eq!(exit["op"], "load");
    }

    // T3 (i)：機器の開始の直後（`settling` が有効）に、未送信の操作を閉じると、原因は有効な `settling`。
    #[test]
    fn an_unsent_operation_yields_to_a_valid_settling() {
        let sink = Recording::default();
        let link = settled_link();
        let writer = Writer::start(sink.clone(), link.clone());
        let _rx = link.begin(Some(&load())).unwrap();
        let (probe, receiver) = submit_held(&writer, &load());
        let exit = exit_json(&link);
        assert_eq!(exit["cause"], "device_open");
        assert_eq!(exit["phase"], "settling");
        release(&probe);
        assert!(matches!(done(&receiver).result, WriteResult::Aborted));
    }

    // T3 (ii)：未送信の `Stop` は `settling` を消さない。書いた後に閉じると、`settling` は消えている。
    #[test]
    fn an_unsent_stop_keeps_the_settling_and_a_sent_stop_clears_it() {
        let link = settled_link();
        let writer = Writer::start(Recording::default(), link.clone());
        let _rx = link.begin(Some(&Command::Stop)).unwrap();
        let (probe, receiver) = submit_held(&writer, &Command::Stop);
        let exit = exit_json(&link);
        assert_eq!(
            exit["cause"], "device_open",
            "止めていない間は settling が残る"
        );
        release(&probe);
        assert!(matches!(done(&receiver).result, WriteResult::Aborted));

        let link = settled_link();
        let writer = Writer::start(Recording::default(), link.clone());
        let _rx = link.begin(Some(&Command::Stop)).unwrap();
        let receiver = writer
            .submit(Payload::Command(Box::new(Command::Stop)))
            .unwrap();
        assert!(matches!(done(&receiver).result, WriteResult::Ok));
        assert_eq!(exit_json(&link)["cause"], "unknown");
    }
}

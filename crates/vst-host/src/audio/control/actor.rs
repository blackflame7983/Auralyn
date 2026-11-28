//! 実行のスレッド。`AudioHost`を持ち、受付の列から1件ずつ取り出して実行する。
//!
//! 所有するもの（ホスト・取り出し済みの仕事・列から取り出した残件）は、すべて外側の`catch_unwind`の
//! 外の変数が持つ。内側のループは借りるか、外の変数との間で出し入れするだけで、所有したまま
//! panic しうる区間を作らない。実行する仕事も断る仕事も、取り出したら`current`に置く。
use super::class::JobClass;
use super::queue::{
    ActorPoint, Job, JobKind, JobQueue, Payload, PostFn, Reply, ReplyTx, RunFn, Taken,
};
use super::{Admission, ControlError, Entry, Phase};
use crate::audio::AudioHost;
use std::cell::Cell;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::thread::{Builder, JoinHandle};
use std::time::Instant;

const STACK_SIZE: usize = 4 * 1024 * 1024;

thread_local! {
    static ON_ACTOR: Cell<bool> = const { Cell::new(false) };
}

/// 呼び出しのスレッドが実行のスレッドか。
pub(super) fn on_actor() -> bool {
    ON_ACTOR.with(Cell::get)
}

pub(super) fn spawn(
    queue: Arc<JobQueue>,
    admission: Arc<Admission>,
    host: AudioHost,
) -> io::Result<JoinHandle<()>> {
    Builder::new()
        .name("auralyn-audio-control".to_owned())
        .stack_size(STACK_SIZE)
        .spawn(move || actor_main(&queue, &admission, host))
}

enum Outcome {
    Done,
    Panicked,
}

/// 異常終了も通常終了も、外側の`catch_unwind`の後に同じ`drain_and_stop`を通る。
/// ホストを`drop`するのは、その回収を終えた後。
fn actor_main(queue: &JobQueue, admission: &Admission, host: AudioHost) {
    ON_ACTOR.with(|flag| flag.set(true));
    let mut host: Option<Box<AudioHost>> = Some(Box::new(host));
    let mut current: Option<Job> = None;
    let ended = catch_unwind(AssertUnwindSafe(|| {
        serve(queue, admission, &mut host, &mut current);
    }));
    if let Err(payload) = ended {
        log::error!(
            "the audio control thread stopped abnormally: {}",
            payload_text(payload.as_ref())
        );
        discard(payload);
    }
    drain_and_stop(queue, current.take());
    if let Err(payload) = catch_unwind(AssertUnwindSafe(|| drop(host))) {
        log::error!(
            "dropping the audio host panicked: {}",
            payload_text(payload.as_ref())
        );
        discard(payload);
    }
}

/// 仕事の終わりの記録。数を下げ、`Completed`か`Refused`を記録する。返事は、この後で送る。
struct Finish<'a> {
    queue: &'a JobQueue,
    admission: &'a Admission,
    seq: u64,
    entry: Entry,
    class: JobClass,
}

impl Finish<'_> {
    fn completed(&self, started: Instant) {
        self.queue.complete(self.class);
        let elapsed = started.elapsed();
        self.admission
            .record(self.seq, self.entry, Phase::Completed, Some(elapsed));
        if elapsed >= self.queue.limits().slow {
            log::warn!(
                "audio operation {} took {} ms (seq {})",
                self.entry.name,
                elapsed.as_millis(),
                self.seq
            );
        }
    }

    fn refused(&self) {
        self.queue.complete(self.class);
        self.admission
            .record(self.seq, self.entry, Phase::Refused, None);
    }
}

fn serve(
    queue: &JobQueue,
    admission: &Admission,
    host: &mut Option<Box<AudioHost>>,
    current: &mut Option<Job>,
) {
    let mut poisoned = false;
    while let Some(taken) = queue.take_next(current) {
        queue.run_seam(ActorPoint::AfterTake);
        let Some(job) = current.take() else { continue };
        let finish = Finish {
            queue,
            admission,
            seq: job.seq,
            entry: job.entry,
            class: job.class,
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| match taken {
            Taken::Run => {
                admission.record(job.seq, job.entry, Phase::Started, None);
                execute(job.kind, &finish, queue, host, &mut poisoned)
            }
            Taken::Refuse(error) => {
                finish.refused();
                refuse(job.kind, error, queue)
            }
        }));
        if !matches!(outcome, Ok(Outcome::Done)) {
            poisoned = true;
        }
    }
}

fn execute(
    kind: JobKind,
    finish: &Finish<'_>,
    queue: &JobQueue,
    host: &mut Option<Box<AudioHost>>,
    poisoned: &mut bool,
) -> Outcome {
    let started = Instant::now();
    match kind {
        JobKind::Run { tx, f } => {
            let (reply, outcome) = run_job(f, host, *poisoned);
            finish.completed(started);
            reply_to(queue, tx, reply);
            outcome
        }
        JobKind::Post { f } => {
            let outcome = post_job(f, host, *poisoned);
            finish.completed(started);
            outcome
        }
        #[cfg(test)]
        JobKind::Lease(lease) => {
            let outcome = lease_job(lease, host, poisoned);
            finish.completed(started);
            outcome
        }
    }
}

/// 送れなかった返事は、`Drop` が panic しても実行のスレッドを壊さないよう、ここで捨てる。
fn reply_to(queue: &JobQueue, tx: ReplyTx, reply: Reply) {
    queue.run_seam(ActorPoint::BeforeReply);
    if let Err(unsent) = tx.send(reply) {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(unsent)));
    }
    queue.run_seam(ActorPoint::AfterReply);
}

fn run_job(f: RunFn, host: &mut Option<Box<AudioHost>>, poisoned: bool) -> (Reply, Outcome) {
    let Some(host) = host.as_deref_mut().filter(|_| !poisoned) else {
        return (Reply::Poisoned, Outcome::Done);
    };
    match catch_unwind(AssertUnwindSafe(|| f(host))) {
        Ok(output) => (Reply::Done(output), Outcome::Done),
        Err(payload) => (Reply::Panicked(payload), Outcome::Panicked),
    }
}

fn post_job(f: PostFn, host: &mut Option<Box<AudioHost>>, poisoned: bool) -> Outcome {
    let target = host
        .as_deref_mut()
        .filter(|_| !poisoned)
        .ok_or(ControlError::Poisoned);
    call_post(f, target, "a posted audio operation")
}

/// `post`の閉包を1回呼ぶ。panic は記録して捨て、`Panicked`で返す。
fn call_post(f: PostFn, arg: Result<&mut AudioHost, ControlError>, label: &str) -> Outcome {
    match catch_unwind(AssertUnwindSafe(|| f(arg))) {
        Ok(()) => Outcome::Done,
        Err(payload) => {
            log::error!("{label} panicked: {}", payload_text(payload.as_ref()));
            discard(payload);
            Outcome::Panicked
        }
    }
}

/// 実行せずに断る。閉包は`run`では呼ばずに捨て、`post`では`Err(理由)`で1回だけ呼ぶ。
fn refuse(kind: JobKind, error: ControlError, queue: &JobQueue) -> Outcome {
    match kind {
        JobKind::Run { tx, f } => {
            drop(f);
            reply_to(queue, tx, Reply::Refused(error));
            Outcome::Done
        }
        JobKind::Post { f } => {
            queue.run_seam(ActorPoint::BeforeReply);
            call_post(f, Err(error), "a refused audio operation")
        }
        #[cfg(test)]
        JobKind::Lease(lease) => {
            let _ = lease.grant.send(Err(error));
            Outcome::Done
        }
    }
}

#[cfg(test)]
fn lease_job(
    lease: super::lease::LeaseGrant,
    host: &mut Option<Box<AudioHost>>,
    poisoned: &mut bool,
) -> Outcome {
    let boxed = if *poisoned { None } else { host.take() };
    let Some(boxed) = boxed else {
        let _ = lease.grant.send(Err(ControlError::Poisoned));
        return Outcome::Done;
    };
    if let Err(std::sync::mpsc::SendError(Ok(boxed))) = lease.grant.send(Ok(boxed)) {
        *host = Some(boxed);
        return Outcome::Done;
    }
    match lease.back.recv() {
        Ok((boxed, panicked)) => {
            *host = Some(boxed);
            if panicked {
                Outcome::Panicked
            } else {
                Outcome::Done
            }
        }
        Err(_) => Outcome::Panicked,
    }
}

enum Leftover {
    Run(RunFn),
    Post(PostFn),
    #[cfg(test)]
    Lease,
}

/// 列を閉じ、残りの仕事を断る。待っている`run`の解放は返事の送信端を落とすことだけで起き、
/// `post`の失敗の通知・取り込み値の`Drop`に依存しない。
fn drain_and_stop(queue: &JobQueue, current: Option<Job>) {
    let jobs = queue.close_and_take(current);
    let mut leftovers = Vec::with_capacity(jobs.len());
    for job in jobs {
        match job.kind {
            JobKind::Run { tx, f } => {
                drop(tx);
                leftovers.push(Leftover::Run(f));
            }
            JobKind::Post { f } => leftovers.push(Leftover::Post(f)),
            #[cfg(test)]
            JobKind::Lease(lease) => {
                drop(lease);
                leftovers.push(Leftover::Lease);
            }
        }
    }
    for leftover in leftovers {
        let result = catch_unwind(AssertUnwindSafe(|| match leftover {
            Leftover::Run(f) => drop(f),
            Leftover::Post(f) => f(Err(ControlError::Stopped)),
            #[cfg(test)]
            Leftover::Lease => {}
        }));
        if let Err(payload) = result {
            log::error!(
                "discarding a queued audio operation panicked: {}",
                payload_text(payload.as_ref())
            );
            discard(payload);
        }
    }
}

fn discard(payload: Payload) {
    let _ = catch_unwind(AssertUnwindSafe(|| drop(payload)));
}

pub(super) fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

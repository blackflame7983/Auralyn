//! 実行のスレッド。`AudioHost`を持ち、受付の列から1件ずつ取り出して実行する。
//!
//! 所有するもの（ホスト・取り出し済みの仕事・列から取り出した残件）は、すべて外側の`catch_unwind`の
//! 外の変数が持つ。内側のループは借りるか、外の変数との間で出し入れするだけで、所有したまま
//! panic しうる区間を作らない。
use super::queue::{Job, JobKind, JobQueue, Payload, PostFn, Reply, RunFn};
use super::{Admission, ControlError};
use crate::audio::AudioHost;
use std::cell::Cell;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::thread::{Builder, JoinHandle};

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

fn serve(
    queue: &JobQueue,
    admission: &Admission,
    host: &mut Option<Box<AudioHost>>,
    current: &mut Option<Job>,
) {
    let mut poisoned = false;
    while queue.take_next(current) {
        #[cfg(test)]
        queue.run_seam(super::queue::ActorPoint::AfterTake);
        if let Some(job) = current.as_ref() {
            admission.push_granted(job.seq, job.entry);
        }
        let Some(job) = current.take() else { continue };
        let outcome = catch_unwind(AssertUnwindSafe(|| execute(job, host, &mut poisoned)));
        if !matches!(outcome, Ok(Outcome::Done)) {
            poisoned = true;
        }
    }
}

fn execute(job: Job, host: &mut Option<Box<AudioHost>>, poisoned: &mut bool) -> Outcome {
    match job.kind {
        JobKind::Run { tx, f } => run_job(tx, f, host, *poisoned),
        JobKind::Post { f } => post_job(f, host, *poisoned),
        #[cfg(test)]
        JobKind::Lease(lease) => lease_job(lease, host, poisoned),
    }
}

fn run_job(
    tx: std::sync::mpsc::SyncSender<Reply>,
    f: RunFn,
    host: &mut Option<Box<AudioHost>>,
    poisoned: bool,
) -> Outcome {
    let Some(host) = host.as_deref_mut().filter(|_| !poisoned) else {
        let _ = tx.send(Reply::Poisoned);
        return Outcome::Done;
    };
    match catch_unwind(AssertUnwindSafe(|| f(host))) {
        Ok(output) => {
            let _ = tx.send(Reply::Done(output));
            Outcome::Done
        }
        Err(payload) => {
            let _ = tx.send(Reply::Panicked(payload));
            Outcome::Panicked
        }
    }
}

fn post_job(f: PostFn, host: &mut Option<Box<AudioHost>>, poisoned: bool) -> Outcome {
    let target = host.as_deref_mut().filter(|_| !poisoned);
    let result = catch_unwind(AssertUnwindSafe(|| match target {
        Some(host) => f(Ok(host)),
        None => f(Err(ControlError::Poisoned)),
    }));
    match result {
        Ok(()) => Outcome::Done,
        Err(payload) => {
            log::error!(
                "a posted audio operation panicked: {}",
                payload_text(payload.as_ref())
            );
            discard(payload);
            Outcome::Panicked
        }
    }
}

#[cfg(test)]
fn lease_job(
    lease: super::lease::LeaseGrant,
    host: &mut Option<Box<AudioHost>>,
    poisoned: &mut bool,
) -> Outcome {
    let boxed = host.take().filter(|_| !*poisoned);
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

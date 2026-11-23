//! 接続の状態（`LinkCell`）に試験が触れる窓口。
//! 設計は docs/plans/audio-session-f1b0b-design.md の8.1。試験は、接続の状態の内側を直接つかまずに、ここを通る。
use super::link::{EofWin, LinkCell};
use super::*;
use std::cell::RefCell;
use std::sync::mpsc;

thread_local! {
    static HELD_EOF: RefCell<Option<EofWin>> = const { RefCell::new(None) };
}

/// 応答の待ちを登録し、`command` があれば、その操作の記録を始める（書き込みはまだ始めていない）。
pub(super) fn begin_request(
    host: &AudioHost,
    command: Option<&IpcCommand>,
) -> Result<mpsc::Receiver<ReplyOutcome>> {
    host.link.begin(command)
}

/// 応答の待ち手へ応答を渡す。別のスレッドへ渡して使う。
#[derive(Clone)]
pub(super) struct Deliverer(Arc<LinkCell>);

impl Deliverer {
    pub(super) fn deliver(&self, response: IpcResponse) -> bool {
        self.0.deliver(response)
    }

    pub(super) fn deliver_at(&self, response: IpcResponse, received_at: Instant) -> bool {
        self.0.deliver_at(response, received_at)
    }
}

pub(super) fn reply_slot(host: &AudioHost) -> Deliverer {
    Deliverer(host.link.clone())
}

pub(super) fn deliver(host: &AudioHost, response: IpcResponse) -> bool {
    reply_slot(host).deliver(response)
}

pub(super) fn deliver_at(host: &AudioHost, response: IpcResponse, received_at: Instant) -> bool {
    reply_slot(host).deliver_at(response, received_at)
}

/// 応答の待ちを取り消す（閉じた状態は変えない）。
pub(super) fn cancel(host: &AudioHost) {
    host.link.cancel();
}

/// reader が EOF の競りに勝ったことを真似る。勝てば、応答の待ち手の送り側を取り出して返す
/// （待ち手がいなければ `None`。競りに負けたときも `None`）。終了の原因は捨てる。
pub(super) fn win_eof(host: &AudioHost) -> Option<mpsc::Sender<ReplyOutcome>> {
    host.link.close_eof().and_then(|win| win.waiter)
}

/// reader が EOF の競りに勝つところまで（接続を閉じ、待ち手の送り側と終了の原因を取り出すまで）を真似る。
/// 取り出したものは窓口が保持し、`take_exit` が終了の原因を返す。
pub(super) fn cas_eof(host: &AudioHost) -> bool {
    let win = host.link.close_eof();
    let won = win.is_some();
    HELD_EOF.with(|held| *held.borrow_mut() = win);
    won
}

/// `cas_eof` が保持した、`close_eof` が返した終了の原因（通知の中身と同じ JSON）。
pub(super) fn take_exit(_host: &AudioHost) -> serde_json::Value {
    let win = HELD_EOF
        .with(|held| held.borrow_mut().take())
        .expect("cas_eof が勝っていない");
    serde_json::to_value(win.exit).unwrap()
}

/// reader が通知の列を出し終えたことを真似る。
pub(super) fn mark_notified(host: &AudioHost) {
    host.link.mark_notified();
}

/// 書き込みを始めた操作として登録する。
pub(super) fn register_sent_operation(
    host: &AudioHost,
    command: &IpcCommand,
) -> mpsc::Receiver<ReplyOutcome> {
    let receiver = host.link.begin(Some(command)).unwrap();
    assert!(host.link.mark_sent());
    receiver
}

/// 操作への応答を、記録へ反映する（待ちがあれば、その待ち手へ渡る）。
pub(super) fn operation_response(host: &AudioHost, response: IpcResponse) {
    host.link.deliver_at(response, Instant::now());
}

pub(super) fn operation_in_flight(host: &AudioHost) -> bool {
    host.link.with_log_for_test(|log| log.in_flight_for_test())
}

pub(super) fn operation_awaiting(host: &AudioHost) -> bool {
    host.link.with_log_for_test(|log| log.awaiting_for_test())
}

/// 今の接続の操作の記録への参照。接続を作り直した後も、旧い接続の記録を読める。
pub(super) struct OperationRecord(Arc<LinkCell>);

impl OperationRecord {
    pub(super) fn plugin_count(&self) -> usize {
        self.0.with_log_for_test(|log| log.plugin_count_for_test())
    }

    pub(super) fn is_same_record(&self, other: &OperationRecord) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub(super) fn operation_record(host: &AudioHost) -> OperationRecord {
    OperationRecord(host.link.clone())
}

/// 読み込み済みの VST として記録している件数。
pub(super) fn plugin_records(host: &AudioHost) -> usize {
    operation_record(host).plugin_count()
}

/// 今の接続の操作の記録が、いま EOF で閉じたとしたときの終了の原因（接続は閉じない）。
pub(super) fn exit_record(host: &AudioHost) -> serde_json::Value {
    serde_json::to_value(host.link.exit_for_test()).unwrap()
}

/// 今の接続の reader を、止める継ぎ目（`pause`）なしで組む。`engine_generation` は 1。
pub(super) fn reader_for(host: &AudioHost, epoch: u64) -> reader::Reader {
    reader::Reader {
        link: host.link.clone(),
        voice_activity: host.voice_activity.clone(),
        notifier: host.emitter.clone(),
        conditions: host.conditions.clone(),
        epoch,
        engine_generation: 1,
        pause: None,
    }
}

/// reader の終端（EOF の競り・通知の列・待ち手の解放）を、別のスレッドで通知の列を出し切るところまで進める。
/// ホストを別のスレッドが持っている間に使えるよう、`reader_for` で先に組んだ reader を受け取る。
pub(super) fn finish_eof(reader: reader::Reader) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || reader.finish())
}

//! F1b-0b-0：接続の状態（`LinkState`・`ReplySlot`・`vst_operations`）に試験が触れる窓口。
//! 設計は docs/plans/audio-session-f1b0b-design.md の8.1。試験は、これらの型を直接つかまずに、ここを通る。
//! F1b-0b-1 で `LinkCell` へ置き換えるときは、このファイルの中身だけを書き換える。
use super::link::CloseCause;
use super::*;
use std::sync::mpsc;

/// 応答の待ちを登録し、`command` があれば、その操作の記録を始める（`audio.rs` の `execute_running_command_inner` と同じ順）。
pub(super) fn begin_request(
    host: &AudioHost,
    command: Option<&IpcCommand>,
) -> Result<mpsc::Receiver<ReplyOutcome>> {
    let receiver = host.pending_reply_tx.begin()?;
    if let Some(command) = command {
        host.vst_operations.begin(command);
    }
    Ok(receiver)
}

/// 応答の待ち手へ応答を渡す。別のスレッドへ渡して使う。
#[derive(Clone)]
pub(super) struct Deliverer(Arc<ReplySlot>);

impl Deliverer {
    pub(super) fn deliver(&self, response: IpcResponse) -> bool {
        self.0.deliver(response)
    }

    pub(super) fn deliver_at(&self, response: IpcResponse, received_at: Instant) -> bool {
        self.0.deliver_at(response, received_at)
    }
}

pub(super) fn reply_slot(host: &AudioHost) -> Deliverer {
    Deliverer(host.pending_reply_tx.clone())
}

pub(super) fn deliver(host: &AudioHost, response: IpcResponse) -> bool {
    reply_slot(host).deliver(response)
}

pub(super) fn deliver_at(host: &AudioHost, response: IpcResponse, received_at: Instant) -> bool {
    reply_slot(host).deliver_at(response, received_at)
}

/// 応答の待ちを取り消す（閉じた状態は変えない）。
pub(super) fn cancel(host: &AudioHost) {
    host.pending_reply_tx.cancel();
}

/// reader が EOF の競りに勝ったことを真似る。勝てば、応答の待ち手の送り側を取り出して返す
/// （待ち手がいなければ `None`。競りに負けたときも `None`）。
pub(super) fn win_eof(host: &AudioHost) -> Option<mpsc::Sender<ReplyOutcome>> {
    host.link
        .close(CloseCause::Eof)
        .then(|| host.pending_reply_tx.close())
        .flatten()
}

/// reader が EOF の競りに勝つところまで（接続を閉じるだけ）を真似る。応答の待ちにも操作の記録にも触れない。
pub(super) fn cas_eof(host: &AudioHost) -> bool {
    host.link.close(CloseCause::Eof)
}

/// 操作の記録から、終了の原因を取り出す（通知の中身と同じ JSON）。
pub(super) fn take_exit(host: &AudioHost) -> serde_json::Value {
    serde_json::to_value(host.vst_operations.take_exit()).unwrap()
}

/// 書き込みを始めた操作として記録する（待ちは登録しない）。
pub(super) fn register_sent_operation(host: &AudioHost, command: &IpcCommand) {
    host.vst_operations.begin(command);
}

/// 操作への応答を、記録だけに反映する（待ち手へは渡さない）。
pub(super) fn operation_response(host: &AudioHost, response: &IpcResponse) {
    host.vst_operations.response(response);
}

pub(super) fn operation_in_flight(host: &AudioHost) -> bool {
    host.vst_operations.in_flight_for_test()
}

pub(super) fn operation_awaiting(host: &AudioHost) -> bool {
    host.vst_operations.awaiting_for_test()
}

/// 今の接続の操作の記録への参照。接続を作り直した後も、旧い接続の記録を読める。
pub(super) struct OperationRecord(Arc<engine_exit::Operations>);

impl OperationRecord {
    pub(super) fn plugin_count(&self) -> usize {
        self.0.plugin_count_for_test()
    }

    pub(super) fn is_same_record(&self, other: &OperationRecord) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub(super) fn operation_record(host: &AudioHost) -> OperationRecord {
    OperationRecord(host.vst_operations.clone())
}

/// 読み込み済みの VST として記録している件数。
pub(super) fn plugin_records(host: &AudioHost) -> usize {
    host.vst_operations.plugin_count_for_test()
}

/// 今の接続の reader を、止める継ぎ目（`pause`）なしで組む。`engine_generation` は 1。
pub(super) fn reader_for(host: &AudioHost, epoch: u64) -> reader::Reader {
    reader::Reader {
        link: host.link.clone(),
        operations: host.vst_operations.clone(),
        replies: host.pending_reply_tx.clone(),
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

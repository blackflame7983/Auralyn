//! 接続の状態（`LinkCell`）に試験が触れる窓口のうち、手順を持つもの。残りは `host.link` を直接呼ぶ。
//! 設計は docs/plans/audio-session-f1b0b-design.md の8.1。
use super::link::EofWin;
use super::*;
use std::cell::RefCell;
use std::sync::mpsc;

thread_local! {
    static HELD_EOF: RefCell<Option<EofWin>> = const { RefCell::new(None) };
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

pub(super) fn operation_awaiting(host: &AudioHost) -> bool {
    host.link.with_log_for_test(|log| log.awaiting_for_test())
}

/// 読み込み済みの VST として記録している件数。
pub(super) fn plugin_records(host: &AudioHost) -> usize {
    host.link
        .with_log_for_test(|log| log.plugin_count_for_test())
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

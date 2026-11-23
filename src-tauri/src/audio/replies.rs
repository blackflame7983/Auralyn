//! 応答待ちの結果と、閉じた接続の文言。待ちの状態そのものは `LinkCell` が持つ。
use crate::ipc::Response;
use std::time::Instant;

pub(super) const CLOSED: &str = "音声エンジンとの通信が終了しました";

/// 待ち手が受け取る結果。送り側が捨てられた場合（`Disconnected`）は、呼び出し側が EOF と同じに扱う。
pub(super) enum ReplyOutcome {
    /// `received_at` は reader が応答の行を読んだ時刻。受け取りが遅れても、期限の判定はこの時刻で行う。
    Response {
        resp: Box<Response>,
        received_at: Instant,
    },
    /// 子の出力が閉じた。通知は出し終えている。
    Eof,
}

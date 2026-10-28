//! prepare後に登録し、ドライバー開始はplayまで遅らせる。
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) fn prepare_and_register<P, R, E>(
    prepare: impl FnOnce() -> Result<P, E>,
    register: impl FnOnce() -> R,
) -> Result<(P, R), E> {
    let prepared = prepare()?;
    Ok((prepared, register()))
}

pub(super) fn play_prepared_stream<E>(
    playing: &AtomicBool,
    start: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    // ASIOStart内で最初のcallbackが来ても再生できるよう、先に有効化する。
    let previous = playing.swap(true, Ordering::SeqCst);
    if let Err(error) = start() {
        playing.store(previous, Ordering::SeqCst);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn duplex_builds_stay_stopped_until_play_and_share_one_driver_start() {
        let running = Cell::new(false);
        let starts = Cell::new(0);
        let prepare = || {
            assert!(!running.get(), "準備中にドライバーを開始しない");
            Ok::<_, ()>(())
        };
        let (_, input) = prepare_and_register(prepare, || AtomicBool::new(false)).unwrap();
        let (_, output) = prepare_and_register(prepare, || AtomicBool::new(false)).unwrap();
        assert_eq!(starts.get(), 0);
        for playing in [&output, &input, &output] {
            play_prepared_stream(playing, || {
                assert!(
                    playing.load(Ordering::SeqCst),
                    "初回callbackより先に有効化する"
                );
                // asio-sysのstartはRunningならno-op。
                if !running.replace(true) {
                    starts.set(starts.get() + 1);
                }
                Ok::<_, ()>(())
            })
            .unwrap();
        }
        assert_eq!(starts.get(), 1);
        assert!(input.load(Ordering::SeqCst));
        assert!(output.load(Ordering::SeqCst));
    }

    #[test]
    fn failed_play_restores_previous_callback_gate_and_allows_retry() {
        let playing = AtomicBool::new(false);
        assert_eq!(
            play_prepared_stream(&playing, || Err("start failed")),
            Err("start failed")
        );
        assert!(!playing.load(Ordering::SeqCst));
        play_prepared_stream(&playing, || Ok::<_, ()>(())).unwrap();
        assert!(playing.load(Ordering::SeqCst));
        assert!(play_prepared_stream(&playing, || Err(())).is_err());
        assert!(playing.load(Ordering::SeqCst));
    }
}

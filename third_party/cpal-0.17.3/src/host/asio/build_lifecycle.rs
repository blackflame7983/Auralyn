//! prepareが成功するまで登録せず、開始失敗時は登録済みStreamのDropで回収する。
pub(super) fn prepare_and_register<P, R, E>(
    prepare: impl FnOnce() -> Result<P, E>,
    register: impl FnOnce() -> R,
) -> Result<(P, R), E> {
    let prepared = prepare()?;
    Ok((prepared, register()))
}

pub(super) fn start_prepared_stream<S, E>(
    stream: S,
    start: impl FnOnce(&S) -> Result<(), E>,
) -> Result<S, E> {
    start(&stream)?;
    Ok(stream)
}

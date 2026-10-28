// エンジンが保持する失効の根拠。欠落・未知の値はUIで原因不明として扱う。
export type HistoryReason = 'not_created' | 'settings_changed' | 'input_changed'
    | 'learning_changed' | 'new_measurement' | 'stream_changed' | 'stream_failed' | 'conditions_changed';

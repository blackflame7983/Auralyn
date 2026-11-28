# Coding Guidelines

## Development Design Rules (開発設計ルール)

### Principles (原則)
- **Separation of Concerns (関心の分離)**: Limit the scope of impact.
- **High Cohesion (高凝集)**: Make internal changes easy.
- **Low Coupling (疎結合)**: Reduce dependencies.
- **Abstraction (抽象化)**: Increase resilience to change.
- **Non-Redundancy (非冗長)**: Eliminate duplication (DRY).

### Structure (構造)
- **Layering**: Group by responsibility and dependency direction. Do not split files only to meet a file-count or line-count target.

### Implementation Guidelines (実装指針)
- **Simplicity First (シンプル最優先)**: Prohibit over-engineering; always design and implement the minimum necessary.
- **File Structure**: Avoid excessive fragmentation of files. Consider merging if excessive.
- **Comments (コメント)**:
    - コードで表現できる内容の説明やハックの正当化は書かない。仕様・数学的根拠・公開API・unsafeの安全条件・ライセンスの説明を必要な範囲で残す。過去の説明が現実装と矛盾するときは更新する。


---

## User Experience & Stability (Japanese Streamer Focus) 🇯🇵

### 1. Stability First (安定性第一)
- **Host Survival Priority**: The primary goal is **"The Host App MUST NOT Crash"**. If a plugin crashes, only the plugin should fail, not the stream.
- **Process Isolation**: Unsafe operations (scanning, loading unknown DLLs) MUST be performed in a separate process or a sandboxed environment.
- **Fail Gracefully**: If a plugin fails to load or process audio, mute it and notify the user. Do NOT panic the audio engine.

### 2. "No Sound" is a UI Failure (音が出ないはUIの敗北)
- **Proactive Diagnosis**: Do not wait for the user to fail. Automatically detect if:
    - Input device is missing.
    - Output is not routed to a virtual cable (for OBS).
    - Sample rates mismatch.
- **Guided Recovery**: Provide clear, clickable actions to fix audio issues (e.g., "Open Settings", "Install Driver").

### 3. Japanese-First & Terminology (日本語ファースト)
- **Natural Language**: Avoid direct translations of technical terms if they are confusing.
    - Bad: "Audio Buffer Underrun detected."
    - Good: "音声処理が追いついていません。バッファサイズを大きくしてください。"
- **Contextual Help**: Explain *why* a setting matters (e.g., "ASIO (Low Latency for Games)" instead of just "ASIO").

### 4. User-Facing Copy & Expectations (文言・期待値)
- New or changed **Japanese user-facing strings** (UI labels, tooltips, wizard copy, LP spec) MUST follow [COPY_GUIDELINES.md](./COPY_GUIDELINES.md).
- PR reviews should use the checklist at the end of that document (noise scope, latency claims, Voice Check links, etc.).

---

## Technical Guidelines

### Rust (Backend)

### General
- Follow standard Rust naming conventions (snake_case for variables/functions, PascalCase for types).
- Use `cargo fmt` before committing.
- Run `cargo clippy` and address warnings.

### Error Handling
- Use `anyhow::Result` for application-level error handling.
- Use `thiserror` for library/module-level error definitions if creating strict APIs.
- Never use `unwrap()` in production code unless you can mathematically prove it won't panic. Use `expect()` with a descriptive message if necessary, or better, `?`.

### Concurrency & Audio
- **Audio Thread**: The callback in `cpal` runs on a real-time priority thread.
    - **NO** allocations (Vec, Box, etc.) inside the callback.
    - **NO** locks (Mutex) that might block for undefined time. Use Atomic values or the existing `ringbuf` communication.
    - **NO** I/O (println, file write) inside the callback.

### 画面（GPUI）と中核の境界
- **待つ処理を画面のスレッドで呼ばない**: `AudioHost` の命令は応答を待つ。`src-gpui/src/engine/` の専用のスレッドで受付順に実行し、結果を画面へ送る。I/O・重い計算も同じく画面のスレッドの外で行う。
- **部品は描くだけ**: 判定・平滑化・候補の絞り込みなどの規則は GPUI に依存しない `crates/auralyn-ui-model` に置き、時刻などを引数で受けて `cargo test` で確かめる。
- **IPC の型**: 画面と子（音声エンジン・スキャナー）の間は `crates/vst-host/src/ipc.rs` の serde の型で受け渡し、契約は Rust の試験で確かめる。
- **Security**:
    - Do not expose sensitive system paths blindly.
    - 保存したファイルや子からの応答は、使う前に検証する。

GPUI での書き方と落とし穴は [gpui/knowledge.md](gpui/knowledge.md)、理由つきの決定は [gpui/decisions.md](gpui/decisions.md)。

実行方法、例外の撤去、RT検査の対象と限界は[GARDENING.md](GARDENING.md)を参照する。

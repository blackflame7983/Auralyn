# Coding Guidelines

## Development Design Rules (開発設計ルール)

### Principles (原則)
- **Separation of Concerns (関心の分離)**: Limit the scope of impact.
- **High Cohesion (高凝集)**: Make internal changes easy.
- **Low Coupling (疎結合)**: Reduce dependencies.
- **Abstraction (抽象化)**: Increase resilience to change.
- **Non-Redundancy (非冗長)**: Eliminate duplication (DRY).

### Structure (構造)
- **Layering**: If there are 3 or more files with the same concern, create a dedicated directory to layer them.

### Implementation Guidelines (実装指針)
- **Simplicity First (シンプル最優先)**: Prohibit over-engineering; always design and implement the minimum necessary.
- **File Structure**: Avoid excessive fragmentation of files. Consider merging if excessive.
- **Comments (コメント)**:
    - **Write appropriate comments in Japanese regarding code processing and intent.** (コードの処理に適切なコメントを日本語で入れること)


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
    - **NO** locks (Mutex) that might block for undefined time. Use `box_cars` or `ringbuf` for lock-free communication.
    - **NO** I/O (println, file write) inside the callback.

### Tauri Integration
- **Async Commands**: All Tauri commands that involve I/O or heavy computation MUST be `async` to avoid freezing the UI.
- **Type Safety**:
    - Use `serde` for all data structs passed between Rust and JS.
    - Prefer automatic type generation (e.g., `tauri-specta` or `ts-rs` - *to be configured*) over manual interface definitions.
- **Security**:
    - Do not expose sensitive system paths blindly.
    - Validate all inputs from the frontend.

## TypeScript + React (Frontend)

### General
- strict mode is enabled.
- Functional components only.
- Use `React.FC` or explicitly type props.

### Styling
- Use **Tailwind CSS** for all styling.
- Avoid CSS Modules unless strictly necessary for complex animations not possible with Tailwind.
- Use the configured color palette (e.g., `bg-slate-950`, `text-cyan-500`).

### State Management
- Use `useState` for local state.
- Use `Context` or a lightweight store (Zustand - to be decided if needed) for global app state.
- Keep simple.

## Directory Structure
- Group by feature where possible, or standard `components/`, `hooks/`, `utils/` split.

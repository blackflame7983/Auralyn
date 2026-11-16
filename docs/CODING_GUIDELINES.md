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

### Tauri Integration
- **Async Commands**: I/O・重い計算・同期IPC待機は`src-tauri/src/commands/mod.rs`の`run_blocking`へ渡す。`async`宣言だけではブロッキング処理は分離されない。軽い検証と結果変換をコマンド境界に残す。
- **Type Safety**:
    - Use `serde` for all data structs passed between Rust and JS.
    - 現在の`src/api/`の型付きラッパーとRustのserde契約を対応させ、引数・結果を契約試験で確認する。未導入の型生成ツールを前提にしない。
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
- Use semantic tokens in `src/index.css`, such as `bg-card`, `text-foreground`, and `text-muted-foreground`. Canvas and dynamic geometry may use inline values; new literal UI colors must use theme tokens.

### State Management
- Use `useState` for local state.
- Use the existing Context and hooks for shared state. Mutually exclusive operation states use discriminated unions or enums; independent switches may remain boolean.
- Keep simple.

## Directory Structure
- Group by feature where possible, or standard `components/`, `hooks/`, `utils/` split.

## 機械検査が守る境界

- `src/components/`は描画と操作を扱う。外部同期は`src/hooks/`または既存のfeature専用hookへ置き、操作をEffectで推測しない。
- `src/lib/model/`は純粋な型・計算。UI・hooks・API・実行環境へ依存しない。`src/lib/`全体には既存のユースケース・実行環境依存処理もあるため、すべてを純粋層とは扱わない。
- `src/lib/`・`src/api/`・`src/constants/`からUI・hooks・Contextへの逆参照は禁止。Tauriの直接参照はAPI側へ集約する。既存違反は宣言指紋付き台帳に固定する。
- pollは`src/hooks/usePolling.ts`を使う。`request`は値を返し、`onValue`で反映する。停止後の応答は反映されない。callbackは`useCallback`等で安定させる。
- 型の穴は`unknown`の検証で閉じる。`as const`や検証済み境界の絞り込みまで一律禁止しない。
- 任意の計算がUIにあること、複数boolの意味、コメントの正しさはLintだけでは判定できない。状態遷移と不変条件の試験で補う。

実行方法、例外の撤去、RT検査の対象と限界は[GARDENING.md](GARDENING.md)を参照する。

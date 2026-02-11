# Auralyn (.gemini)

このファイルは、AIエージェント（GEMINI）がプロジェクトのコンテキスト、ルール、アーキテクチャ上の決定事項を理解するためのドキュメントです。

## 1. ブランチ運用ルール

- **Main Branch**: `main`
    - `master` ブランチは廃止されました。開発の主軸は `main` です。
- **Workflow**:
    - 新機能や修正は `feat/` や `fix/` プレフィックスのついたブランチで作業し、PRを作成して `main` にマージします。
    - 直接 `main` にコミットすることは避けてください。

## 2. バージョン管理 (Version Management)

- **Single Source of Truth**: `package.json`
    - バージョン番号の管理は `package.json` に集約されています。
- **自動化スクリプト**:
    - バージョンを更新する際は、必ず以下のコマンドを使用してください。
      ```bash
      npm run set-version <new_version>
      ```
      このスクリプトは `package.json` と `src-tauri/tauri.conf.json` を同期させます。
- **フロントエンド使用**:
    - フロントエンドコード内では、`import.meta.env.PACKAGE_VERSION` を使用してバージョンを参照します（`vite.config.ts` で注入）。

## 3. アーキテクチャ & 実装ルール

### 音声設定 (Audio Configuration)
- **定数管理**:
    - サンプリングレートやバッファサイズのデフォルト値は `src/constants/audio.ts` で定義されています。マジックナンバーの使用は避けてください。
- **状態管理 (AudioConfigContext)**:
    - 音声設定は `AudioConfigContext` で管理され、`localStorage` に永続化されます。
    - ステートの更新には関数型更新パターンを使用し、古いステートに基づく更新を防いでいます。

### コンポーネント設計
- **ModalLayer**:
    - `onClear`, `onRecover` などのリカバリーアクションでは、明示的に `inputId`, `outputId` を渡す必要があります。

## 4. 利用可能なスキル (Skills)

このプロジェクトには、`.agent/skills` ディレクトリに以下のスキルが定義されています。

- **version-management**: バージョン管理の自動化フローとベストプラクティス。
- **secure-coding**: セキュリティガイドライン。

## 5. ベストプラクティス & 推奨パターン

### API抽象化 (API Abstraction)
- **原則**: コンポーネントやHooksから直接 `invoke` を呼ばないこと。
- **実装**: `src/api/` 配下にモジュール分割し、API呼び出しをカプセル化する。型定義もここに含める。
    - Good: `audioApi.start(...)`
    - Bad: `invoke('start_audio', ...)`

### フックの責務分離 (Hook Responsibility)
- **原則**: "God Hook"（巨大なフック）を避け、責務ごとに分割する。
- **推奨構造**: 状態管理 (`useState` / `useContext`) と アクション (`useActions`)、永続化ロジック (`usePersistence`) を分離することを検討する。
    - 現状の `usePlugins` は肥大化しているため、将来的なリファクタリング対象。

### UIフィードバック (User Feedback)
- **通知**: ユーザーへの通知には `sonner` (`toast`) を使用する。
- **Undo機能**: 削除などの破壊的操作には、Toastによる Undo アクションを提供する（`usePlugins.ts` の削除処理参照）。
- **Optimistic UI**: 状態を先に更新し、バックエンド処理が失敗した場合にロールバックするパターンを採用する。

### バックエンド設計 (Rust/Tauri)
- **モジュール分割**: ロジックは `lib.rs` に詰め込まず、機能ごとのモジュール（`audio_engine`, `vst_host` 等）に分割する。
- **Command責務**: Tauri Command は薄いラッパーに留め、実際の処理はドメインロジック層に委譲する。

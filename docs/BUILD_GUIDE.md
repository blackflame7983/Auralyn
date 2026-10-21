# Auralyn ビルド・開発ガイド

## 対象環境

- サポート対象は Windows 11 x64（READMEの契約に合わせる）。
- Node.js 24 LTS 系と npm を推奨。2026-10-15の作業環境は Node 24.21.0 / npm 11.19.0。Vite 7などの `engines` を確認し、古いNode 18を前提にしない。
- Rust stable。今回確認した環境は rustc / cargo 1.92.0。依存更新時には各crateのMSRVも確認する。
- Microsoft C++ Build Tools、LLVM/Clang、ASIO SDK。固定SDK・対応ソースの扱いは `SOURCE-DISTRIBUTION.md` と `config/release-policy.json` を参照する。

上記のバージョン表示は環境の観測であり、全ビルドの成功記録やRust最小対応バージョンの保証ではない。

## 構成

- `src/`: React UI、APIラッパー、設定・プリセット。
- `src-tauri/src/lib.rs`: Tauriホストとコマンド。
- `src-tauri/src/bin/audio_engine.rs` / `plugin_scanner.rs`: 別プロセスのエンジン・スキャナー。
- `src-tauri/src/audio_engine/` / `vst_host/`: 音声処理とVST3ホスト。
- `src-tauri/bin/`: 実行するsidecarのコピー先。

## 開発

リポジトリルートで実行する。

```powershell
npm ci
npm run rebuild-engine
npm run tauri dev
```

`tauri dev` のbeforeDevCommandはVite起動のみ。エンジン・スキャナーの変更後は `npm run rebuild-engine` で両方のdebug binaryをコピーし、アプリを再起動する。
古いsidecarの動作を最新ソースの検証と誤認しない。

## 検証

```powershell
npm test -- --run
npm run test:release
npx tsc --noEmit
npx vite build
npm run release:check
```

`src-tauri` で実行するRust側の例:

```powershell
cargo check --locked --all-targets
cargo test --locked --lib --bins --test audio_queue_contract --test msix_coexistence
cargo clippy --locked --all-targets
```

上記は音声入力を開始しない対象のテスト。全テストの `cargo test --locked` には実機・VSTを起動するテストも含むため、対象を読んでから実行する。範囲別の手動確認は `docs/TESTING.md` を参照する。

## 配布ビルド

```powershell
npm run tauri build
```

beforeBuildCommandの `npm run build` はTypeScript・Vite・release sidecarのビルド・NSIS画像生成を実行する。
sidecarの開発・配布用ビルドは `--locked` で依存解決を固定する。配布用は両方のrelease成果物が必要で、欠落時にdebug版を代用しない。
成果物は `src-tauri/target/release/bundle/`。署名・対応ソース・公開先の条件は `docs/RELEASE_PLAN.md` を参照する。
通常版のビルド対象はNSIS（EXE）のみ。MSI/WiXは生成せず、公開スクリプトも残存MSIを代用しない。既存の公開済みファイルは削除しない。
MSIXを今後の主軸とし、専用手順は [MSIX_PROTOTYPE.md](MSIX_PROTOTYPE.md)、設定分離・移行・自動更新の工程は [MSIX_STORAGE.md](MSIX_STORAGE.md) を参照する。
`release:upload` はビルドだけのコマンドではなくGitHubへ書き込むため、公開の許可後に使用する。

## ファイルロックと古いバイナリ

ファイルロックが出た場合は、まずこのプロジェクトのアプリ・devサーバー・ビルドを終了する。
別のビルドが動作中なら終了を待ち、対象のプロセスを特定する。
全cargo / rustcプロセスの一括強制終了や `cargo clean` を通常の解決手順にしない。
作業中の他プロジェクトを守り、対象を特定してから必要な操作だけを行う。

# Auralyn ビルド・開発ガイド

## 対象環境

- サポート対象は Windows 11 x64（READMEの契約に合わせる）。
- Node.js 24 LTS 系と npm を推奨。2026-10-15の作業環境は Node 24.21.0 / npm 11.19.0。Vite 7などの `engines` を確認し、古いNode 18を前提にしない。
- Rust stable。`AtomicU64::try_update` を使うため1.95以降が必要。2026-10-28の確認環境は rustc / cargo 1.99.1。依存更新時には各crateのMSRVも確認する。
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

`rebuild-engine`はCargoのmetadataが返す`target_directory`からコピーする。`CARGO_TARGET_DIR`を使う場合は、再ビルドと`tauri dev`を同じ値・同じターミナルで実行する。Hostは自身と同じフォルダーの`audio_engine.exe`を優先するため、別のtargetを再ビルドしても、すでに動作中のHost／sidecarは更新されない。利用中の音声を停止できる時点でアプリを終了し、再ビルド後に再起動する。実機確認では実際の子プロセスの実行パスと、コピー元／先のハッシュも記録する。

MCPで実アプリを撮影・操作する場合は、通常起動ではなくデバッグ用設定を指定する。通常の `tauri dev` は意図的にグローバルTauri APIを公開しない。起動・接続確認・操作の手順は [TESTING.md](TESTING.md#tauri-mcp-による実アプリの確認) を参照する。

## 検証

```powershell
npm test -- --run
npm run test:release
npx tsc --noEmit
npx vite build
npm run release:check
```

テスト層別の実行は `npm run test:unit` / `npm run test:dom`。
実ブラウザのレイアウト試験は `npx playwright install chromium` 後に `npm run test:e2e`、
隔離した実Tauriの保存・再起動・実IPC試験は `npm run test:e2e:native` を使う。
後者は現行Hostとsidecarをビルドし、通常設定を使わず、音声を開始しない。
前提・検証境界・実機テストの明示実行は `docs/TESTING.md` を参照する。

`src-tauri` で実行するRust側の例:

```powershell
cargo check --locked --all-targets
cargo test --locked --lib --bins --test audio_queue_contract --test msix_coexistence
cargo test --locked --test integration_test --test repro_ott
cargo clippy --locked --all-targets
```

上記は音声入力を開始しない対象のテスト。実機録音・OTT GUI・実OTTの寿命試験は理由付きignoreとし、`--ignored` で対象を明示したときだけ実行する。範囲別の前提・手動確認は `docs/TESTING.md` を参照する。

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

## ビルド領域・容量管理

この節をビルド成果物と一時検証領域の容量管理の正本とする。worktreeごと・検証ごとに依存ライブラリを含む成果物が蓄積するため、領域の再利用と作業終了後の整理を組み合わせる。

### 開始前と保存先

- ビルド前に実際の出力先、既存領域の用途・使用状況、保存先ドライブの空き容量を確認する。並行ビルドの消費も見込み、容量が不足する場合は新しいビルドを開始しない。
- このWindows作業環境では、大容量のビルド領域は原則としてDドライブに置く。Dドライブがない環境では、十分な空き容量を確保できる場所を選ぶ。既定のTEMP、Codexや他の作業ツールのworktreeがCドライブ上にあっても、ビルド成果物までそこへ置く必要があるとは扱わない。
- 通常の開発・直列の検証では、用途を決めた既存のビルド領域を再利用することを先に検討する。Issue番号・日時・worktreeごとの新規領域を無制限に増やさない。新設する場合は、所有する作業、絶対パス、隔離が必要な理由、保持期限または見直し条件を作業記録に残す。
- `CARGO_TARGET_DIR`を指定する場合は、ビルド・sidecarのコピー・起動で同じ出力先を扱う。設定・ツールチェーン・featuresなどの違いによって再ビルドや別成果物が必要になるため、保存先の共通化だけで各作業の差分だけが保存されるとは扱わない。

### 並行検証と成果物の識別

- 同時に異なるソースをビルド・実行する検証や、クリーンビルド・配布の再現確認には専用領域を使う。並行検証用の領域は必要な同時実行数に絞り、終了後に増え続けないようにする。
- 共通領域を使う場合は、ビルドから必要な実行ファイルの確保までを直列で行う。Cargoのビルドロックだけで、その後のコピー・起動まで保護されるとは扱わない。実行中のHostやsidecarが使うファイルを別作業で上書きせず、必要なら検証専用の実行先へコピーする。
- 実行するHostとsidecarの対応ソース・ビルド条件・実行パスを確認し、実機検証ではハッシュも記録する。詳細は上記の開発手順と [TESTING.md](TESTING.md) に従う。

### 終了時の整理

- 作業完了時は、今回所有したビルド・一時検証領域を確認し、再生成可能な中間生成物と残す成果物を分ける。ソース、未コミット変更、検証ログ、録音、復元情報、配布に必要な成果物は保護する。`target`や一時フォルダーという名前だけで全体を不要と判断しない。
- 削除は既存の承認ルールに従い、承認された対象だけに限定する。実行前に絶対パスと所有範囲を確認し、リンク先・別worktree・別作業の領域を巻き込まず、対象を使うビルド・アプリが終了していることを確かめる。作業中のプロセスを整理のために一括終了しない。
- 整理後は対象の消失、保護したファイルの残存、空き容量を確認する。未承認、使用中、調査継続などの理由で残す場合は、場所・容量・保持理由・保持期限または見直し条件を完了報告に残す。復旧用に退避した領域も同じ扱いとし、退避だけで整理済みにしない。

共有キャッシュの導入やデバッグ情報・増分コンパイルの設定変更は、この運用ルールとは別に効果と検証への影響を確認してから行う。

## ファイルロックと古いバイナリ

ファイルロックが出た場合は、まずこのプロジェクトのアプリ・devサーバー・ビルドを終了する。
別のビルドが動作中なら終了を待ち、対象のプロセスを特定する。
全cargo / rustcプロセスの一括強制終了や `cargo clean` を通常の解決手順にしない。
作業中の他プロジェクトを守り、対象を特定してから必要な操作だけを行う。

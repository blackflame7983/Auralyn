# Auralyn ビルド・開発ガイド

## 対象環境

- サポート対象は Windows 11 x64（READMEの契約に合わせる）。
- Rust 1.100.0。リポジトリ直下の `rust-toolchain.toml` で固定し（clippy・rustfmt つき）、各クレートの `rust-version` を `1.100` とする。rustup が版を自動で選ぶため、`rustup default` は変えない。`AtomicU64::try_update` は1.95以降、`ChildExt::main_thread_handle` は1.100で安定化。依存更新時には各crateのMSRVも確認する。
- Microsoft C++ Build Tools、LLVM/Clang、ASIO SDK（`CPAL_ASIO_DIR`）。固定した SDK の版・SHA-256・ライセンスは `config/asio-sdk.json`。`node scripts/prepare-asio-sdk.cjs` が取得・検証する。
- 検査（`npm run verify`）に Node.js 24 LTS 系と npm、Python 3.12 以降を使う。アプリのビルドには要らない。

上記のバージョン表示は環境の観測であり、全ビルドの成功記録やRust最小対応バージョンの保証ではない。

## 構成

リポジトリ直下が1つの Cargo ワークスペース（`Cargo.lock` は1つ、ビルド領域は直下の `target`）。`third_party/` は差し替えた依存で、ワークスペースに入れない。

- `src-gpui/`: 画面（GPUI Kit、`auralyn-gpui.exe`）。
- `crates/vst-host/src/bin/audio_engine.rs` / `plugin_scanner.rs`: 別プロセスのエンジン・スキャナー。
- `crates/vst-host/src/audio/`: 画面からエンジンを動かす `AudioHost`（JSON-RPC）。
- `crates/vst-host/src/audio_engine/` / `vst_host/`: 音声処理とVST3ホスト。
- `crates/auralyn-ui-model/`: GPUI に依存しない画面の規則。
- `crates/auralyn-core/`: 文言（`locales/`）とデザイントークン（`tokens.json`）。

## 開発

リポジトリ直下で実行する。

```powershell
cargo build
cargo run -p auralyn-gpui
```

直下の `cargo build` は、`auralyn-gpui.exe`・`audio_engine.exe`・`plugin_scanner.exe` を同じ `target\debug` に作る。画面はエンジンとスキャナーを自分と同じフォルダーからだけ起動する。`cargo build -p auralyn-gpui` だけではエンジンが作り直されないので、エンジン側を変えたら直下の `cargo build` を使う。
動作中のアプリとエンジンは更新されない。音声を止められる時点でアプリを終了し（× はトレイへ隠すだけなので、トレイの「終了」）、ビルド後に起動し直す。古いエンジンの動作を最新ソースの検証と誤認しない。実機確認では実際の子プロセスの実行パスとハッシュも記録する。

画面の確かめ方は [src-gpui/README.md](../src-gpui/README.md)。

## 検証

最初にPython 3.12以降で`python -m pip install --target node_modules/.cache/auralyn-python -r requirements-dev.txt`を実行する。Ruffはリポジトリのignored領域に固定版を入れる。CIは同じrequirementsをPython環境へ導入する。
以後は`npm run verify -- --changed`、全体は`npm run verify -- --full`。Rustのコンパイルと関連試験は`npm run verify -- --static --rust`。検証CLIは通常設定・音声開始・配布処理を呼ばない。詳細は[GARDENING.md](GARDENING.md)。

`crates/vst-host`で実行するRust側の例:

```powershell
cargo check --locked --all-targets
cargo test --locked --lib --bins --test audio_queue_contract
cargo test --locked --test integration_test --test repro_ott
cargo clippy --locked --all-targets
```

上記は音声入力を開始しない対象のテスト。実機録音・OTT GUI・実OTTの寿命試験は理由付きignoreとし、`--ignored` で対象を明示したときだけ実行する。範囲別の前提・手動確認は `docs/TESTING.md` を参照する。

## 配布ビルド

GPUI 版の配布（インストーラー・更新・Source ZIP）はまだ無い。Tauri 版の配布手順（NSIS・MSIX・Updater・`release:*`）は 2026-11-28 に取り除いた。配布を作るときは、署名・対応ソース・公開先の条件を `docs/RELEASE_PLAN.md` と `SOURCE-DISTRIBUTION.md` で確かめる。

## ビルド領域・容量管理

この節をビルド成果物と一時検証領域の容量管理の正本とする。worktreeごと・検証ごとに依存ライブラリを含む成果物が蓄積するため、領域の再利用と作業終了後の整理を組み合わせる。

### 開始前と保存先

- ビルド前に実際の出力先、既存領域の用途・使用状況、保存先ドライブの空き容量を確認する。並行ビルドの消費も見込み、容量が不足する場合は新しいビルドを開始しない。
- このWindows作業環境では、大容量のビルド領域は原則としてDドライブに置く。Dドライブがない環境では、十分な空き容量を確保できる場所を選ぶ。既定のTEMP、Codexや他の作業ツールのworktreeがCドライブ上にあっても、ビルド成果物までそこへ置く必要があるとは扱わない。
- 通常の開発・直列の検証では、用途を決めた既存のビルド領域を再利用することを先に検討する。Issue番号・日時・worktreeごとの新規領域を無制限に増やさない。新設する場合は、所有する作業、絶対パス、隔離が必要な理由、保持期限または見直し条件を作業記録に残す。
- `CARGO_TARGET_DIR`を指定する場合は、ビルドと起動で同じ出力先を扱う。設定・ツールチェーン・featuresなどの違いによって再ビルドや別成果物が必要になるため、保存先の共通化だけで各作業の差分だけが保存されるとは扱わない。

### 並行検証と成果物の識別

- 同時に異なるソースをビルド・実行する検証や、クリーンビルド・配布の再現確認には専用領域を使う。並行検証用の領域は必要な同時実行数に絞り、終了後に増え続けないようにする。
- 共通領域を使う場合は、ビルドから必要な実行ファイルの確保までを直列で行う。Cargoのビルドロックだけで、その後のコピー・起動まで保護されるとは扱わない。実行中のHostやsidecarが使うファイルを別作業で上書きせず、必要なら検証専用の実行先へコピーする。
- 実行するHostとsidecarの対応ソース・ビルド条件・実行パスを確認し、実機検証ではハッシュも記録する。詳細は上記の開発手順と [TESTING.md](TESTING.md) に従う。

### 終了時の整理

- 作業完了時は、今回所有したビルド・一時検証領域を確認し、再生成可能な中間生成物と残す成果物を分ける。ソース、未コミット変更、検証ログ、録音、復元情報、配布に必要な成果物は保護する。`target`や一時フォルダーという名前だけで全体を不要と判断しない。
- 削除は既存の承認ルールに従い、承認された対象だけに限定する。実行前に絶対パスと所有範囲を確認し、リンク先・別worktree・別作業の領域を巻き込まず、対象を使うビルド・アプリが終了していることを確かめる。作業中のプロセスを整理のために一括終了しない。
- 整理後は対象の消失、保護したファイルの残存、空き容量を確認する。未承認、使用中、調査継続などの理由で残す場合は、場所・容量・保持理由・保持期限または見直し条件を完了報告に残す。復旧用に退避した領域も同じ扱いとし、退避だけで整理済みにしない。

共有キャッシュの導入やデバッグ情報・増分コンパイルの設定変更は、この運用ルールとは別に効果と検証への影響を確認してから行う。

## エージェントが PowerShell で作業するときの注意

PowerShell の文字列でファイルを書くと、制御文字が混入する事故が起きた（`docs/TESTING.md`、設計の文書、`crates/vst-host/src/audio/engine_life.rs`。NUL が入り、git がファイルをバイナリとして扱った）。次を守る。

- ファイルの中身は、エディタの編集ツール（Write・Edit）で書く。PowerShell の文字列で書かない。
- 二重引用符の中のバッククォートはエスケープになる。`` `t ``・`` `f ``・`` `0 `` などがタブ・改頁・NUL になる。Markdown のコードの書式（バッククォート）を含む文字列は、単一引用符にする。
- 関数名を、既存のエイリアスと同じにしない。`R`（Invoke-History）、`rd`・`rm`・`sc` などは、同名の関数より先にエイリアスが実行される。`Verb-Noun` の形にする。
- 書いたら、制御文字がないことを確かめる。`npm run lint:control-chars`（追跡している全ファイル）か `npm run verify -- --changed` が、タブ・LF・CR 以外の制御文字と DEL を、ファイル・行・種類つきで報告する。

## ファイルロックと古いバイナリ

ファイルロックが出た場合は、まずこのプロジェクトのアプリ・ビルドを終了する。
別のビルドが動作中なら終了を待ち、対象のプロセスを特定する。
全cargo / rustcプロセスの一括強制終了や `cargo clean` を通常の解決手順にしない。
作業中の他プロジェクトを守り、対象を特定してから必要な操作だけを行う。

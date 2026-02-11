# VST Host ビルド・開発ガイド

## 前提条件

- Node.js (v18+)
- Rust (stable)
- Windows 10/11 (ASIO対応)

## プロジェクト構成

```
vst-host/
├── src/                    # React フロントエンド
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         # Tauri メインプロセス
│   │   ├── audio.rs        # オーディオエンジン IPC ラッパー
│   │   └── audio_engine/   # 別プロセスのオーディオエンジン
│   │       └── core.rs     # メイン処理
│   └── Cargo.toml
└── package.json
```

## 開発コマンド

### 1. 依存関係のインストール

```bash
cd vst-host
npm install
```

### 2. 開発モードで起動

```bash
npm run tauri dev
```

> **注意**: このコマンドはフロントエンドとTauriアプリをビルドしますが、**`audio_engine` バイナリは自動で再ビルドされません**。

### 3. audio_engine の手動ビルド

# コード変更後の手動リビルド（Windows / Mac共通）
npm run rebuild-engine

ビルドが成功したら、`npm run tauri dev` を再起動してください。

### 4. ファイルロックエラー対処

`os error 5` (Access Denied) が出る場合:

```powershell
# 全Rustプロセスを強制終了
taskkill /F /IM cargo.exe /IM rustc.exe /IM audio_engine.exe
```

その後、再度ビルドを実行。

## 配布用ビルド

### 1. リリースビルド作成

```bash
npm run tauri build
```

出力先: `src-tauri/target/release/bundle/`

### 2. 主な成果物

- `msi/` - Windows インストーラー
- `nsis/` - NSIS インストーラー (設定次第)

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|------|------|--------|
| ビルドが`Blocking waiting for file lock`で止まる | 別プロセスがロック中 | `taskkill` で強制終了 |
| 古いコードが実行される | audio_engine が再ビルドされていない | `cargo build --bin audio_engine` を手動実行 |
| プラグイン追加でクラッシュ | チャンネル数不一致 | 最新コードでビルドし直す |

## 便利なコマンド

```bash
# Rustコードのチェック (ビルドせず警告確認)
cargo check --bin audio_engine

# クリーンビルド
cargo clean && cargo build --bin audio_engine

# 全バイナリをリリースモードでビルド
cargo build --release
```

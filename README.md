# Auralyn

Auralyn（オーラリン）は、Tauri + React + Rust (Sidecarアーキテクチャ) で構築された、リアルタイム音声処理特化型の軽量VST3ホストアプリケーションです。配信（OBSやDiscordなど）でのマイク音声の品質向上や、リアルタイムでのエフェクト処理を簡単に行うことを目的としています。

## 主な機能

- **VST3 プラグインホスティング**: 標準的なシステムパスにインストールされたVST3エフェクトプラグインをスキャンし、ロード・実行します。
- **直感的なプラグインラック**: 複数のプラグインを直列に繋ぎ（シグナルチェーン）、順番の変更、ON/OFF切り替え、ゲイン調整をわかりやすいUIで行うことができます。
- **プラグインエディタ**: 汎用パラメータUIに加え、対応するVST3プラグインの独自GUIを別ウィンドウで開けます。
- **原音比較機能 (A/B テスト)**: ワンクリックでエフェクト適用前・適用後の音声を切り替えて、かかり具合を瞬時に比較できます。
- **オーディオデバイス管理**: WASAPIおよびASIOに対応しています。ASIO SDKはGPLv3の選択肢に基づいて利用します。入力機器（マイクなど）から出力機器（スピーカー等）までのルーティングを柔軟に設定できます。
- **ステート管理・プリセット**: 作成したエフェクトチェーン（ラックの状態）の保存や、プリセット・テンプレートの読み込みに対応。
- **レベルメーター**: リアルタイムなオーディオピークレベルを視覚的に確認できるメーターを搭載（見やすいラージメーター機能あり）。
- **堅牢な安定性設計**: オーディオ処理エンジンを独立したプロセス（`audio_engine.exe`）として実行するサイドカーパターンを採用。VSTプラグインがクラッシュしてもメインUIが巻き込まれず、自動リカバリを行う仕組みを備えています。
- **充実したガイド・機能**: 初回起動時のセットアップウィザードや、OBS・Discordなど主要な配信・通話ソフトと連携するためのガイドメニューをアプリ内に統合。

## こんな用途におすすめ

- 配信や通話時のマイクノイズを除去したい（ゲート、ノイズサプレッサー等）。
- 自分の声にイコライザー(EQ)やコンプレッサーをかけて、聞き取りやすく・魅力的にしたい。
- 複雑なDAW等を使わず、シンプルなUIでリアルタイムのエフェクト・音声ルーティングを完結させたい。

## システム要件

- **OS**: Windows 11 (64ビット版のみ対応)
- VST3エフェクトプラグイン（事前にお好みのプラグインをインストールしておく必要があります）
- ※ 現状、macOS、Linux には対応していません。

## 開発・ビルド環境

本プロジェクトは以下の技術で構成されています。
- [Tauri](https://tauri.app/) (デスクトップアプリケーション基盤)
- [React](https://reactjs.org/) + [TypeScript](https://www.typescriptlang.org/) (フロントエンドUI)
- [Rust](https://www.rust-lang.org/) (バックエンドおよびオーディオ処理エンジン)
- [Vite](https://vitejs.dev/) (フロントエンドビルドツール)
- [Tailwind CSS](https://tailwindcss.com/) (スタイリング、独自のダークモードテーマ採用)

### ビルドの準備
- Node.js (npm 付属)
- Rust ツールチェーン (`rustup`)
- Microsoft C++ Build Tools (WindowsでのRustコンパイル用)
- LLVM/Clang（`asio-sys`のbindgen用）
- [ASIO SDK](https://www.steinberg.net/asiosdk)（`asio-sys`がビルド時に取得。固定したSDKを使う場合は`CPAL_ASIO_DIR`を指定）

公式Source ZIPには、公式ビルドで使用したASIO SDK 2.3.4の`common`／`host`ソースとライセンスを含めています。Source ZIPから再ビルドする場合は、同梱SDKを`CPAL_ASIO_DIR`へ指定してください。

### 開発用コマンド
```bash
# lockfileどおりにパッケージをインストール
npm ci

# エンジン・スキャナーをビルドして開発用sidecarを準備
npm run rebuild-engine

# 開発用サーバーとTauriウィンドウの起動
npm run tauri dev

# プロダクションビルド（インストーラー生成等含む）
npm run tauri build
```

## 注意事項・現在の制限事項

開発・整備の入口は [AGENTS.md](AGENTS.md)、番号とタグの判断基準は [VERSIONING.md](docs/VERSIONING.md)、依存更新・代替の検討は [DEPENDENCY_MAINTENANCE.md](docs/DEPENDENCY_MAINTENANCE.md) を参照してください。

- **サポート形式**: サポートしているプラグイン形式は **VST3（ステレオ処理対応のもの）のみ** です。VST2やモノラル専用には対応していません。
- **プラグインUI**: 独自GUIの表示互換性はプラグインによって異なります。OTTには既知の表示崩れが残っており、すべてのプラグインの描画・操作を保証するものではありません。
- MIDI入力/出力やオートメーション機能はサポート外です。
- WASAPIは共有モードでのみ動作します（排他モードには対応していません）。
- 各環境やプラグインごとのレイテンシの完全な自動補正機能は初期リリース時点では含まれていません。

## インストール

一般のユーザーは、[Auralyn 公式配布ページ](https://kuro7983.com/apps/auralyn) から最新版のインストーラーをダウンロードして利用できます。

公式安定版はコード署名済みインストーラーとして配布します。未署名の検証版を例外的に配布する場合は、Releaseページでその旨とSHA-256を明示します。

## コントリビューション

本プロジェクトへの貢献（バグ報告、機能リクエスト、Pull Request）は歓迎します。

- 問題を見つけた場合は、GitHub の [Issues](../../issues) から報告をお願いします。
- 改善の提案やPRも受け付けています。

## ライセンス

Auralynの現行バージョンは [GNU General Public License version 3 only](LICENSE)（`GPL-3.0-only`）で公開します。複製、改変、再配布、有料配布が可能ですが、GPLv3の条件と対応ソースの提供義務を引き継ぐ必要があります。

過去にMIT Licenseを添付して配布された版について、すでに付与された権利を本変更が取り消すことはありません。各版には、その配布物に添付されたライセンスが適用されます。

公式バイナリと同一のGitコミットから生成した対応ソースZIP、SHA-256、manifestを、同じGitHub Releaseから無償で取得できます。詳細は [SOURCE-DISTRIBUTION.md](SOURCE-DISTRIBUTION.md) を確認してください。

## クレジット・権利表記

VST® は Steinberg Media Technologies GmbH の登録商標です。
ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.

本ソフトウェアは以下のオープンソースプロジェクトを利用して構築されています：

- [Tauri](https://tauri.app/) — デスクトップアプリケーション基盤
- [React](https://reactjs.org/) — フロントエンドUI
- [Rust](https://www.rust-lang.org/) — バックエンド・オーディオエンジン
- [vst3-rs](https://crates.io/crates/vst3) — VST3 ホスティング
- [cpal](https://crates.io/crates/cpal) — クロスプラットフォームオーディオ
- [nnnoiseless](https://crates.io/crates/nnnoiseless) — ノイズ抑制

利用しているすべてのライブラリのライセンス情報、Auralyn本体のGPLv3全文、権利表示は、アプリ内の「設定 > ライセンス情報」から確認できます。

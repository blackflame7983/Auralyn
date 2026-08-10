# Auralyn リリース計画書

**ドキュメントバージョン**: 1.1.0
**目的**: Auralynの公開・配布・運用に関する戦略と方針を定義する。

---

## 1. 配布戦略

### 1.1 配布場所と更新
*   **開発リポジトリ**: `blackflame7983/Auralyn`は当面Privateで維持できるが、配布した各版の対応ソースは必ず公開する。
*   **無料版配布**: `blackflame7983/Auralyn-Releases`のGitHub Releasesへ、署名済みインストーラー、Portable版、`latest.json`、同一コミットのSource ZIP、SHA-256、source manifestを配置する。
*   **更新方式**: Tauri Updaterを使用し、失敗時は`Auralyn-Releases`のRelease一覧へ誘導する。
*   **収益化**: AuralynはGPL版として配布し、任意支援、公式ビルド、サポート等を候補とする。排他的なソフトウェア販売は別プロダクトで設計する。

### 1.2 セキュリティとSmartScreen対策
*   **コード署名証明書**: 公式安定版の必須ゲートとする。未署名の無料検証版を出す場合は、その事実を明示する。
    *   *影響*: 未署名の場合、Windows SmartScreen により「認識されないアプリ」として警告が出る可能性が高い。
    *   *対策*:
        1.  Webサイトのダウンロードボタン付近に「**SmartScreenの警告が出る場合**」というFAQリンクまたはツールチップを設置する。
        2.  インストーラーのファイルハッシュ (SHA-256) をWebサイトに明記し、改ざんされていないことをユーザーが確認できるようにする。
*   **インストーラー形式**: `.msi` または `.exe` (NSIS)。現状のNSIS (`.exe`) で問題なし。

---

## 2. 環境定義とオーディオ仕様

### 2.1 対応環境
*   **OS**: **Windows 11 (x64) のみ**。
    *   *Windows 10*: サポート終了が近いため、初期サポートから除外して検証工数を削減する。
    *   *アーキテクチャ*: x64 のみ。ARM64 は対象外。

### 2.2 オーディオ仕様の正確な表記
*   **ASIO**: Steinberg ASIO SDK 2.3.4のGPLv3選択肢を利用する。SDK ZIPのSHA-256を固定し、同じSDKでビルドするとともに、使用した`common`／`host`ソースとライセンスを対応ソースへ含める。
*   **WASAPI**: 「対応 (Supported・共有モード)」。※排他モードではないことを注記しておくとトラブル防止になるが、一般ユーザーには「WASAPI対応」で十分。
*   **DirectSound**: 「非対応」。古い規格のため言及しなくて良い。
*   **遅延 (Latency)**:
    *   表記: 「**超低遅延 (環境依存)**」とし、具体的な数字（例: 5ms）は「※ハイスペック環境での理論値」として注釈に入れる程度に留める。
    *   アプリ内では実測値（バッファサイズに基づく計算値）を表示する。

---

## 3. 推奨ルーティング (仮想ケーブルの扱い)

「Auralynをどう使うか」の標準パターンを定義する。

### ケースA: OBS配信 (マイク音声を加工して配信)
1.  **Input**: 物理マイク (例: Audio Interface)
2.  **Processing**: Auralyn (VST3 Plugins)
3.  **Output**: **仮想オーディオケーブル (例: VB-Cable Input)**
4.  **OBS Mic Input**: **仮想オーディオケーブル (例: VB-Cable Output)**

### ケースB: Discord通話 (マイク音声を加工して通話)
1.  **Input**: 物理マイク
2.  **Processing**: Auralyn
3.  **Output**: **仮想オーディオケーブル**
4.  **Discord Input**: **仮想オーディオケーブル**

> **結論**: Auralyn自体は仮想デバイス機能を持たないため、他アプリへ音を送るには**仮想ケーブル（VB-Cable等）の併用が必須**となる。「仮想ケーブル不要」という表現を削除したのはこのため。
> サイトのFAQや「仕組み」セクションで、**VB-Audio Virtual Cable (無料版)** などの導入を案内する導線が必要。

---

## 4. 権利・ライセンス表記

### 4.1 必須表記
*   **Auralyn本体**: 現行版は`GPL-3.0-only`。公式配布物にはルート`LICENSE`と`NOTICE.md`を同梱し、過去のMIT版の権利は遡及変更しない。
*   **VST3 (Steinberg)**: VST3 SDKを使用しているため、以下の著作権表示が必須（About画面およびWebサイトのフッター/ライセンスページ）。
    > VST is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.
*   **ASIO (Steinberg)**: ASIO SDKを使用している場合。
    > ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.
    *   `config/release-policy.json`にGPL-3.0-only、公式SDK URL、確認日を記録し、対応ソースと同時に公開する。

### 4.2 サードパーティライセンス (Third Party Notices)
*   OSSライブラリ（Rustクレート、Reactライブラリ）のライセンスを一覧化したページまたはテキストファイルが必要。
*   *実装*: 生成したnpm/CargoライセンスとAuralyn本体の`NOTICE.md`・GPLv3全文を、アプリ内の「ライセンス」モーダルに表示する。

---

## 5. 安全策と互換性

### 5.1 プラグインスキャン
*   **対象フォルダ**: システム標準の `C:\Program Files\Common Files\VST3` を固定（初期リリース）。
    *   ユーザーによるカスタムパス追加は「将来機能」とする。
*   **クラッシュ対策**:
    *   **サイドカー分離**: エンジンが落ちてもUIは生き残るため、ユーザーに「エンジンがクラッシュしました。再起動しますか？」と通知を出して復帰させる。
    *   **セーフモード**: 起動時に特定のプラグインで連続クラッシュした場合、そのプラグインをブラックリスト化して起動する機能を（将来的に）実装する。

---

## 6. サポート・法務

### 6.1 サポート導線
*   **不具合報告**: Googleフォーム 等の問い合わせフォームを用意する。
    *   GitHub Issues は開発者向けに見えるため、一般ユーザーにはフォームの方が親切。
    *   フォーム項目: OSバージョン、オーディオデバイス名、発生した現象、ログファイル（あれば）。

### 6.2 法務ドキュメント
*   **GPL・NOTICE**:
    *   GPLv3全文を`LICENSE`として同梱する。
    *   アプリ内のライセンス画面で著作権、再配布可能、無保証、ライセンス全文への導線を表示する。
    *   独自EULAでGPLの権利を追加制限しない。
*   **プライバシーポリシー**:
    *   個人情報を収集しない場合でも、「収集しない」旨を明記する。
    *   Google Analytics等をサイトに入れるなら、Cookie利用の同意が必要。

---

## 7. コンテンツ運用

### 7.1 バージョン表記の運用
*   `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`は`npm run set-version -- <version>`で同期する。
*   Tauri Updaterの`latest.json`とReleaseタグも同じバージョンにする。
*   公開前に`npm run release:check`を実行し、公開先、GPLメタデータ、ASIO GPL選択、lockfileのGit管理を検証する。
*   `npm run release:upload -- <version>`はcleanなHEADから署名バイナリを再ビルドした後、同じHEADのSource ZIP・SHA-256・manifestを生成し、同じReleaseへアップロードする。

---

---

## 8. デザイン整合性

*   **アプリとサイトの共通点**:
    *   **テーマ**: どちらも「Dark Mode」をベースとしたサイバー・スレート調で一致している。
    *   **CSSフレームワーク**: アプリ(Tailwind v4) と サイト(Tailwind推奨) で技術スタックも共通しており、カラーパレット（`#0a0f1a`など）の変数共有が容易。
*   **結論**:
    *   「Dark Mode Only」「Tailwind推奨」というサイト側の前提は、Auralynアプリのデザイン指針と完全に合致しており、ブランドイメージの統一が可能。
    *   アプリ内のコンポーネント（ボタンやカードのデザイン）をWebサイトに流用することも技術的に容易である。


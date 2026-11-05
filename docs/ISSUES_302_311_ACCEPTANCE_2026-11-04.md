# Issue #302〜#311 の対応・確認記録

確認日: 2026-11-04。対象ブランチ: `codex/issues-302-311-20261104`。
その後の#309の実機再現・追加修正は[原因調査と復帰確認](ISSUE_309_INVESTIGATION_2026-11-04.md)を参照。本書は前回候補での確認記録として保持する。
GitHubで確認した追加Issueは#302〜#311。ローカル実装・検証の記録であり、Issueのクローズ、push、PR作成、公開は行っていない。

## 対応内容

| Issue | 対応と確認範囲 |
| --- | --- |
| #302 | 「変更予定」は利用者が操作した接続項目だけを比較する。初回は保存・開始する接続内容を表示し、設定を開いただけでは変更として数えない。 |
| #303 | 未設定時はWASAPIを優先し、ASIOは明示選択する。保存済みASIOは復元する。ASIOしかない場合も自動選択しない。 |
| #304 | ホームとセットアップでOBS・通話・自分で聴く・その他の順序、名前、アイコンを共通化。自分で聴く場合はマイクとPC音声を選べ、旧`music`設定も保持する。 |
| #305 | ASIOの入出力が同じ機器になる説明を機器欄の直下へ配置。 |
| #306 | 共通のマイク許可案内を設定・セットアップの入力機器欄の近くへ配置。PC音声の選択には表示しない。 |
| #307 | 音声未設定は中立色、状態不明は警告色、設定済み停止は赤、稼働中は緑に分ける。 |
| #308 | 無効な「次へ」を3テーマで区別し、入力未選択の理由を近くに表示。900×600・150%の確認で見つかったフッターの画面外へのはみ出しも修正。 |
| #309 | 保存を一時ファイル・同期・置換の既存共通処理に統一。設定画面に保存済み設定の明示読み込みを追加。元の設定消失原因とVoicemeeterの実機開始失敗は未確認のため、部分対応。詳細は次節。 |
| #310 | OBS設計文書を、送信側の別ブランチと独立したAuralyn-OBS試作の現状へ更新。Windows x64・OBS 32.2.2の確認と公開Releaseがない状態を区別。 |
| #311 | 通常設定のグローバルAPI無効を維持し、debug用上書き、版を固定したCLI起動、接続状態・撮影・操作の確認手順をビルド・試験文書へ追記。 |

## #309 の到達点と未確認事項

当時のCodexコマンド／MCP実行環境では、WebViewの保存済みhostがない一方、ネイティブ側の`last_audio_config.json`は存在した。サイズ268 bytes・更新日時2026-10-31 15:09:27はそこでの調査前後で同じだった。#309追記の利用者環境では通常版が空・APIはnullと報告されており、この観察を利用者の通常環境の状態として扱わない。確認したパスと環境の訂正は[後続調査](ISSUE_309_INVESTIGATION_2026-11-04.md)を参照する。

新しい読み込み操作は、現在のアプリ保存先にある音声設定だけを読み、設定画面へ戻す。音声開始、VST復元、移行完了扱い、別の保存先からの自動取得は行わない。ファイルがない場合と破損時はそのまま残して結果を表示する。プロセス入力は候補の再選択が必要になる。

Rustでは、開始世代の拒否前後で設定が残ること、Windowsで保存対象をロックした場合に旧ファイルと別保存先を保護し一時ファイルを片付けること、解除後の再試行、保存先を跨がない読み込み、破損ファイルを変更しないことを確認した。これらは実際のASIOドライバー開始失敗の再現ではない。

隔離した実Hostでも、既存ネイティブ設定の読み込み後にWASAPI・buffer 256がフロント側へ復元され、音声のrunning・playingがともにfalseであることを確認した。#289のVoicemeeter実機試験と元の消失原因の特定は引き続き残る。

## 検証結果

| 確認 | 結果 |
| --- | --- |
| 全Vitest | 148ファイル・1,575件成功。 |
| TypeScript / Vite | `npx tsc --noEmit`、`npx vite build`成功。 |
| ブラウザ | settings-followup・settings-issues・settings-discovery・asio-routing・home-actions・layoutの62件成功。日英・3テーマ、初回設定、ASIO案内、送り先、無効状態、保存復帰を確認。IPCモックであり実ドライバーの証拠ではない。 |
| デザイン検出 | 最終候補の検出結果は空。実画面・操作試験も併用。採点の更新は行っていない。 |
| Rust対象試験 | `cargo test --locked --lib audio_config`の5件成功。 |
| Rust全体 | `cargo test --locked`成功。ライブラリ713件成功・5件ignore、sidecarなどの統合試験も成功。実機録音・OTTを要求するignore試験は実行していない。 |
| Rust静的確認 | `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`成功。変更したRustファイルをrustfmtで整形。 |
| 実アプリ / MCP | 現行Host・engine・scannerをビルド。保存先を分離したHostへCLI 0.13.2で接続し`connected: true`、撮影、外観タブへのクリック、保存済み設定の読み込みを確認。通常設定・capabilityは変更していない。専用Hostは終了し接続を解除。 |
| 差分 | `git diff --check`成功。既存の未追跡設計合意文書は編集・追加しない。 |

Rust全体試験の初回は`windows_sys`のrlib不足でビルドが失敗した。キャッシュ削除や依存変更は行わず、対象統合試験の再実行と続く全体再実行で成功した。初回失敗の根本原因は断定しない。

ローカル証拠の保存先は`%USERPROFILE%/.codex/tmp/auralyn-302-validation-20261104-0f86a31b/`。
主な記録は`unit-accepted.log`、`browser-accepted.log`、`build-final.log`、`rust-tests-final.log`、`rust-check-final.log`、`rust-clippy-final.log`、`rust-all.log`、`rust-integration-verbose.log`、`rust-all-retry.log`、`native-session.log`、`native-session.json`。画面証拠は`browser-accepted/`と`native-before.png`・`native-after.png`・`native-restored.png`に保持する。

## 今回の完了に含めないもの

- Voicemeeterを含む実ドライバーの開始・音声到達・聴感・長時間運転。
- #291のセットアップでのASIO対応、および#301の画面全体の再設計。
- ユーザー所有の`docs/UI_REDESIGN_DECISIONS_2026-11-04.md`の編集。
- OBS送信側のブランチ統合、プラグインのRelease公開、配布。

# #312〜#314・#309追記の対応記録

2026-11-04。ベース`6ea4369`、ブランチ`codex/issues-312-314-20261104`。ローカル変更・検証の記録であり、push・PR作成・Issueの更新は行っていない。

## 修正

| 対象 | 結果 |
| --- | --- |
| #312 | 未設定時はWindowsの既定入力・出力を優先。既定がない・曖昧な場合は未選択とし、入力が再生リダイレクト・仮想ケーブル・ループバック系の場合も選択を求める。保存済みIDは優先し、消失時に別の既定へ切り替えない。手動の未選択も直後に自動選択へ戻さない。 |
| #312の実機調査 | 名前が同じ3台すべてが`is_default=true`になる既存の判定を発見。エンジンの機器列挙を既定の機器IDとの比較へ変更。ID不明なら既定扱いにしない。 |
| #313 | 設定を開くと保存の有無と形式を確認し、画面が空かつ有効な保存がある場合だけ復帰ボタンと説明を表示。入力・出力の後に補助的なリンクとして置く。読み込みだけでは音声を開始しない。 |
| #314 | 共通の表示関数でWASAPI・ASIOを表記し、設定の要約・選択肢・初回表示・ヘッダー詳細・技術情報・移行・測定結果へ適用。内部の接続方式やIPC引数は変更しない。日本語の「PCの音」を統一。 |
| #309の記録訂正 | 268 bytesのファイルとport 9223のHost確認はCodex実行環境の観察としてパスを明記。利用者通常環境の「通常版は空、MSIX試作版に159 bytesのみ」と区別し、以前の通常環境という断定を訂正。MSIX設定を通常版へコピーしない。 |
| #309の古いsidecar | `rebuild-engine`がビルド先変更時にも固定の`src-tauri/target/debug`からコピーする不具合を修正。Cargo metadataの`target_directory`を使い、両成果物を確認してからコピー。開発ガイドに同じtargetの利用とHost再起動、実行パス・ハッシュの確認を追記。 |

## 実アプリと実機

このCodex実行環境で`npm run rebuild-engine`を実行し、エンジン・スキャナーを現行ソースから再ビルドした。Cargo出力・`src-tauri/bin`のコピー・隔離Hostで使う実行ファイルのSHA256を照合し、すべて一致した。起動中の利用者Host／sidecarの置き換え・停止は行っていない。

確認用identifierは`com.auralyn.test.issue312`、保存先は`%TEMP%/Auralyn-312-XMC7T6/config`、WebView originは`http://127.0.0.1:1428`、MCP bridgeは9224。保存先を指定した専用Hostを現行ソースからビルドし、engineとscannerは`rebuild-engine`のコピー品を利用した。

- 修正前は同名のマイク3台に既定の印が付いた。修正後はIDの一致する1台だけとなった。この実行環境では「マイク (2)」が既定で、画面もそのIDを選択した。利用者の報告の「マイク (1)」を名前だけで固定しない。
- 出力は実際のWindows既定であるVoicemeeter Inputを選択し、一覧先頭のVoicemeeter In 2を選ばない。出力のOS既定が仮想機器の場合はその明示された既定を使う。
- 保存APIがnullの初回画面で、復帰ボタンと説明はなく、フッターの接続方式はWASAPIだった。実画面も撮影した。
- 利用者から得た前回の実機試験許可の範囲で、専用保存先・全体ミュートでVoicemeeter Insert Virtual ASIOへ48 kHz・512を要求。3回とも既定の96 kHz・512への再試行で開始し、running=true・streamFailed=falseを確認。各回停止し、最後はrunning=false。正常設定は専用保存先にのみ保存された。
- 試験後は専用Hostを終了し、MCPを切断。通常の音声・Windows音量・Voicemeeter設定は変更していない。

これは利用者側で動作中だった18:12ビルドの`tauri dev`を更新・再確認した証拠ではない。利用者環境での適用には、利用中の音声を停止できる時点でHostを終了し、同じ`CARGO_TARGET_DIR`で`npm run rebuild-engine`後に再起動する。元の空フォルダーの履歴・原因、MSIX実パッケージ、聴感、長時間運転、他ASIOの受入は残る。

## 検証と証拠

- Vitest: 148ファイル・1,588件成功。既定優先、不在・複数・仮想入力、保存機器の消失、復帰ボタンの不在・存在・非開始を確認。
- ブラウザ: 設定・ASIO・送り先の44件成功。日英・3テーマで、既定なしの未選択、明示選択後の開始可否、保存なしのUI、復帰ボタンの配置と動作、WASAPI表記を確認。IPCモックでありドライバーの証拠とは区別する。
- `npx tsc --noEmit`、`npx vite build`成功。
- `cargo test --locked`成功。ライブラリ713件成功・5件ignore、sidecarなどの統合試験も成功。実機録音・OTTのignore試験は実行していない。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`成功。Rust変更ファイルをrustfmtで整形し、`git diff --check`成功。
- 最終UI候補のデザイン検出は指摘なし。利用者所有の未追跡設計文書と既存の`.claude/`・`target/`は編集・ステージしない。

証拠の保存先は`%USERPROFILE%/.codex/tmp/auralyn-312-validation-20261104-1b739a8c/`。`unit-final.log`、`browser-final.log`・`browser-final/`、`tsc-final.log`、`build.log`、`rust-test.log`、`rust-check.log`、`rust-clippy.log`、`design-detect.json`、`rebuild-engine-final.log`、`rebuild-hashes-final.json`、`native-initial-final.json`・`.png`、`native-engine-path.json`、`native-48k-rebuilt.json`、`native-host-final.log`を保持する。最初の実行では旧表記・先頭自動選択を前提とする試験と、閉じた詳細欄の検索を修正した。初回の1件の自動表示失敗は、最終実行では再現していない。

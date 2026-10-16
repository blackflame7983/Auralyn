# Clippy警告の安全性優先の限定修正

確認日: 2026-10-16。基準HEADは `2c025b2`、ブランチは `codex/clippy-safety-fixes`。
`cargo clippy --locked --all-targets --message-format=json` の診断をコード・ファイル・行で重複除去し、70箇所を確認した。

## 修正した範囲

- VSTエディタの `cast_abs_to_unsigned` 2箇所。単にunsigned_absへ置き換えても、その前の符号付き減算overflowや反転矩形の問題は残るため、共通のchecked_sizeで正の幅・高さを検査する。
- 同じプラグイン由来の矩形を使うgetSize・サイズ制約・resizeView経路もchecked_sizeへ揃えた。無効なresizeViewはエラーを返し、最終サイズが無効なエディタはviewを切断して子HWNDを破棄してから親ウィンドウを破棄する。制約取得が失敗・不正な場合の既存800×600 fallbackは維持する。
- VSTのplanar出力処理にある `needless_range_loop` 1箇所と周辺の境界処理。これまで、使用する各Vecの長さを確認せずにnum_samplesと生ポインタをプラグインへ渡していた。短いVecではプラグインの通常処理が領域外へ到達し得るため、FFIより前に長さ・フレーム数・有効チャンネルを検査する。
- 不正ブロック・停止中・欠損Processor・プラグイン処理エラーでは、実在する出力領域を無音化する。ブロック外の末尾は維持する。過大ブロック時のRTログ出力も除去した。検査と無音化に新たな割当・ロック・I/Oは追加しない。

音声エンジンの通常経路は既にバッファを準備している。実機で領域外アクセスが発生したと再現・断定したものではなく、安全な公開メソッドの境界保証不足を修正した。
依存更新、音声アルゴリズム・係数の変更、VSTモジュールの初期化・終了方針の変更は行わない。

## 残した警告

Defaultの提案、条件の統合、型の複雑さ、引数数、命名・数字の書式などは安全性・不具合の修正に必要ではないため保留した。
他のDSPループや浮動小数点係数の精度、min/max → clampの提案は、計算結果・NaNの扱い・実時間処理への影響を確認せず機械的に適用しない。
`cargo clippy --fix`、一括整形、警告抑制は使っていない。

## ローカル検証

- 追加4テストを含む37 lib + 2 audio queueテストが成功。
- 模擬Processorで、短い入力・出力、空チャンネル、過大・極端なフレーム数がFFIへ到達しないことを確認。正常な左右チャンネル、未使用チャンネルの無音化、末尾の維持、処理エラー・停止・欠損時の無音化も確認した。
- 矩形のoffset付き正常サイズ、減算overflow、反転、空サイズを確認。extern resizeViewがpanicせず無効引数を返すことも確認した。
- 実OTTの寿命テスト1件が成功。複数インスタンス・遅延解放・正常なメモリ内無音処理を確認。実機ストリームは開始しない。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets` が成功。重複除去した警告箇所は70 → 67。同じ警告がlib / lib testへ複製される出力の総件数とは区別する。
- 新規テストファイルの個別rustfmt検査とgit diff --checkが成功。既存全体の一括整形は行わない。
- `cargo build --locked --bins` が成功。最新ビルドでOTT / TDR Novaの描画、重複起動防止、閉じる・再表示3回、リサイズ、表示中削除を確認した。OTTの複数同時表示、独立したDEPTH操作・状態復元、削除後再ロード5回も成功。
- 検証用プロセスは終了し、実機の音声ストリームは開始しなかった。既存の配布sidecarは上書きせず、依存manifest / lockfileとアプリ番号も変更しない。

Clippyの診断、検証ログはignoredの `src-tauri/target/clippy-safety-*` に保存する。
高DPI・全VST・実機WASAPI / ASIO・長時間音声・性能測定・署名済み配布は未検証。単体テストをプラグイン全般の安全性や音質保証とは扱わない。
push・PR作成・アプリ番号変更は行っていない。

参考: [VST3 ProcessDataのフレーム数・バッファ契約](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/structSteinberg_1_1Vst_1_1ProcessData.html)。Clippyの提案だけを安全性の保証として扱わず、実際のFFI呼出しと境界条件を確認した。

## 差分レビューと追加修正（2026-10-16）

レビュー用ブランチは `codex/review-clippy-safety`。上記の未コミット差分を引き継ぎ、エディタの後始末と音声FFIの使用領域、正常経路・RTへの影響を確認した。

- 追加で修正した不具合: `resize_hwnd_client` は正のクライアント寸法でも、Windowsがウィンドウ枠を加えた後の減算でi32を超え得た。extern resizeViewから到達するとpanicや不正寸法につながるため、外側矩形にもchecked_sizeを適用し、SetWindowPos前に拒否する。通常のサイズ方針・DPI API・DLL寿命管理は変更しない。
- 無効な最終矩形での後始末は、view切断 → 子HWND破棄 → ローカルの親Window破棄の順序であることをコードで確認した。無効矩形を返す実プラグインを用いた、このエラー経路全体の実行検証は行っていない。
- planar経路は、使用する入力・出力の長さとフレーム数をFFI前に確認し、無効時は実在する出力の範囲だけを無音化する。通常のチャンネル対応と処理結果は模擬Processorで検証した。ゼロフレーム時はFFIを呼ばず出力を維持する（この経路はイベント・パラメータflushを実装していない）。
- テストの模擬ProcessorはUnsafeCellでFFIによる変更を明示した。テスト専用allocatorで、正常・短い入力・過大ブロック・ゼロフレーム・処理失敗・停止・欠損の各経路を測定し、初回呼出しを含め確保0・解放0を確認した。測定器自身も既知の確保・解放を検出することを確認した。製品のallocatorは変更しない。実DLL内の確保や、実機での時間上限・音切れを保証する測定ではない。

追加した2テストを含む39 lib + 2 audio queueテスト、実OTT寿命テスト1件が成功した。非表示の実Win32ウィンドウで310×440への正常リサイズと、枠加算による幅・高さのoverflow、i32最大値、ゼロ幅の拒否を検証し、拒否時に元のウィンドウ寸法を維持することを確認した。

`cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json`、`cargo build --locked --bins`、新規テストファイルのrustfmt検査、`git diff --check` が成功した。Clippyは各診断の最初のprimary spanをコード・ファイル・行で重複除去して67箇所、レビュー前から増加なし。

最新debug sidecarでOTT（310×440）とTDR Nova（830×598）の描画を画像でも確認した。重複表示防止、開閉・再表示3回、リサイズ、表示中削除、複数OTTの独立DEPTH操作・状態復元、削除後再ロード5回が成功した。検証用プロセスは終了した。

今回のログはignoredの `src-tauri/target/clippy-safety-review-*` に保存する。実機音声、長時間運転、CPU・遅延測定、高DPI、全VSTは未検証。依存manifest / lockfile、配布sidecar、アプリ番号は変更せず、push・PR作成は行わない。

参考: [AdjustWindowRectExによるクライアント矩形から外側矩形への変換](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-adjustwindowrectex)。

PR前の独立検証では、今回追加したエラー文・境界条件の改行だけをrustfmtに合わせた。候補Rust全体のrustfmt検査は、既存のlog::debug・ModuleEntry・queryの未整形箇所で失敗する。新規テストの個別検査は成功しており、既存箇所の一括整形は含めない。

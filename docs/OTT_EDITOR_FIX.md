# OTTエディタの描画欠け修正

確認日: 2026-10-15。基準はPR #5マージ後の `dfd241d`、作業ブランチは `codex/fix-ott-editor`。

## 再現条件と原因

Windows 11 x64、96 DPI（100%表示）、インストール済みOTT 1.37のVST3で確認した。
音声ストリームを開始せず、最新ソースのaudio_engineからLoadPlugin → OpenEditorを実行すると、背景・ノブ・ロゴが欠け、黒い領域が広く残った。
表示は成功扱いでも、IPlugView::getSizeは接続前後とも4×4を返し、ホストが800×600へフォールバックしていた。
生成された子ウィンドウのクラス名も `VSTGUI0000000000000000` で、モジュールハンドルが初期化されていない状態だった。

DLLロードからGetPluginFactoryへ進む実装が、OTTの公開するInitDllを呼んでいなかった。
InitDllだけを追加する対照実験で、getSizeが310×440となり、子ウィンドウのクラス名に有効なモジュールハンドルが入り、背景・ノブ・ロゴが描画された。
サイズの強制変更やDPI値を追加変更しなくても改善したため、今回の症状の原因をモジュール初期化の欠落と判断した。
独立した画像ファイルの欠落を原因とする証拠はなかった。

[Steinbergのロード手順](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/VST%2BModule%2BArchitecture/Loading.html)では、WindowsのInitDll / ExitDllは任意のエクスポートだが、存在する場合はfactory利用前の初期化と、利用終了後の終了処理に使う。

## 修正範囲と寿命管理

- 今回はファイル名がOTTのプラグインに適用を限定し、InitDllがあればGetPluginFactory利用前に呼ぶ。他のVSTの初期化手順は変更しない。
- 初期化がfalseを返した場合はロードエラーにする。初期化なし・初期化失敗時にExitDllを呼ばない。
- DLLと初期化ガードを共有所有し、Instance、Processor、既存の遅延解放・DLL保持先の参照が残る間は終了処理を実行しない。
- 最後の参照が解放された時、対応するExitDllを一度呼び、その後にLibraryを解放する。既存のDLL保持方針を維持する。
- OTTのfactory取得参照は、ロード時のインスタンス生成が完了すると解放する。ロード途中の失敗でもガードが先に参照を解放し、ExitDllより後までfactory参照を残さない。他VSTのfactoryの扱いは今回変更しない。
- 既存のエディタ接続・切断順序、サイズ交渉、OTT向け描画回避策は今回変更しない。依存ライブラリの更新や音声処理の変更も行わない。

## ローカル検証結果

- Rustの32 libテストと2 audio queueテストが成功。新規テストは共有所有の最後の解放までExitDllが遅れること、初期化成功・失敗・任意エクスポート欠落の扱いを確認した。
- cargo check / clippy --locked --all-targets、cargo build --locked --binsが成功。既存のClippy警告は残る。
- 修正版でOTTを複数同時表示し、各エディタの310×440と有効なVSTGUIクラスを確認。
- 片方のDEPTHを100% → 80%へドラッグし、保存状態が変化することと、もう片方の保存状態が変わらないことを確認。元の状態の復元も成功。
- 一方のOTT削除後も残るエディタが有効で、新しいOTTの追加・表示も成功。削除・再ロードを5回繰り返して成功。
- OTTとTDR Novaで、重複起動防止、開閉・再表示3回、リサイズ、表示中削除を確認。TDR Novaは830×598の描画も画像で確認した。
- 検証用の音声ストリームは開始せず、プロセスを終了。APPDATAや利用者のプリセット、既存の配布sidecarには書き込まない。

調査ログ・比較画像はローカルのignored `src-tauri/target/ott-editor-investigation/` に保存し、配布ソースには含めない。
ビルド中にtauri-buildが古い配布sidecarをtarget/debugへコピーするため、ビルド完了後の実行ファイルで再現と修正後を確認した。

100%以外の実DPI、異なるOTT版、全VST、長時間の音声運転、インストーラー・署名済み配布は未検証。
アプリ番号は1.1.0のまま。push・PR作成・公開は行っていない。

## 寿命管理の追加レビュー（2026-10-15）

`codex/review-ott-editor` で初期化・複数インスタンス・通常削除・遅延削除・Engine終了時の破棄順序を確認した。
既存コードがGetPluginFactoryで得た参照を解放しておらず、新しいExitDllより後まで残る不足を修正した。
OTTのロード内にfactory参照のガードを置き、成功時と失敗時に必ず解放する。他VSTへの解放処理追加は行わない。

[SDKのdllmain.cpp](https://github.com/steinbergmedia/vst3_public_sdk/blob/master/source/main/dllmain.cpp)はInitDll / ExitDllの対をカウントするため、同じDLLを複数ロードした場合の対応は妥当と確認した。
エディタはInstance破棄前に切断し、Processorは既存のretire経路で先に解放、保持済みDLLは既存方針どおり保持する。
InitDllがない場合と初期化失敗時にはExitDllを呼ばず、呼出し先DLLは終了処理の完了まで保持する。

- Rustの33 lib + 2 audio queueテストが成功。追加テストは失敗時のfactory解放 → ExitDllの順序を確認。
- 実OTTの遅延解放・共有寿命テスト1件が成功。2つを追加し、一方をretire後も残るProcessorでメモリ内の無音を処理でき、状態が維持されることを確認。保持先が残る状態で再ロードし、独立した共有参照を最後に解放する経路も確認した。
- この実OTTテストは通常実行ではignoreされる。インストール済みOTTがある環境で、`src-tauri`から `cargo test --locked --test ott_module_lifetime -- --ignored` と明示して実行する。実機ストリーム・録音・出音は開始しない。必要に応じて `AURALYN_TEST_OTT_PATH` を実体のOTT.vst3へ指定する。
- factory参照の修正後にも、複数OTTの表示・独立したDEPTH操作・状態復元・削除後再ロード5回が成功。OTTとTDR Novaの開閉・再表示3回、リサイズ、表示中削除、両エディタの描画も再確認した。
- cargo check / clippy --locked --all-targets、cargo build --locked --bins、git diff --checkが成功。既存のClippy警告は残る。新規の実OTTテストは個別rustfmt検査も成功。
- 今回の比較ログ・画像はignored `src-tauri/target/ott-editor-review/` に保存した。音声系依存のmanifest / lockfile、アプリ番号、既存の配布sidecarは変更していない。

高DPI・他バージョンのOTT・全VST・長時間音声・配布の未検証範囲は引き続き残る。

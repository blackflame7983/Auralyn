# MSIX互換性試作

Issue [#4](https://github.com/blackflame7983/Auralyn/issues/4) の、外部VST3・サイドカー・設定保存・OBS通信を確認するためのローカル試作。
Store提出用のパッケージではない。

## 構成

- `packaging/msix-prototype/AppxManifest.xml` に試験専用Identityを定義する。
  `packagedClassicApp` / `mediumIL` / `runFullTrust` のWin32アプリとして実行する。
- 通常のreleaseビルドの本体と、配布用に準備された2本のサイドカーを同じフォルダーに配置する。
  本体の隣にある `audio_engine.exe` と `plugin_scanner.exe` を既存の探索処理で起動する。
- ロゴと `LICENSE`、`NOTICE.md`、`SOURCE-DISTRIBUTION.md` を含める。
  外部VST、VB-CABLE、Voicemeeter、ASIOドライバー、証明書・秘密鍵は含めない。
- マイク権限を宣言する。仮想ケーブルもWindowsの録音権限の対象となる。
  権限が拒否されていると、ASIOが動いてもWASAPIの入力開始は失敗する場合がある。

この試作はDSP・通常のNSIS配布を変更しない。
MSIX版では通常版のupdaterを無効化する。更新経路とマイク権限の案内は下記「更新経路とマイク権限」を参照する。

## 更新経路とマイク権限

Windowsの `GetCurrentPackageFullName` で起動時にパッケージIDの有無を確認する。
フロントの設定値や実行パスからは判定しない。

| 実行形式 | ヘルプの更新操作 | ネイティブ側 |
| --- | --- | --- |
| 通常配布版（パッケージIDなし） | 従来の更新確認・確認後のインストールと再起動 | Tauri Updaterを登録 |
| MSIX版（試作版も含む） | 更新方法を表示。Store入手版はStoreの更新画面、直接配布は同じ配布元のMSIXを案内 | Tauri Updaterを登録せず、通常版の更新IPCを呼ばれても実行しない |
| 判定不能・判定IPCの失敗 | 再起動後の再試行を案内 | OS側の判定不能時はTauri Updaterを登録しない |

パッケージIDだけではStore入手版かサイドロード版かを区別できないため、Storeから入手したと断定しない。
Storeの製品IDは未設定で、製品ページへのリンクやStoreへの更新照会は追加しない。
Store入手版の自動更新はStoreの設定に従い、アプリ独自の定期確認・ダウンロードは追加しない。
Storeの更新画面を開く操作は、Auralynの更新成功を意味しない。

初回セットアップの入力選択・接続確認と、オーディオ設定にマイク権限の案内を置く。
Windowsのマイク全体・アプリのアクセス許可に加え、MSIX版は表示されるアプリ個別の許可、通常配布版はデスクトップアプリの許可を案内する。
英語・日本語のアクセス拒否と `0x80070005` を認識し、起動失敗時に案内を表示する。
アクセス拒否だけで権限が原因と断定せず、デバイス占有の可能性も案内する。
OSの許可状態を推測した表示や、権限要求・レジストリ変更は行わない。
権限を変更した後は選択中の入出力を保ち、利用者の操作で起動を再試行する。

設定画面へのIPCは固定の2種類だけを受け付ける。
起動に失敗した場合も、画面上にWindowsの設定やStoreを手動で開く手順を残す。

- [パッケージIDの確認（Microsoft）](https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getcurrentpackagefullname)
- [Storeの更新画面URI（Microsoft）](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-store-app)
- [マイク設定URI（Microsoft）](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)

### 2026-10-21の更新経路・権限案内のローカル検証

- UIテスト239件が成功。MSIX・通常配布・判定不能・IPC失敗の分岐、ヘルプメニューを閉じた後の更新案内、Store／設定起動の失敗と再試行、入力選択と保存済み設定の保持、初回セットアップのテスト開始／保存開始の拒否後再試行を含む。
- Rustのライブラリ99件と音声キュー契約2件が成功。パッケージ判定の正常・異常応答、現在のWindowsプロセスでの判定API呼び出し、固定ターゲット以外の拒否、日本語・英語・HRESULTのアクセス拒否案内を含む。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`、TypeScript型検査、Viteビルド、配布関連テスト45件、release整合チェックが成功。
- UI全体テストは並行ビルド中に既存の遅延読み込み2件がタイムアウトしたが、重いビルド終了後の再実行では全件成功した。

OS設定起動のUIテストはIPCモックで、権限の実状態やインストールしたMSIXの動作を検証するものではない。
この自動テスト段階では署名・インストール・900×600の実アプリ・マイク録音・実Store更新を再実行していない。
その後の署名・インストールと権限切替の確認は、次の実機検証として区別する。

### 2026-10-21の実MSIX・900×600検証

最新ソースを `npm run tauri -- build --no-bundle --ci` で再ビルドし、本体と `src-tauri/bin` の配布用サイドカーを同じ試験用runtimeへ揃えた。
自己署名したMSIXをWindowsにインストールし、本体・エンジンに試験パッケージIDが付いていること、インストール先の3 EXEがruntimeのSHA-256と一致することを確認した。
Storeへの提出・公開は行っていない。

| 確認項目 | 結果 |
| --- | --- |
| 通常起動 | 本体・エンジンともパッケージIDなし。`get_distribution` は `standalone`。ヘルプの「アップデートを確認」から実際に確認し、「最新バージョンです」を表示。更新IPCも実行可能で、今回の応答は更新なし |
| MSIX起動 | `get_distribution` は `msix`。「更新方法を確認」からStore／直接配布の案内を表示。通常版の更新IPCを直接呼んでも `plugin updater not found` で拒否 |
| Storeへの導線 | 案内内のボタンからStoreの起動を確認。検証ツールの制約でStore側の画面内容は撮影していない。試作Identityなので、StoreからAuralynを更新する試験ではない |
| 権限拒否 | 初回は個別権限が `Allow` で入力開始に成功したため、利用者がWindows設定で試験アプリだけをOFFに変更。`Deny` の状態でWASAPI入力開始が拒否され、日本語の案内が展開。実ストリームは停止状態 |
| 選択と保存値の保持 | 拒否前に未保存で選んだVoicemeeter Out B2とSteamStreamingスピーカーを、エラーから「設定に戻って再試行」した後も保持。保存済みのCABLE Outputは失敗によって上書きされなかった |
| 許可後の再試行 | 利用者が個別権限をONへ戻しても自動再開しない。「保存して開始」の明示操作後、保持していたB2入力／SteamStreaming出力、48kHz／512 framesで `running=true`・`streamFailed=false`。画面を開き直しても選択を保持 |
| 900×600 | WebViewの実寸900×600で更新メニュー、更新案内、権限案内、入出力選択、拒否後の再試行を操作。長い案内・エラーは本文スクロールで到達でき、通常の音声設定では保存ボタンの固定フッターも表示 |

Windows操作ツールは `failed to write kernel assets` で初期化できず、アプリ内はrelease WebView2の検証用接続から操作・撮影した。
Windows設定での権限OFF／ONと管理者の証明書登録は利用者が実行し、こちらで実際の権限記録とストリーム状態を読み取った。
レジストリで権限を許可・拒否する迂回は行っていない。
実マイクの発話・聴感・長時間音声・実Store更新は今回の検証対象外。
この時点では暗色テーマの拒否エラー本文のコントラストが低く、改善候補として残した。後述のP2修正で対応する。

本体・サイドカーのSHA-256:

| ファイル | SHA-256 |
| --- | --- |
| AuralynHost.exe | `D4F9DDB4A877F68B28D4F4C9DFA44797293F03D0BBF27A91D47924FD8CF7334D` |
| audio_engine.exe | `F9A768F49FA3FCEF973FC37F2AC3953AB056BBCFA13908A3C53002AB5D84ED19` |
| plugin_scanner.exe | `ACA1902DBE65A20FDB9ED3778BE7FCD5151E293A89E40DB3EB812BC7306EDA64` |

試験後はアプリとサイドカーを終了し、試験パッケージ・インストール先・パッケージ用データ・試験専用WebView2データ・MSIXファイル・展開レイアウトを削除した。
音声・ウィンドウ等の設定5ファイルと既存WebView2の2,622ファイル、OBSの589ファイルを退避時の内容へ復元し、全ファイルのSHA-256一致を確認した。
マイク全体とデスクトップアプリの許可は開始前と同じ `Allow`。試験アプリの権限エントリは、開始前と同じ「存在しない」状態へ戻した。
ユーザー側の署名証明書・秘密鍵と公開証明書ファイルを削除し、LocalMachineの試験用公開証明書1枚も利用者が管理者権限で削除した。
削除後、CurrentUser／LocalMachineのMy・TrustedPeople・Rootの6ストアすべてで試験証明書の残存がないこと、試験プロセス・検証用待受ポート・試験パッケージの残存がないことを再確認した。

### 2026-10-21のP2修正とテーマ別確認

音声設定のエラー本文だけを `text-destructive` から `text-foreground` に変更した。
背景・共通のdestructive色・他のボタン・音声処理には変更を加えていない。
修正前後の生成CSS全体のSHA-256も一致する。

生成CSSの同じクラスを使った900×600のChrome検証用ページでは、14px・通常ウェイトの本文について次の結果となった。
OSやアプリの状態を模した試験ではなく、実MSIXの測定とは区別する。

| テーマ | 文字RGB | 合成背景RGB | コントラスト |
| --- | --- | --- | --- |
| ライト | 2, 8, 23 | 253, 236, 236 | 17.52:1 |
| ダーク | 248, 250, 252 | 14, 10, 23 | 18.68:1 |
| ゲーミング | 250, 250, 250 | 27, 7, 8 | 18.62:1 |

[WCAG 2.2の通常文字の目安4.5:1](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)を3テーマとも上回る。
音声設定・ウィザード・更新案内の関連UIテスト77件が成功した。

## ローカルで作成する

Windows x64、Node/Rustの既存ビルド環境、Windows SDKのMakeAppx.exeが必要。
パッケージ作成はWindows PowerShell 5.1とPowerShell 7に対応する。
両方のシェルで自動テストを実行する場合は、PowerShell 7（`pwsh`）も必要。
実行中のAuralynを終了し、設定と既存のビルド成果物を退避してから行う。

```powershell
npm run tauri -- build --no-bundle --ci

# 新しい試験フォルダーを指定する。既存フォルダーは再利用しない。
$trial = Join-Path $env:TEMP ('auralyn-msix-' + [guid]::NewGuid())
$runtime = Join-Path $trial 'runtime'
New-Item -ItemType Directory -Path $runtime | Out-Null
Copy-Item src-tauri/target/release/AuralynHost.exe "$runtime/AuralynHost.exe"
Copy-Item src-tauri/bin/audio_engine-x86_64-pc-windows-msvc.exe "$runtime/audio_engine.exe"
Copy-Item src-tauri/bin/plugin_scanner-x86_64-pc-windows-msvc.exe "$runtime/plugin_scanner.exe"

powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ./scripts/package-msix-prototype.ps1 -RuntimeDirectory $runtime -OutputDirectory "$trial/package"
```

例の `RemoteSigned` は起動する子プロセスだけに適用し、ユーザー・マシンの恒久設定は変更しない。
組織のグループポリシーがある場合はその制限に従う。
詳細はMicrosoftの[実行ポリシー](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1)を参照する。

サイドカーは `beforeBuildCommand` が準備した `src-tauri/bin` から取得する。
後続の別featureのCargoビルドで `target/release` が更新されることがあるため、そのフォルダー名だけで構成を判断しない。
スクリプトは3本のx64 PEを検査し、既存出力を拒否する。
MakeAppxの検証を有効にして梱包し、配置元のSHA-256を `package-manifest.json` に記録する。
PE検査だけではrelease構成や対応ソースの一致を証明できないため、ビルドログ・実際の配布用サイドカー・インストール先のハッシュを別途照合する。

スクリプトは署名・証明書登録・インストールを行わない。
試験用のコード署名証明書はManifestのPublisherと同じSubjectで用意し、SignToolでMSIX自体をSHA-256署名する。
Tauri updaterの `.sig` はこのWindows署名の代わりにはならない。
ローカル自己署名証明書の信頼登録には管理者操作が必要な場合がある。
秘密鍵をパッケージ、Git、ログへ含めない。

```powershell
npm run test:release
npm run release:check
git diff --check
```

## 互換性試験と復旧

1. `%APPDATA%/com.kuro7983.auralynhost`、WebView2のユーザーデータ、OBS・Voicemeeter設定を退避する。
   試験Identityが別でも既存AppDataとWebView2設定を共有する場合がある。
2. 信頼した試験用証明書で署名し、`Add-AppxPackage` でインストールする。
   初回のマイク権限はWindowsの設定から確認する。レジストリで権限を迂回しない。
3. 起動した本体・エンジン・スキャナーの実行パスと `GetPackageFullName` を確認する。
   展開フォルダーのEXEを通常起動するだけではMSIXとしての検証にならない。
4. 外部VSTのスキャン、読み込み、状態取得・再設定、エディタ起動、プリセット保存・再起動後の読込を確認する。
   WASAPIとASIOは別々に確認し、録音内容と実ストリーム状態を調べる。
5. 実OBSへ接続し、状態取得・変更予定の取得・切断を確認する。OBSの設定変更や配信開始は不要。
6. 試験で追加したプリセット・設定を削除し、試験プロセスを終了する。
   試験パッケージと作成した証明書だけを削除し、退避した設定・既存成果物を復元する。
   管理者が登録した証明書は、同じストアの該当Thumbprintだけを削除する。

## 正式配布までに残る確認

- Partner Centerで予約した正式Identity / PublisherとStore署名・審査。`runFullTrust` と外部ドライバー依存の説明。
- OSの権限要求ダイアログは未実装。今回の権限切替はWindows設定で利用者が実施した。実マイクとクリーン環境での確認は別途必要。
- 実際のStore更新・再起動・設定保持。MSIX版で通常版updaterが無効であることは実機確認済みだが、ローカル試作の更新案内だけではStore更新を検証できない。
- 通常版からの設定移行、並行起動の扱い、アンインストール時の設定保持方針。
- WindowsAppsのバージョン付きパスと既存レジストリRun方式の自動起動との整合。
- クリーン環境のWebView2・ネイティブランタイム、実マイク、異なるVST/ASIOドライバー、VST GUI・DPI・長時間音声。
- 対応ソースの同時提供と有料配布を含むライセンス条件の確認。

Microsoftの正本:
[packaged desktop appの動作](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)、
[MSIX署名](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide)、
[capability宣言](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)。

## 2026-10-20のローカル検証

実装の基準は `c6f2fbf3940e2d8946041301345730e7ba93ced9`。
Windows 11 x64、Windows SDK 10.0.26100.0、通常のTauri releaseビルドを使用した。
試験用MSIXの版 `1.1.0.1` はパッケージ更新・設定保持を調べるための番号で、製品の版 `1.1.0` は変更していない。

| 対象 | 確認結果 |
| --- | --- |
| 梱包・署名・インストール | MakeAppxの検証付き作成、自己署名、Add-AppxPackage、Windows署名検証が成功。最終パッケージは7,775,242 bytes |
| 本体・音声エンジン | WindowsApps内から起動し、`GetPackageFullName` が試験MSIXのIdentityと一致。インストール先の3本すべてのSHA-256が配置元と一致 |
| 登録アプリの起動 | `shell:AppsFolder` のAUMIDで起動し、本体・音声エンジンが同じMSIXのIdentityで動くことを確認 |
| スキャナー | 最終パッケージ内のscannerを起動して外部VSTを8件検出。短時間の子プロセスも同じパッケージIDで動くことを観測 |
| VST3 | TDR Novaの追加、バイパスON/OFF、状態取得・再設定、エディタ起動要求、削除が成功。状態の再取得が4,780文字の保存状態と完全一致 |
| 既存VST | Ozone 12 Equalizer / Insight 2の既存セッションを読み込み、ASIO稼働中に2件のプラグインを確認 |
| 設定・プリセット | localStorageの試験値とVST状態入りプリセットが、MSIX更新とアプリ再起動後も保持された |
| 保存先 | この環境では既存版と同じRoaming AppDataにプリセットを書き込み、既存WebView2の設定を読み込んだ。別の試験Identityでも設定は独立しなかった |
| OBS | OBS 32.2.2 / obs-websocket 5.7.4へ接続、変更予定を取得、切断を確認。設定適用・配信開始は行っていない |
| ASIO | Voicemeeter Insert Virtual ASIO、96kHz / 512 framesで実ストリームのrunningを確認。Voicemeeter経由の997Hz合成音を約7.19秒収録し、処理前・処理後とも非ゼロの信号を確認。試験時のVSTは4インスタンスで、聴感・連続運転・性能比較の合格を意味しない |
| WASAPI | Windowsのマイク権限を許可後、CABLE Output → TDR Nova 1件 → SteamStreamingスピーカー、48kHz / 512 framesで実ストリームのrunningを確認。997Hz合成音を7.1秒収録し、処理前・処理後ともRMS約0.02597、ピーク約0.04073の信号を確認。Novaは初期状態で、処理前後の時刻・位相合わせや聴感比較は未実施 |
| 最小画面 | WebViewの内寸・外寸900×600、devicePixelRatio=1。主画面の描画、音声設定画面の表示・閉じる操作を確認 |

WASAPIは初回、試験用パッケージのマイク権限が `Deny` となり、仮想ケーブルの入力初期化で `0x80070005` が返った。
利用者がWindows設定で `Allow` に変更した後の再試験では、アクセス拒否は発生せず録音・WAV出力が成功した。
通常のデスクトップアプリ向け録音権限とは別に、MSIX版の許可状態と利用者への案内が必要。
レジストリを変更して権限を迂回する試験は行っていない。
ASIO収録の初回エクスポートは停止要求の直後に失敗したが、停止反映後の再出力と200ms待機を設けた再試験は成功した。
このタイミング依存がMSIX固有かは未確認。
WASAPIの再試験でも停止反映を待ってから出力し、初回の出力で成功した。

最終パッケージに含めた実行ファイル:

| ファイル | SHA-256 |
| --- | --- |
| AuralynHost.exe | `551B25FF0605DC9C1D9B2B17EB83496B0F2C9A33B49BD6E89AE935E8C5E87BAD` |
| audio_engine.exe | `28B42791586CE78B0EFE108CF15661905DF492B2BB62ABBB89189292D3D5B1D8` |
| plugin_scanner.exe | `5810A4C3D246D042D622F2C1DF7AC2274D865B7CCCE0A7BABC93BE36DF40618C` |

MSIX作成の異常系を含む配布テスト38件とrelease整合チェックが成功した。
この結果は、Store審査、クリーン環境、実マイク、VSTエディタ内の描画・操作、長時間音声、Store更新の検証結果ではない。

試験後はアプリ・OBSを終了し、音声設定・ウィンドウ設定・ブラックリストとWebView2の2,622ファイルを退避時の内容へ復元した。
SHA-256の照合で差異がないことを確認した。Voicemeeterの設定ファイルにも変更はない。
試験プリセット・試験パッケージ・マイク権限の試験エントリ・ユーザー側の署名証明書と秘密鍵・TEMPの公開証明書を削除した。
LocalMachine/TrustedPeopleに登録した試験用公開証明書1枚も、利用者が管理者権限で削除した。
削除後に各証明書ストア・試験パッケージ・マイク権限の試験エントリを再確認し、いずれも残っていないことを確認した。

## 2026-10-21のPowerShell 5.1対応と再検証

PR前レビューで、BOMなしUTF-8のPS1がWindows PowerShell 5.1では日本語を誤読し、パッケージ作成前に構文エラーとなる問題を確認した。
PS1をUTF-8 BOM付きに変更し、Manifestの読み込みにもUTF-8を明示した。
このPS1を編集するときはBOMを維持する。

Windows PowerShell 5.1とPowerShell 7の両方で、構文解析・既存出力先保護・サイドカー欠損・x86混入・不正PEオフセット・不正バージョンを自動検証する。
日本語エラーをUTF-8で取得し、想定したエラー本文を照合するため、構文エラーや実行ポリシーによる拒否を正常な異常系検出と取り違えない。
検証用の子プロセスだけに `RemoteSigned` を指定し、ユーザー・マシンの実行ポリシーは変更しない。

- 配布関連テスト45件、release整合チェックが成功。
- 両シェルで、保存済みの通常release成果物から未署名MSIXを作成・展開できた。各パッケージは7,772,183 bytes。
- 展開後の3 EXEが配置元・ハッシュ記録と一致し、想定した11ファイルだけを含むことを確認。Manifestの日本語コメントも正しく保持された。

この再検証では製品バイナリを再ビルドせず、署名・証明書登録・インストール・実アプリ起動は行っていない。
VST・OBS・録音・900×600の実機確認は上記2026-10-20の記録であり、今回の再実行とは区別する。

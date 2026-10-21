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

この試作はDSP・通常のNSIS配布・updaterを変更しない。
MSIX版で既存のNSIS updaterを利用することは未検証であり、正式対応では更新経路を分ける必要がある。

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
- マイク拒否時の案内、権限要求と設定画面への導線。
- MSIX版のNSIS updater無効化、Store更新と再起動の設計。
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
